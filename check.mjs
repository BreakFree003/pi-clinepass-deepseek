#!/usr/bin/env node
/**
 * Optional post-install smoke check for pi-clinepass-deepseek.
 *
 * Usage: node check.mjs
 *
 * Read-only. Verifies that the package is referenced by pi's settings, that
 * the model is visible to `pi --list-models`, that no stale alias override
 * lingers in models.json, and that the observer markers are present in the
 * installed source. Exits non-zero on failure.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

// 3. No stale override for the retired alias (dsh-clinepass 0.14.0), and the
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
check("footer uses the dsh wording", source.includes('"Provider: --"') && source.includes("Provider: ${label}"));
check("session start restores the saved verdict", source.includes("session_start") && source.includes("savedVerdict"));
check("usage renders % left and reset countdown", source.includes("% left") && source.includes("resets in"));
check("thinking levels are high/max only", source.includes("HIGH_MAX") && !source.includes("MAX_HIGH_LOW"));

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

console.log(failed === 0 ? `\nRESULT: PI CLINEPASS OK${skipped ? ` (${skipped} skipped)` : ""}` : `\nRESULT: FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
