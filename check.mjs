#!/usr/bin/env node
/**
 * Optional post-install smoke check for pi-clinepass-deepseek.
 *
 * Usage: node check.mjs
 *
 * Read-only with respect to your config. Verifies that the package is
 * referenced by pi's settings, that the model is visible to `pi --list-models`,
 * that no stale alias override lingers in models.json, that the observer and
 * pricing markers are present in the installed source, and that the list-price
 * maths and the footer text behave (the source's exported helpers are imported
 * under a throwaway HOME, so nothing is written to ~/.pi/agent). Exits non-zero
 * on failure.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const AGENT = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi/agent");
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const PI = process.env.PI_BIN ?? "pi";
const MODEL = "cline-pass/deepseek-v4.1-flash-1017";
const RETIRED = "cline-pass/deepseek-v4.1-flash";

let failed = 0;
let skipped = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed += 1;
}
function note(name, detail = "") {
  skipped += 1;
  console.log(`  skip ${name}${detail ? ` — ${detail}` : ""}`);
}
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

// 1. pi settings reference this package (git, npm or a local path all work).
const settings = readJson(join(AGENT, "settings.json"));
check("settings.json is readable", settings !== undefined, join(AGENT, "settings.json"));
const packages = (settings?.packages ?? []).map(String);
const installed = packages.find((entry) =>
  entry.includes("pi-clinepass-deepseek") ||
  entry.includes("pi-clinepass-dsh") || // old name; GitHub redirects, keep working
  entry === PLUGIN_DIR,
);
check("settings.json references pi-clinepass-deepseek", installed !== undefined, installed);
check("extension source is present", existsSync(join(PLUGIN_DIR, "src/index.ts")), PLUGIN_DIR);

// 2. pi actually lists the model — only meaningful once a credential exists,
//    because pi hides providers without one.
const auth = readJson(join(AGENT, "auth.json"));
const credential = auth?.clinepass;
const hasCredential = Boolean(
  process.env.CLINE_PASS_API_KEY?.trim() ||
  (typeof credential === "object" && credential !== null && (credential.access || credential.key)),
);
if (!hasCredential) {
  note("model listing (no clinepass credential yet — run /login, then rerun)");
} else {
  let listed = "";
  try {
    listed = execFileSync(PI, ["--list-models"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    check(`${PI} --list-models runs`, true);
  } catch (error) {
    check(`${PI} --list-models runs`, false, String(error.message).slice(0, 120));
  }
  const row = listed.split("\n").find((line) => line.includes(MODEL));
  check(`pi lists ${MODEL.split("/").pop()}`, row !== undefined, row?.trim());
  if (row) {
    check(`  …with 921.6K context`, /921\.6K/.test(row), row.trim());
    check(`  …with a known max-out`, /(131(?:\.\d+)?K|384K)/.test(row), row.trim());
  }
}

// 3. No stale override for the retired alias (dsh-clinepass 0.15.0), and the
//    kept snapshot id should not carry a pin the gateway ignores anyway.
const models = readJson(join(AGENT, "models.json"));
const overrides = models?.providers?.clinepass?.modelOverrides;
if (overrides === undefined) {
  note("models.json clinepass overrides (none configured)");
} else {
  check("no stale alias model override", overrides[RETIRED] === undefined, overrides[RETIRED] ? JSON.stringify(Object.keys(overrides[RETIRED])) : "");
  const pin = overrides[MODEL]?.samplingParams?.providerOptions?.gateway?.only;
  if (pin === undefined) check("kept model has no sampling pin", true);
  else note("kept model carries a sampling pin (the gateway ignores it)", JSON.stringify(pin));
}

// 4. Marker checks against the installed source (no version pin — the manifest
//    is the only version source, so this survives every release).
const source = existsSync(join(PLUGIN_DIR, "src/index.ts")) ? readFileSync(join(PLUGIN_DIR, "src/index.ts"), "utf8") : "";
check("observer recognizes the anonymous channel", source.includes("ANONYMIZED_CHANNEL") && source.includes("openai-compatible-private"));
check("anonymous channel warns once", source.includes("⚠") && source.includes("warnedAnonymized"));
check("footer uses the dsh wording", source.includes("Provider: ${label}") && source.includes('statusText("--")'));
check("footer appends the running official price", source.includes("statusText") && source.includes("costSuffix") && source.includes("formatCny"));
check("price table matches dsh-clinepass cost.js", source.includes("cacheRead: 0.04") && source.includes("cacheMiss: 2") && source.includes("output: 8") && source.includes("offPeakFactor: 0.5"));
check("peak windows are Beijing 09-12 / 14-18", source.includes("9 * 60, 12 * 60") && source.includes("14 * 60, 18 * 60") && source.includes("TZ_OFFSET_MS"));
check("only the flash snapshot is priced", source.includes("isPricedModel") && source.includes("deepseek-v4\\.1-flash"));
check("session start restores the saved verdict", source.includes("session_start") && source.includes("savedVerdict"));
check("usage renders % left and reset countdown", source.includes("% left") && source.includes("resets in"));
check("thinking levels are high/max only", source.includes("HIGH_MAX") && !source.includes("MAX_HIGH_LOW"));
check("gateway pin carries `has` (the VMC switch)", source.includes("GATEWAY_HAS") && source.includes("withGatewayRouting") && source.includes("providerOptions"));
check("status records the virtual and upstream models", source.includes("virtualModel") && source.includes("upstreamModel") && source.includes("canonicalSlug"));
check("no degraded-pool judgement (dsh-clinepass 0.17.1)", !source.includes("degraded") && !source.includes("DEGRADED"));

const manifest = readJson(join(PLUGIN_DIR, "package.json"));
check("package version is semver", typeof manifest?.version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version), manifest?.version);

// 5. The status file, if this pi install has produced one already.
const status = readJson(join(AGENT, "clinepass-status.json"));
if (status === undefined) note("status file (no request observed yet)");
else {
  check("status file hook is installed", status.hook === "installed", String(status.hook));
  check("status file has counters", typeof status.counters?.seen === "number", JSON.stringify(status.counters));
  check("status file has no credential", !JSON.stringify(status).includes("apiKey") && !JSON.stringify(status).includes("Bearer"));
}

// 6. List-price maths + footer text, against the extension's own helpers.
//    Node ≥ 22.18 strips TypeScript on import; a throwaway HOME keeps the
//    status-file write of the faked hooks out of the real ~/.pi/agent.
const BEIJING_OFFSET = 8 * 60 * 60 * 1000;
/** Beijing wall clock (month 1-12) → epoch ms, so fixtures read like the spec. */
const bj = (y, m, d, h, min = 0) => Date.UTC(y, m - 1, d, h, min) - BEIJING_OFFSET;
const near = (value, expected) => typeof value === "number" && Math.abs(value - expected) < 1e-9;

