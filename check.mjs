#!/usr/bin/env node
/**
 * Optional post-install smoke check for pi-clinepass-dsh.
 *
 * Usage: node check.mjs
 *
 * Read-only. Verifies that the package is referenced by pi's settings, that
 * both models are visible to `pi --list-models`, that an optional 1017
 * models.json pin still targets DeepSeek, and that the observer markers are
 * present in the installed source. Exits non-zero on failure.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AGENT = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi/agent");
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const PI = process.env.PI_BIN ?? "pi";
const ID = "cline-pass/deepseek-v4.1-flash-1017";
const ALIAS = "cline-pass/deepseek-v4.1-flash";

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
const installed = packages.find((entry) => entry.includes("pi-clinepass-dsh") || entry === PLUGIN_DIR);
check("settings.json references pi-clinepass-dsh", installed !== undefined, installed);
check("extension source is present", existsSync(join(PLUGIN_DIR, "src/index.ts")), PLUGIN_DIR);

// 2. pi actually lists both models.
let listed = "";
try {
  listed = execFileSync(PI, ["--list-models"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  check(`${PI} --list-models runs`, true);
} catch (error) {
  check(`${PI} --list-models runs`, false, String(error.message).slice(0, 120));
}
for (const [id, maxOut] of [[ALIAS, /(131K|384K)/], [ID, /384K/]]) {
  const row = listed.split("\n").find((line) => line.includes(id));
  check(`pi lists ${id.split("/").pop()}`, row !== undefined, row?.trim());
  if (row) {
    check(`  …with 921.6K context`, /921\.6K/.test(row), row.trim());
    check(`  …with a known max-out`, maxOut.test(row), row.trim());
  }
}

// 3. Optional user config: a 1017 pin must still target deepseek, and the
//    stable alias should not carry a pin at all.
const models = readJson(join(AGENT, "models.json"));
const overrides = models?.providers?.clinepass?.modelOverrides;
if (overrides === undefined) {
  note("models.json clinepass overrides (none configured)");
} else {
  const only = overrides?.[ID]?.samplingParams?.providerOptions?.gateway?.only;
  if (only === undefined) note("1017 sampling pin (none configured)");
  else check("1017 sampling pin targets deepseek", Array.isArray(only) && only.length === 1 && only[0] === "deepseek", JSON.stringify(only));
  const aliasPin = overrides?.[ALIAS]?.samplingParams;
  if (aliasPin === undefined) check("stable alias has no sampling pin", true);
  else note("stable alias has a sampling pin (the gateway ignores it on that route)", JSON.stringify(aliasPin));
  const maxTokens = overrides?.[ID]?.maxTokens;
  if (maxTokens !== undefined) check("1017 maxTokens is a positive number", Number.isInteger(maxTokens) && maxTokens > 0, String(maxTokens));
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
