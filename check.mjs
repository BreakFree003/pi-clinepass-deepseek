#!/usr/bin/env node
/**
 * 核对 pi 侧的 Cline Pass 配置：新插件是否装上、模型是否钉对、默认模型是否正确。
 *
 * 跑法：node ~/Documents/Projects/pi-clinepass-dsh/check.mjs
 *
 * 只读。旧 pi-clinepass 已卸载，模型现在由本地插件
 * ~/Documents/Projects/pi-clinepass-dsh 提供。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AGENT = join(homedir(), ".pi/agent");
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const ID = "cline-pass/deepseek-v4.1-flash-1017";
const ALIAS = "cline-pass/deepseek-v4.1-flash";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed += 1;
}

// 1. 旧包已卸载、新插件在位
const settings = JSON.parse(readFileSync(join(AGENT, "settings.json"), "utf8"));
const packages = (settings.packages ?? []).map(String);
check("settings.json 不再含 npm:pi-clinepass", !packages.some((p) => p.includes("pi-clinepass") && p.startsWith("npm:")));
check("settings.json 已挂本地插件", packages.some((p) => p.includes("pi-clinepass-dsh")), packages.find((p) => p.includes("pi-clinepass-dsh")));
check("插件目录存在", existsSync(join(PLUGIN_DIR, "src/index.ts")), PLUGIN_DIR);

// 2. models.json
const models = JSON.parse(readFileSync(join(AGENT, "models.json"), "utf8"));
const overrides = models?.providers?.clinepass?.modelOverrides ?? {};
const entry = overrides[ID];
const only = entry?.samplingParams?.providerOptions?.gateway?.only;
check("models.json: 1017 钉了 deepseek", JSON.stringify(only) === JSON.stringify(["deepseek"]), JSON.stringify(only));
check("models.json: 1017 maxTokens = 384000", entry?.maxTokens === 384000, String(entry?.maxTokens));
check("models.json: 别名没有无效 pin", overrides[ALIAS]?.samplingParams === undefined);
check("models.json: 两模型都开 mid-convo system",
  overrides[ALIAS]?.compat?.supportsMidConvoSystemMessages === true &&
  entry?.compat?.supportsMidConvoSystemMessages === true);

// 3. settings.json 默认模型
check("settings.json: 默认模型是 1017", settings.defaultModel === ID, settings.defaultModel);
check("settings.json: 1017 默认思考档 high",
  settings.modelThinkingLevels?.[`clinepass/${ID}`] === "high",
  settings.modelThinkingLevels?.[`clinepass/${ID}`]);

// 4. pi 实际列出的模型
let listed = "";
try {
  listed = execFileSync("pi", ["--list-models"], { encoding: "utf8" });
} catch (error) {
  check("pi --list-models 可运行", false, String(error.message).slice(0, 80));
}
for (const id of [ALIAS, ID]) {
  const row = listed.split("\n").find((line) => line.includes(id));
  check(`pi --list-models 列出 ${id.split("/").pop()}`, row !== undefined, row?.trim());
  check("…且 max-out 是 384K", /384K/.test(row ?? ""), row?.trim());
}

// 5. footer 告警与匿名渠道处理（与 dsh 胶囊的 warn 图标/tooltip 对齐）
const src = readFileSync(join(PLUGIN_DIR, "src/index.ts"), "utf8");
check("插件识别匿名渠道", src.includes("ANONYMIZED_CHANNEL") && src.includes("openai-compatible-private"));
check("匿名渠道有 ⚠ 与一次性告警", src.includes("⚠") && src.includes("warnedAnonymized"));
check("状态文件记录 anonymized 计数", src.includes("anonymized: 0") && src.includes("counters.anonymized"));
check("footer 用 dsh 胶囊的文案", src.includes('"Provider: --"') && src.includes("Provider: ${label}"));
check("启动时显示上次结论", src.includes("session_start") && src.includes("savedVerdict"));
check("用量显示剩余百分比与重置倒计时", src.includes("remaining usage") && src.includes("% left") && src.includes("resets in"));
check("思考档与 dsh 一致（仅 high/max）", src.includes("HIGH_MAX") && !src.includes("MAX_HIGH_LOW"));
const map = overrides[ID]?.thinkingLevelMap ?? {};
check("models.json 思考档 low 已隐藏", map.low === null && map.high === "high" && map.max === "max", JSON.stringify(map));
const pkgVersion = JSON.parse(readFileSync(join(PLUGIN_DIR, "package.json"), "utf8")).version;
check("插件版本已递增（0.1.5）", pkgVersion === "0.1.5", pkgVersion);

console.log(failed === 0 ? "\nRESULT: PI CLINEPASS OK" : `\nRESULT: FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
