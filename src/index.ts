/**
 * pi-clinepass-dsh — Cline Pass for pi, same job as dsh-clinepass:
 *
 *   1. registers the `clinepass` OpenAI-compatible provider with the two
 *      DeepSeek V4.1 Flash routes (stable alias + dated 1017 snapshot);
 *   2. observes which upstream provider actually answered each request
 *      (`provider_stream_event` → gateway routing / OpenRouter `provider`
 *      field) and shows it in the footer; counters + last verdict go to
 *      `~/.pi/agent/clinepass-status.json`;
 *   3. `/clinepass` reports plan usage (5h / weekly / monthly) from Cline's
 *      billing API, using the token pi already stores for this provider.
 *
 * It never rewrites a request: request-side pinning stays in your own
 * config (`models.json` `samplingParams` for the 1017 snapshot).
 *
 * Auth: `/login` → Cline Pass accepts either the `CLINE_PASS_API_KEY`
 * environment variable or a pasted API key; both are stored by pi as the
 * provider credential. An existing Cline Pass login in `auth.json` is reused.
 */

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROVIDER = "clinepass";
const API_BASE = "https://api.cline.bot/api/v1";
const ORIGIN = "https://api.cline.bot";
const AGENT_DIR = join(homedir(), ".pi/agent");
const STATUS_FILE = join(AGENT_DIR, "clinepass-status.json");
const AUTH_FILE = join(AGENT_DIR, "auth.json");

const MAX_HIGH_LOW = {
  off: "none",
  minimal: null,
  low: "low",
  medium: null,
  high: "high",
  xhigh: null,
  max: "max",
} as const;

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const MODELS = [
  {
    id: "cline-pass/deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: zeroCost,
    contextWindow: 921_600,
    maxTokens: 131_072,
    thinkingLevelMap: MAX_HIGH_LOW,
    // Same compat flags the old pi-clinepass catalog applied to every model
    // (official DeepSeek behavior: no developer role, Anthropic-style cache
    // markers, no long-retention cache) plus the in-history flag from
    // dsh-clinepass 0.12.3 — carried by both models, the 1017 snapshot too.
    compat: {
      supportsDeveloperRole: false,
      cacheControlFormat: "anthropic" as const,
      supportsLongCacheRetention: false,
      supportsMidConvoSystemMessages: true,
    },
  },
  {
    id: "cline-pass/deepseek-v4.1-flash-1017",
    name: "DeepSeek V4.1 Flash 1017",
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: zeroCost,
    contextWindow: 921_600,
    maxTokens: 384_000,
    thinkingLevelMap: MAX_HIGH_LOW,
    // Same compat flags the old pi-clinepass catalog applied to every model
    // (official DeepSeek behavior: no developer role, Anthropic-style cache
    // markers, no long-retention cache) plus the in-history flag from
    // dsh-clinepass 0.12.3 — carried by both models, the 1017 snapshot too.
    compat: {
      supportsDeveloperRole: false,
      cacheControlFormat: "anthropic" as const,
      supportsLongCacheRetention: false,
      supportsMidConvoSystemMessages: true,
    },
  },
];

// ── state ───────────────────────────────────────────────────────────────────

const startedAt = new Date().toISOString();
const counters = { seen: 0, verified: 0, anonymized: 0, unknown: 0 };
let lastVerified: Record<string, unknown> | undefined;
let pendingModel: string | undefined;
let sawRouting = false;
let lastUpstream: string | undefined;
let warnedAnonymized = false;