let ext;
const sandbox = mkdtempSync(join(tmpdir(), "pi-clinepass-check-"));
const realHome = process.env.HOME;
try {
  process.env.HOME = sandbox;
  ext = await import(pathToFileURL(join(PLUGIN_DIR, "src/index.ts")).href);
} catch (error) {
  note("list-price maths (this Node cannot import TypeScript — needs Node ≥ 22.18)", String(error?.message ?? error).split("\n")[0].slice(0, 120));
} finally {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(sandbox, { recursive: true, force: true });
}

if (ext) {
  const peakAt = bj(2026, 11, 2, 10, 0); // Monday 10:00 Beijing
  const offPeakAt = bj(2026, 11, 7, 10, 0); // Saturday 10:00 Beijing
  const millionEach = { input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, output: 1_000_000 };

  // 6a. The formula, at fixed instants — no real clock involved.
  check("peak formula: cacheRead .04 + miss 2 + output 8 per M", near(ext.costOfUsage(millionEach, peakAt), 12.04), String(ext.costOfUsage(millionEach, peakAt)));
  check("off-peak is exactly half", near(ext.costOfUsage(millionEach, offPeakAt), 6.02), String(ext.costOfUsage(millionEach, offPeakAt)));
  check("cache writes are billed as misses", near(ext.costOfUsage({ cacheWrite: 1_000_000 }, peakAt), 2), String(ext.costOfUsage({ cacheWrite: 1_000_000 }, peakAt)));
  check("peak output is ¥8/M", near(ext.costOfUsage({ output: 1_000_000 }, peakAt), 8), String(ext.costOfUsage({ output: 1_000_000 }, peakAt)));

  // 6b. Peak/off-peak boundaries, all read in Beijing time (UTC+8).
  check("09:00 Mon is peak", ext.isPeak(bj(2026, 11, 2, 9, 0)) === true);
  check("12:00 Mon is off-peak", ext.isPeak(bj(2026, 11, 2, 12, 0)) === false);
  check("17:59 Fri is peak", ext.isPeak(bj(2026, 11, 6, 17, 59)) === true);
  check("18:00 Fri is off-peak", ext.isPeak(bj(2026, 11, 6, 18, 0)) === false);
  check("10:00 Sat is off-peak", ext.isPeak(bj(2026, 11, 7, 10, 0)) === false);

  // 6c. Only the flash snapshot has a price list here.
  check("flash snapshot is priced", ext.isPricedModel("cline-pass/deepseek-v4.1-flash-1017") === true);
  check("v4-pro is skipped, not under-priced", ext.isPricedModel("cline-pass/deepseek-v4-pro") === false);
  check("an absent model is not priced", ext.isPricedModel(undefined) === false);

  // 6d. Missing usage must not throw and must not move the total.
  ext.resetSpend();
  let usageError = null;
  try {
    ext.addUsage(undefined, peakAt);
    ext.addUsage({}, peakAt);
  } catch (error) {
    usageError = error;
  }
  check("missing usage does not throw", usageError === null, usageError ? String(usageError.message) : "");
  check("missing usage leaves the total at zero", ext.currentSpend().total === 0 && ext.costSuffix() === "", JSON.stringify(ext.currentSpend()));

  // 6e. Footer text: no suffix at zero, `¥x.xx` above it.
  check("zero shows no amount", ext.statusText("deepseek") === "Provider: deepseek", ext.statusText("deepseek"));
  ext.addUsage({ input: 2_545_000 }, peakAt); // ¥2.00/M × 2.545M = ¥5.09
  const afterPeak = ext.currentSpend();
  check("footer appends the total", ext.statusText("deepseek") === "Provider: deepseek · ¥5.09", ext.statusText("deepseek"));
  check("`Provider: --` keeps the total", ext.statusText("--") === "Provider: -- · ¥5.09", ext.statusText("--"));
  check("peak/off-peak buckets are kept", near(afterPeak.peak, 5.09) && afterPeak.offPeak === 0 && afterPeak.requests === 1, JSON.stringify(afterPeak));
  ext.addUsage({ output: 1_000_000 }, offPeakAt); // +¥4.00 at half price
  check("off-peak turns add at half price", ext.statusText("deepseek") === "Provider: deepseek · ¥9.09", ext.statusText("deepseek"));

  // 6f. `¥` formatting, same magnitudes as the dsh pill.
  check("¥0.00 at zero", ext.formatCny(0) === "¥0.00", ext.formatCny(0));
  check("two decimals at ≥ ¥1", ext.formatCny(5.09) === "¥5.09" && ext.formatCny(12.04) === "¥12.04", `${ext.formatCny(5.09)} ${ext.formatCny(12.04)}`);
  check("three decimals below ¥1", ext.formatCny(0.156) === "¥0.156", ext.formatCny(0.156));
  check("four decimals below ¥0.01", ext.formatCny(0.0012) === "¥0.0012", ext.formatCny(0.0012));

  // 6g. Wiring: drive the real hooks with a fake pi and read the footer.
  ext.resetSpend();
  const handlers = new Map();
  const statuses = [];
  const ui = {
    setStatus(key, text) {
      statuses.push({ key, text });
    },
    notify() {},
  };
  ext.default({
    registerProvider() {},
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand() {},
  });
  const fire = (event, payload, ctx) => {
    for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
    return statuses[statuses.length - 1]?.text;
  };
  const flash = "cline-pass/deepseek-v4.1-flash-1017";
  const pro = "cline-pass/deepseek-v4-pro";
  const uiCtx = { hasUI: true, ui, model: { id: flash } };

  fire("session_start", {}, uiCtx);
  check("fresh session shows no amount", statuses[statuses.length - 1]?.text === "Provider: --", statuses[statuses.length - 1]?.text);

  fire("before_provider_request", { payload: { model: flash } }, uiCtx);
  check("request start stays on `Provider: --`", statuses[statuses.length - 1]?.text === "Provider: --", statuses[statuses.length - 1]?.text);

  fire("message_end", { message: { provider: "clinepass", model: flash, usage: { input: 2_545_000 } } }, uiCtx);
  const priced = ext.currentSpend();
  check("message_end prices the turn", priced.requests === 1 && priced.total > 0, JSON.stringify(priced));
  check("the footer is re-rendered with the amount", String(statuses[statuses.length - 1]?.text).startsWith("Provider: -- · ¥"), statuses[statuses.length - 1]?.text);

  fire("before_provider_request", { payload: { model: flash } }, uiCtx);
  check("the next request keeps the amount", String(statuses[statuses.length - 1]?.text) === `Provider: -- · ${ext.formatCny(priced.total)}`, statuses[statuses.length - 1]?.text);

  const beforePro = priced.total;
  fire("before_provider_request", { payload: { model: pro } }, uiCtx);
  fire("message_end", { message: { provider: "clinepass", model: pro, usage: { output: 5_000_000 } } }, uiCtx);
  check("v4-pro is not billed at flash rates", ext.currentSpend().total === beforePro, JSON.stringify(ext.currentSpend()));

  fire("before_provider_request", { payload: { model: flash } }, uiCtx);
  let endError = null;
  try {
    fire("message_end", { message: { provider: "clinepass", model: flash } }, uiCtx);
  } catch (error) {
    endError = error;
  }
  check("usage-less message_end does not throw", endError === null, endError ? String(endError.message) : "");
  check("usage-less message_end keeps the total", ext.currentSpend().total === beforePro, JSON.stringify(ext.currentSpend()));

  fire("provider_stream_event", { provider: "clinepass", data: { provider: "deepseek" } }, uiCtx);
  check(
    "the streamed provider label keeps the amount",
    String(statuses[statuses.length - 1]?.text) === `Provider: deepseek · ${ext.formatCny(ext.currentSpend().total)}`,
    statuses[statuses.length - 1]?.text,
  );
}

console.log(failed === 0 ? `\nRESULT: PI CLINEPASS OK${skipped ? ` (${skipped} skipped)` : ""}` : `\nRESULT: FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
