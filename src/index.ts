/**
 * pi-clinepass-dsh — Cline Pass for pi, same job as dsh-clinepass:
 *
 *   1. registers the `clinepass` OpenAI-compatible provider with the two
 *      DeepSeek V4.1 Flash routes (stable alias + dated 1017 snapshot);
 *   2. observes which upstream provider actually answered each request, using
 *      dsh's evidence priority (gateway routing → top-level `provider` →
 *      provider_metadata namespace → DeepSeek fingerprint), and shows it in
 *      the footer; counters + last verdict go to
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

/** dsh declares `reasoningEfforts: { high, max }` on both models — mirror that. */
const HIGH_MAX = {
  off: null,
  minimal: null,
  low: null,
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
    thinkingLevelMap: HIGH_MAX,
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
    thinkingLevelMap: HIGH_MAX,
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

/** Provider evidence collected for the in-flight request, in dsh's priority order. */
type RoutingEvidence = { direct?: string; attempts: string[] };
const routingEvidence: RoutingEvidence[] = [];
let topProvider: string | undefined;
const providerNamespaces: string[] = [];
let fingerprintProvider: string | undefined;
let currentUpstream: string | undefined;
let lastUpstream: string | undefined;
let warnedAnonymized = false;

/** The gateway hides the real channel under this label (contributor tier). */
const ANONYMIZED_CHANNEL = "openai-compatible-private";
let lastResponseModel: string | undefined;

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

/** Last verdict persisted by a previous run (for the footer before any request). */
function savedVerdict(): { provider: string; anonymized: boolean } | null {
  try {
    const body = JSON.parse(readFileSync(STATUS_FILE, "utf8")) as Record<string, unknown>;
    const last = isRecord(body.lastVerified) ? body.lastVerified : undefined;
    const provider = stringValue(last?.provider);
    if (!provider) return null;
    return { provider, anonymized: last?.anonymized === true };
  } catch {
    return null;
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

/** Compact "time until reset" — same shape as the dsh usage card's countdown. */
function relativeReset(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

/** Parse a `resetsAt` timestamp defensively; unreadable values render as no countdown. */
function resetRelative(value: unknown): string | null {
  const text = stringValue(value);
  if (!text) return null;
  const at = new Date(text).getTime();
  return Number.isFinite(at) ? relativeReset(at - Date.now()) : null;
}

// ── observer ────────────────────────────────────────────────────────────────

/** Lowercase + trim, the way dsh normalizes every provider clue. */
function cleanProvider(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim().toLowerCase();
  return text || undefined;
}

/** One routing object reduced to its verdict: direct fields or successful attempts. */
function summarizeRouting(value: unknown): RoutingEvidence | undefined {
  if (!isRecord(value)) return undefined;
  const affinity = isRecord(value.affinity) ? value.affinity : undefined;
  const direct =
    cleanProvider(value.finalProvider) ??
    cleanProvider(value.resolvedProvider) ??
    cleanProvider(affinity?.pinnedProvider);
  const attempts: string[] = [];
  const models = Array.isArray(value.modelAttempts) ? value.modelAttempts : [];
  for (const model of models) {
    if (!isRecord(model)) continue;
    const tries = Array.isArray(model.providerAttempts) ? model.providerAttempts : [];
    for (const attempt of tries) {
      if (!isRecord(attempt) || attempt.success !== true) continue;
      const name = cleanProvider(attempt.provider);
      if (name) attempts.push(name);
    }
  }
  if (!direct && attempts.length === 0) return undefined;
  return { direct, attempts };
}

/**
 * `provider_metadata.<x>` keys are dsh's last-resort clue. `gateway` is the
 * routing container itself and `openai-compat` names the protocol, not an
 * upstream, so both are skipped.
 */
function collectNamespaces(node: unknown, out: string[], seen: Set<string>): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const entry of node) collectNamespaces(entry, out, seen);
    return;
  }
  const record = node as Record<string, unknown>;
  if (isRecord(record.provider_metadata)) {
    for (const key of Object.keys(record.provider_metadata)) {
      if (key === "gateway" || key === "openai-compat" || key === "openai_compat" || seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
  }
  for (const value of Object.values(record)) collectNamespaces(value, out, seen);
}

type ChunkEvidence = {
  routing?: RoutingEvidence;
  topProvider?: string;
  namespaces: string[];
  model?: string;
  fingerprint?: string;
};

/** Pull the provider evidence out of one streamed chunk. */
function readChunk(data: unknown): ChunkEvidence {
  const result: ChunkEvidence = { namespaces: [] };
  if (!isRecord(data)) return result;
  const top = cleanProvider(data.provider); // OpenRouter-protocol routes
  if (top) result.topProvider = top;
  const echo = stringValue(data.model);
  if (echo) result.model = echo;
  const choices = Array.isArray(data.choices) ? data.choices : [];
  for (const choice of choices) {
    if (!isRecord(choice)) continue;
    const delta = isRecord(choice.delta) ? choice.delta : choice;
    const meta = isRecord(delta.provider_metadata) ? delta.provider_metadata : undefined;
    if (!meta) continue;
    const gateway = isRecord(meta.gateway) ? meta.gateway : undefined;
    const routing = isRecord(gateway?.routing) ? summarizeRouting(gateway.routing) : undefined;
    if (routing) result.routing = routing;
    const deepseek = isRecord(meta.deepseek) ? meta.deepseek : undefined;
    const fp = stringValue(deepseek?.systemFingerprint);
    if (fp) result.fingerprint = fp;
  }
  collectNamespaces(data, result.namespaces, new Set());
  return result;
}

/** Keep the latest routing verdicts; identical consecutive frames add nothing. */
function pushRouting(next: RoutingEvidence): void {
  const last = routingEvidence[routingEvidence.length - 1];
  if (last && last.direct === next.direct && last.attempts.join("\u0000") === next.attempts.join("\u0000")) return;
  routingEvidence.push(next);
  if (routingEvidence.length > 64) routingEvidence.shift();
}

function resetEvidence(): void {
  routingEvidence.length = 0;
  topProvider = undefined;
  providerNamespaces.length = 0;
  fingerprintProvider = undefined;
  currentUpstream = undefined;
  lastResponseModel = undefined;
}

/**
 * dsh's priority order: last routing verdict (finalProvider → resolvedProvider
 * → affinity.pinnedProvider → first successful providerAttempts), then the
 * first top-level wire `provider`, then a provider_metadata namespace. The
 * DeepSeek fingerprint is this extension's extra last-resort clue.
 */
function resolveUpstream(): string | undefined {
  for (let index = routingEvidence.length - 1; index >= 0; index -= 1) {
    const evidence = routingEvidence[index];
    if (evidence.direct) return evidence.direct;
    if (evidence.attempts.length > 0) return evidence.attempts[0];
  }
  return topProvider ?? providerNamespaces[0] ?? (fingerprintProvider ? "deepseek" : undefined);
}

function providerLabel(provider: string, anonymized = provider === ANONYMIZED_CHANNEL): string {
  const label = provider.length > 40 ? `${provider.slice(0, 38)}…` : provider;
  return `${anonymized ? "⚠ " : ""}Provider: ${label}`;
}

export default function (pi: { registerProvider: (name: string, config: unknown) => void; on: (event: string, handler: (...args: unknown[]) => unknown) => void; registerCommand: (name: string, config: { description: string; handler: (args: string, ctx: any) => Promise<void> }) => void }) {
  pi.registerProvider(PROVIDER, {
    name: "Cline Pass",
    baseUrl: API_BASE,
    // Env-only auth (CI / headless). A stored /login credential still wins.
    apiKey: "$CLINE_PASS_API_KEY",
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

  pi.on("session_start", (...args: unknown[]) => {
    const ctx = args[1] as { model?: { id?: string }; ui?: { setStatus?: (key: string, text: string | undefined) => void } } | undefined;
    if (typeof ctx?.model?.id !== "string" || !ctx.model.id.startsWith("cline-pass/")) return;
    const saved = savedVerdict();
    ctx.ui?.setStatus?.("clinepass", saved ? providerLabel(saved.provider, saved.anonymized) : "Provider: --");
  });

  pi.on("before_provider_request", (...args: unknown[]) => {
    const event = args[0] as { payload?: unknown };
    const payload = isRecord(event?.payload) ? event.payload : undefined;
    const model = stringValue(payload?.model);
    if (!model?.startsWith("cline-pass/")) return;
    const ctx = args[1] as { ui?: { setStatus?: (key: string, text: string | undefined) => void } } | undefined;
    ctx?.ui?.setStatus?.("clinepass", "Provider: --");
    pendingModel = model;
    resetEvidence();
    return undefined;
  });

  pi.on("provider_stream_event", (...args: unknown[]) => {
    const event = args[0] as { provider?: string; model?: string; data?: unknown };
    const ctx = args[1] as { hasUI?: boolean; ui?: { setStatus?: (key: string, text: string | undefined) => void; notify?: (text: string, kind: string) => void } } | undefined;
    if (event?.provider !== PROVIDER) return;
    const seen = readChunk(event.data);
    if (seen.model) lastResponseModel = seen.model;
    if (seen.fingerprint) fingerprintProvider = seen.fingerprint;
    if (seen.topProvider && !topProvider) topProvider = seen.topProvider;
    if (seen.routing) pushRouting(seen.routing);
    for (const namespace of seen.namespaces) {
      if (!providerNamespaces.includes(namespace)) providerNamespaces.push(namespace);
    }

    const resolved = resolveUpstream();
    if (resolved && resolved !== currentUpstream) {
      currentUpstream = resolved;
      ctx?.ui?.setStatus?.("clinepass", providerLabel(resolved));
      // Same warning the dsh pill carries in its tooltip: one alert per process,
      // because every subsequent reply would repeat it.
      if (resolved === ANONYMIZED_CHANNEL && !warnedAnonymized) {
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
    const resolved = currentUpstream ?? resolveUpstream();
    const model = pendingModel ?? event.message.model;
    pendingModel = undefined;
    if (resolved) {
      counters.verified += 1;
      lastUpstream = resolved;
      const anonymized = resolved === ANONYMIZED_CHANNEL;
      if (anonymized) counters.anonymized += 1;
      lastVerified = {
        at: new Date().toISOString(),
        provider: resolved,
        model,
        responseModel: lastResponseModel,
        systemFingerprint: fingerprintProvider,
        anonymized,
      };
    } else {
      counters.unknown += 1;
      if (ctx?.hasUI) ctx.ui?.setStatus?.("clinepass", "Provider: --");
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
        lines.push(`last upstream: ${lastUpstream ?? savedVerdict()?.provider ?? "(none)"}`);
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
      if (!limitsJson || limitsJson.success !== true) {
        ctx.ui.notify("Cline Pass: usage API unavailable (credential rejected, offline, or no success flag).", "error");
        return;
      }
      const usageData = isRecord(limitsJson.data) ? limitsJson.data : undefined;
      const limits = usageData && Array.isArray(usageData.limits) ? (usageData.limits as unknown[]) : [];
      const byType = new Map<string, Record<string, unknown>>();
      for (const item of limits) if (isRecord(item) && typeof item.type === "string") byType.set(item.type, item);
      const planEnvelope = planJson && planJson.success !== false ? planJson : undefined;
      const plan = planEnvelope ? (isRecord(planEnvelope.data) ? (planEnvelope.data as Record<string, unknown>) : planEnvelope) : undefined;
      const planDetails = isRecord(plan?.plan) ? (plan.plan as Record<string, unknown>) : undefined;
      const status = isRecord(plan?.plan) ? (planDetails?.isActive === false ? "inactive" : "active") : "unknown";
      const percentUsed = (key: string): number | undefined => {
        const value = byType.get(key)?.percentUsed;
        if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
        return Math.min(100, Math.max(0, Math.round(value)));
      };
      const bar = (p: number): string => {
        const left = Math.min(100, Math.max(0, p));
        const filled = Math.round(left / 10);
        return `[${"█".repeat(filled)}${"░".repeat(10 - filled)}]`;
      };
      lines.push(`ClinePass remaining usage — ${stringValue(planDetails?.displayName) ?? "Cline Pass"} (${status})`);
      let readableWindows = 0;
      for (const [label, key] of [["5-hour ", "five_hour"], ["Weekly ", "weekly"], ["Monthly", "monthly"]] as const) {
        const used = percentUsed(key);
        if (used === undefined) {
          lines.push(`${label} — (no readable percentUsed)`);
          continue;
        }
        readableWindows += 1;
        const left = 100 - used;
        const reset = resetRelative(byType.get(key)?.resetsAt);
        lines.push(`${label} ${bar(left)} ${String(left).padStart(3)}% left${reset ? ` · resets in ${reset}` : ""}`);
      }
      if (readableWindows === 0) lines.push("usage: the API returned no readable 5-hour / weekly / monthly windows");
      const periodEnd = stringValue(plan?.currentPeriodEnd);
      if (periodEnd) {
        const at = new Date(periodEnd);
        lines.push(`period ends: ${Number.isNaN(at.getTime()) ? periodEnd : at.toISOString()}`);
      }
      lines.push(`last upstream: ${lastUpstream ?? savedVerdict()?.provider ?? "(none)"}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
