# pi-clinepass-deepseek

Cline Pass for [pi](https://pi.dev), mirroring what
[dsh-clinepass](https://github.com/BreakFree003/dsh-clinepass-deepseek) does in DeepSeek
Harness — including the DeepSeek official-price total next to the provider, with one difference:
here it is footer-only. Nothing is written to disk and the total resets with the session, so there is
no history and no cross-session figure (dsh keeps both via its conversation projection).

- registers the `clinepass` OpenAI-compatible provider with one model,
  `cline-pass/deepseek-v4.1-flash-1017` (display name `DeepSeek V4.1 Flash`);
- **observes** the real upstream provider of every cline-pass request and shows it in the footer
  using the dsh pill's wording: `Provider: deepseek`, `Provider: --` while awaiting a reply, and the
  last saved verdict on session start. An anonymized channel (`openai-compatible-private`,
  contributor tier) gets a `⚠` prefix plus a one-shot warning — the same signal as the dsh pill's
  warn icon/tooltip;
- appends the session's running **official list price** to that same footer slot —
  `Provider: deepseek · ¥5.09` — priced per request at the moment it ran, with the dsh price table
  and peak/off-peak rule (see [Footer price](#footer-price-official-list-price));
- writes counters + the last verdict to `~/.pi/agent/clinepass-status.json`;
- `/clinepass` reports plan usage (5h / weekly / monthly) from Cline's billing API;
- **never rewrites a request body, with one documented exception:** the routing pin. Pinning is
  declared in pi-ai's `compat.vercelGatewayRouting` (`only: [deepseek]`) and completed by the
  plugin's `before_provider_request` hook, because pi-ai 1.4.0's
  `VercelGatewayRoutingSchema`/wire only know `only`/`order`. Corrected 2026-10-30:
  **`gateway.has` is the switch, `only` is just the filter** — without `has` the gateway serves
  `openai-compatible-private` (VMC contributor tier) and ignores `only` outright, so the 0.15.0
  recipe pinned nothing. The hook adds `has: [vision, implicit-caching]` (and `only` when absent) to
  cline-pass requests and touches nothing else.

**Synced with dsh-clinepass v0.18.10.** The two repos are behavior mirrors: whenever one side ships a
version, the other ports the same behavior and updates its marker (see [Sync](#sync)). Since 0.1.18
the footer also carries the official list price, using dsh-clinepass's price table and peak rule. Both sides
now send `gateway.only: [deepseek]` **and** `gateway.has: [vision, implicit-caching]` for the 1017
snapshot — dsh by patching pi-ai's boot gate/schema/wire, pi by filling the field in its request
hook, so neither relies on `only` alone. The model here and in dsh-clinepass declares 384,000 max
output.

0.1.20 (dsh-clinepass 0.18.10) is **no behavior change** here: dsh 0.18.3–0.18.10 only rewrote the
settings-page spend card. Its amount now comes from the gateway billing ledger (`/users/<uid>/usages`,
summed `costUsd` from the reset baseline), and its monthly percentage is `monthly.percentUsed − the
value recorded at reset`. Both are dsh settings surfaces. pi has no settings page and no reset baseline:
the footer keeps the session-scoped official list price, and `/clinepass` keeps reporting the plan's own
30-day percentages straight from `/usage-limits`.

0.1.19 (dsh-clinepass 0.18.2) is **no behavior change** here: dsh 0.18.1 shipped the peak/off-peak
contract clarification and a review backlog, dsh 0.18.2 unified the last money format (the settings
card). None of those surfaces exist in pi — the footer price, model list and `compat` flags are
unchanged.

0.1.18 (dsh-clinepass 0.18.0) ports dsh's list-price display to the footer: the same price table
(¥0.04/M cache read, ¥2.00/M miss **and** cache write, ¥8.00/M output, off-peak × 0.5), the same
Beijing-time peak windows (Mon–Fri 09:00–12:00 / 14:00–18:00, no holiday exceptions), the same
per-request peak/off-peak decision and the same magnitude-based `¥` formatting. What does not come
across is the projection: pi has no conversation log to rebuild spend from, so the total is a
module-level sum of `message_end` usages — cleared on `session_start`, never persisted, no
cross-session or sub-agent grouping. `/clinepass` now prints
`list-price: ¥x.xx (peak ¥… · off-peak ¥…)`.

0.1.17 (dsh-clinepass 0.18.0) is **no behavior change** here: dsh 0.18.0 adds per-conversation list
pricing (a `clinepassCost` session projection, the ¥ amount on the Provider pill and a resettable
total on the settings card). At the time both were dsh-only surfaces — pi has no equivalent
conversation chrome — so the model list, `compat` flags, the fetch hook and the status-file fields
were untouched; 0.1.18 ports the price display, the projection stays dsh-only.

0.1.16 (dsh-clinepass 0.17.1) is **no behavior change** in the footer: the status file now records
`virtualModel` (the echoed model, i.e. the alias's virtual model name) and `upstreamModel`
(`routing.canonicalSlug`, the model id the gateway actually executed) instead of `responseModel`,
and the degraded-pool judgement never existed on this side. As in dsh, the echoed name is not the
serving provider — `cline-pass/…` always echoes the VMC virtual model, pinned or not.

> Renamed from `pi-clinepass-dsh`; old GitHub URLs redirect. Package name is now
> `pi-clinepass-deepseek`.

## Install

```sh
pi install git:github.com/BreakFree003/pi-clinepass-deepseek

# pin a release instead of tracking main:
pi install git:github.com/BreakFree003/pi-clinepass-deepseek@v0.1.15

# from a local clone, for development:
pi install .
```

Restart pi if it was already running. Then log in (see [Auth](#auth)): pi hides providers without a
credential, so the model only appears in `pi --list-models` / the model picker after that.

## Auth

One of:

- `CLINE_PASS_API_KEY` in the environment — works without a stored credential, or
- `/login` → **Cline Pass** → pick either method → paste the API key.

Either way pi stores it as the provider credential (`~/.pi/agent/auth.json` → `clinepass`). An
existing Cline Pass login from the old `pi-clinepass` package is reused as-is (both store the access
token there).

The credential is a static Cline API key: the extension gives it a 10-year expiry and `refreshToken`
cannot mint a new one. If it ever expires, run `/login` again.

After login, `pi --list-models | grep clinepass` should list the model.

## Models

| Model id | Context | Max output | Thinking |
| --- | --- | --- | --- |
| `cline-pass/deepseek-v4.1-flash-1017` | 921,600 | 384,000 | `high` / `max` |

The id ends in `-1017` because it is Cline's dated snapshot (the one the gateway historically let you
pin); the display name is `DeepSeek V4.1 Flash`, matching dsh-clinepass 0.16.0. Costs are declared as
zero in the model entry: Cline Pass is a subscription, not per-token billing. The footer's `¥` total
is the **official** DeepSeek list price layered on top of that zero (see
[Footer price](#footer-price-official-list-price)), and it never touches pi's own cost accounting. The
model declares 384,000 max output. This is a client-side budget, not a gateway limit: the Cline
gateway does not validate `max_tokens` (dsh-clinepass tested 200K/400K and got 200s), so it does not
make the model generate longer replies — it only stops pi from cutting a long one off.

## Commands

| Command | What it shows |
| --- | --- |
| `/clinepass` | plan name/status, 5-hour / Weekly / Monthly bars as **% left** (dsh card wording), period end, session list price, last upstream |
| `/clinepass status` | observer counters (`verified/seen`, `unknown`), session list price, last verdict, status-file path |

## Footer price (official list price)

`Provider: deepseek · ¥5.09` — the `¥` figure is the session's running DeepSeek **official** list
price, not Cline Pass quota accounting. Same table and same rule as dsh-clinepass's `cost.js`
(CNY per million tokens, **peak**): `cacheRead 0.04`, `uncachedInput 2.00`, `output 8.00`;
`cacheWrite` is charged as an uncached miss (2.00); off-peak is peak × 0.5. Peak = Beijing time
(UTC+8) **Mon–Fri 09:00–12:00 and 14:00–18:00**; everything else, weekends included, is off-peak.
No holiday exceptions. The call is judged at the instant it finished, so a session that crosses
12:00 / 18:00 / Friday evening is priced per request, not per session. The time zone comes from a
`+8h` shift read with `getUTC*`, so the host's zone never changes the answer.

Only requests whose model id matches `/deepseek-v4\.1-flash/i` are priced; a `deepseek-v4-pro` on
the same route has no price list here, and billing it at flash rates would understate it, so it is
skipped. `cacheWrite1h` is not added on top of `cacheWrite` (it is a detail of that bucket, and the
four pi counters are disjoint). Display hides the amount entirely while the total is zero, and
formats like the dsh pill: `¥5.09`, `¥0.156`, `¥0.0012`.

The total is memory-only: module-level, reset on `session_start`, never written to
`clinepass-status.json`, no cross-session figure. Restarting pi starts from zero.

## Files

| Path | Meaning |
| --- | --- |
| `~/.pi/agent/clinepass-status.json` | observer state (best-effort; never blocks the agent loop); `lastVerified` carries `provider`, `model`, `virtualModel`, `upstreamModel`, `systemFingerprint`, `anonymized` |
| `~/.pi/agent/auth.json` → `clinepass` | credential written by pi's login |
| `~/.pi/agent/models.json` → `providers.clinepass.modelOverrides` | your overrides (not touched by this plugin) |

## Sync

This is a behavior mirror of
[dsh-clinepass](https://github.com/BreakFree003/dsh-clinepass-deepseek). Whenever that plugin
ships a version (tag + release), port the same behavior here, bump this package's patch version, and
update the marker above. When a pi-side change lands first, mirror it back to dsh and release there
before bumping the marker.

The checklist is [RELEASING.md §7](https://github.com/BreakFree003/dsh-clinepass-deepseek/blob/main/RELEASING.md)
on the dsh side. After every sync: `node check.mjs` green, plus one live request.

## Difference from the old pi-clinepass

No price catalog of its own beyond the official list-price table above, no per-turn cost meter, no
calibration flow, no Cline CLI/WorkOS device login. Models are static here; usage comes straight
from the billing API. The old package's model list (and its local catalog patch for 1017) is gone —
this extension is the only source of the model.

## Check

```sh
node check.mjs
```

An optional, read-only smoke check for an installed copy: it verifies that `settings.json` references
this package, that the model is listed by `pi --list-models` with the expected context, that no stale
alias override lingers in `models.json`, and that the observer/pricing markers are present in the
installed source. It reads your `~/.pi/agent` config and never changes it; `pi` must be on `PATH`.
Model-list checks are skipped until a clinepass credential exists, so run it again after `/login`.

The last section imports the source's exported pricing helpers (`isPeak`, `costOfUsage`,
`formatCny`, `isPricedModel`, `addUsage`, `statusText`) at fixed timestamps and drives the real hooks
with a fake `pi` object, so the formula, the peak/off-peak boundaries, the model gate, missing
`usage` and the footer string are all asserted, not eyeballed. Importing TypeScript needs
**Node ≥ 22.18**; on older runtimes that one section is skipped (`skip` line) and everything else
still runs. A throwaway `HOME` keeps the faked hooks' status-file writes out of `~/.pi/agent`.

## Security and limits

- The extension opens no ports and makes no network requests on its own; `/clinepass` only sends
  your stored Cline token to `https://api.cline.bot` for the two plan endpoints.
- The status file contains verdicts and counters only — no API key, no request headers.
- Observation is passive: `provider_stream_event` sees response chunks after pi has received them,
  and `before_provider_request` returns `undefined` (the payload is untouched).
- The observer can only report what the gateway exposes. If Cline changes the metadata shape, the
  footer falls back to `Provider: --` and the status file's `counters.unknown` grows; it never
  guesses.

## License

MIT — see [LICENSE](./LICENSE).