/** The gateway hides the real channel under this label (contributor tier). */
const ANONYMIZED_CHANNEL = "openai-compatible-private";
let lastResponseModel: string | undefined;
let lastFingerprint: string | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function writeStatus(): void {
  const body = {
    version: 1,
    hook: "installed",
    transport: "provider_stream_event",
    provider: PROVIDER,
    pid: process.pid,
    startedAt,
    updatedAt: new Date().toISOString(),
    counters: { ...counters },
    lastVerified,
  };
  const tmp = `${STATUS_FILE}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
    renameSync(tmp, STATUS_FILE);
  } catch {
    // status is best-effort; never break the agent loop over it
  }
}

/** Read the provider token pi stores for us: oauth access token or api_key. */
function storedToken(): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(AUTH_FILE, "utf8")) as Record<string, unknown>;
    const entry = raw[PROVIDER];
    if (!isRecord(entry)) return undefined;
    return stringValue(entry.access) ?? stringValue(entry.key);
  } catch {
    return undefined;
  }
}

function activeToken(): string | undefined {
  return process.env.CLINE_PASS_API_KEY?.trim() || storedToken();
}

// ── observer ────────────────────────────────────────────────────────────────

/** Pull the upstream provider out of one streamed chunk. */
function readChunk(data: unknown): { provider?: string; model?: string; fingerprint?: string } {
  if (!isRecord(data)) return {};
  const out: { provider?: string; model?: string; fingerprint?: string } = {};
  const topProvider = stringValue(data.provider); // OpenRouter-protocol routes
  if (topProvider) out.provider = topProvider;
  const echo = stringValue(data.model);
  if (echo) out.model = echo;
  const choices = Array.isArray(data.choices) ? data.choices : [];
  for (const choice of choices) {
    if (!isRecord(choice)) continue;
    const delta = isRecord(choice.delta) ? choice.delta : choice;
    const meta = isRecord(delta.provider_metadata) ? delta.provider_metadata : undefined;
    if (!meta) continue;
    const gateway = isRecord(meta.gateway) ? meta.gateway : undefined;
    const routing = isRecord(gateway?.routing) ? gateway.routing : undefined;
    const final = stringValue(routing?.finalProvider);
    if (final) out.provider = final;
    const deepseek = isRecord(meta.deepseek) ? meta.deepseek : undefined;
    const fp = stringValue(deepseek?.systemFingerprint);
    if (fp) {
      out.fingerprint = fp;
      if (!out.provider) out.provider = "deepseek";
    }
  }
  return out;
}

export default function (pi: { registerProvider: (name: string, config: unknown) => void; on: (event: string, handler: (...args: unknown[]) => unknown) => void; registerCommand: (name: string, config: { description: string; handler: (args: string, ctx: any) => Promise<void> }) => void }) {
  pi.registerProvider(PROVIDER, {
    name: "Cline Pass",
    baseUrl: API_BASE,
    api: "openai-completions",
    authHeader: true,
    models: MODELS,
    oauth: {
      name: "Cline Pass",
      isSubscription: true,
      async login(callbacks: { onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string> }) {
        const fromEnv = process.env.CLINE_PASS_API_KEY?.trim();
        const key = fromEnv || (await callbacks.onPrompt({ message: "Cline Pass API key", placeholder: "paste key" })).trim();
        if (!key) throw new Error("Cline Pass API key is required");
        return { access: key, refresh: "", expires: Date.now() + 10 * 365 * 86_400_000 };
      },
      async refreshToken(credentials: { access: string; refresh: string; expires: number }) {
        if (credentials.expires > Date.now() + 60_000) return credentials;
        throw new Error("Cline Pass credential expired — run /login");
      },
      getApiKey(credentials: { access: string }) {
        return credentials.access;
      },
    },
  });

  pi.on("before_provider_request", (...args: unknown[]) => {
    const event = args[0] as { payload?: unknown };
    const payload = isRecord(event?.payload) ? event.payload : undefined;
    const model = stringValue(payload?.model);
    if (!model?.startsWith("cline-pass/")) return;
    pendingModel = model;
    sawRouting = false;
    lastResponseModel = undefined;
    lastFingerprint = undefined;
    return undefined;
  });

  pi.on("provider_stream_event", (...args: unknown[]) => {
    const event = args[0] as { provider?: string; model?: string; data?: unknown };
    const ctx = args[1] as { hasUI?: boolean; ui?: { setStatus?: (key: string, text: string | undefined) => void; notify?: (text: string, kind: string) => void } } | undefined;
    if (event?.provider !== PROVIDER) return;
    const seen = readChunk(event.data);
    if (seen.model) lastResponseModel = seen.model;
    if (seen.fingerprint) lastFingerprint = seen.fingerprint;
    if (seen.provider && !sawRouting) {
      sawRouting = true;
      lastUpstream = seen.provider;
      const anonymized = seen.provider === ANONYMIZED_CHANNEL;
      const label = seen.provider.length > 40 ? `${seen.provider.slice(0, 38)}…` : seen.provider;
      ctx?.ui?.setStatus?.("clinepass", `Cline Pass · ${anonymized ? "⚠ " : ""}${label}`);
      // Same warning the dsh pill carries in its tooltip: one alert per process,
      // because every subsequent reply would repeat it.
      if (anonymized && !warnedAnonymized) {
        warnedAnonymized = true;
        ctx?.ui?.notify?.(
          "cline-pass: the upstream channel is anonymized as openai-compatible-private (contributor tier: data may be used for training, no ZDR).",
          "error",
        );
      }
    }
    return undefined;
  });

  pi.on("message_end", (...args: unknown[]) => {
    const event = args[0] as { message?: { provider?: string; model?: string } };
    const ctx = args[1] as { hasUI?: boolean; ui?: { setStatus?: (key: string, text: string | undefined) => void } } | undefined;
    if (event?.message?.provider !== PROVIDER) return;
    counters.seen += 1;
    if (sawRouting && lastUpstream) {
      counters.verified += 1;
      const anonymized = lastUpstream === ANONYMIZED_CHANNEL;
      if (anonymized) counters.anonymized += 1;
      lastVerified = {
        at: new Date().toISOString(),
        provider: lastUpstream,
        model: pendingModel ?? event.message.model,
        responseModel: lastResponseModel,
        systemFingerprint: lastFingerprint,
        anonymized,
      };
    } else {
      counters.unknown += 1;
      if (ctx?.hasUI) ctx.ui?.setStatus?.("clinepass", "Cline Pass · ?");
    }
    writeStatus();
    return undefined;
  });

  pi.registerCommand("clinepass", {
    description: "Show Cline Pass plan usage and the last upstream provider",
    async handler(args: string, ctx: any) {
      const lines: string[] = [];
      if ((args || "").trim() === "status") {
        lines.push(`observer: ${counters.verified}/${counters.seen} verified, ${counters.anonymized} anonymized, ${counters.unknown} unknown`);
        lines.push(`last upstream: ${lastUpstream ?? "(none this process)"}`);
        if (lastVerified) lines.push(`last: ${JSON.stringify(lastVerified)}`);
        lines.push(`status file: ${STATUS_FILE}`);
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      const token = activeToken();
      if (!token) {
        ctx.ui.notify("Cline Pass: no credential. Run /login → Cline Pass, or set CLINE_PASS_API_KEY.", "error");
        return;
      }
      const get = async (path: string): Promise<Record<string, unknown> | undefined> => {
        try {
          const res = await fetch(`${ORIGIN}${path}`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) return undefined;
          const body = await res.json();
          return isRecord(body) ? body : undefined;
        } catch {
          return undefined;
        }
      };
      const [limitsJson, planJson] = await Promise.all([
        get("/api/v1/users/me/plan/usage-limits"),
        get("/api/v1/users/me/plan"),
      ]);
      if (!limitsJson) {
        ctx.ui.notify("Cline Pass: usage API unavailable (credential rejected or offline).", "error");
        return;
      }
      const limits = Array.isArray((limitsJson.data as any)?.limits) ? ((limitsJson.data as any).limits as unknown[]) : [];
      const byType = new Map<string, Record<string, unknown>>();
      for (const item of limits) if (isRecord(item) && typeof item.type === "string") byType.set(item.type, item);
      const plan = isRecord(planJson?.data) ? (planJson!.data as Record<string, unknown>) : planJson;
      const planDetails = isRecord(plan?.plan) ? (plan.plan as Record<string, unknown>) : undefined;
      const status = isRecord(plan?.plan) && plan.plan.isActive === false ? "inactive" : "active";
      const pct = (key: string): number => {
        const n = Number((byType.get(key) as any)?.percentUsed);
        return Number.isFinite(n) ? Math.round(n) : 0;
      };
      const bar = (p: number): string => {
        const filled = Math.max(0, Math.min(10, Math.round(p / 10)));
        return `[${"█".repeat(filled)}${"░".repeat(10 - filled)}]`;
      };
      lines.push(`Cline Pass — ${stringValue(planDetails?.displayName) ?? "plan"} (${status})`);
      for (const [label, key] of [["5h ", "five_hour"], ["7d ", "weekly"], ["30d", "monthly"]] as const) {
        const p = pct(key);
        lines.push(`${label} ${bar(p)} ${String(p).padStart(3)}%`);
      }
      if (plan?.currentPeriodEnd) lines.push(`period ends: ${String(plan.currentPeriodEnd)}`);
      lines.push(`last upstream: ${lastUpstream ?? "(none this process)"}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
