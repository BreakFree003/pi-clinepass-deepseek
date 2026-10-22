# pi-clinepass-deepseek

Cline Pass for [pi](https://pi.dev), mirroring what
[dsh-clinepass](https://github.com/BreakFree003/dsh-clinepass-deepseek) does in DeepSeek
Harness — minus the billing/price-tracking machinery:

- registers the `clinepass` OpenAI-compatible provider with one model,
  `cline-pass/deepseek-v4.1-flash-1017` (display name `DeepSeek V4.1 Flash`);
- **observes** the real upstream provider of every cline-pass request and shows it in the footer
  using the dsh pill's wording: `Provider: deepseek`, `Provider: --` while awaiting a reply, and the
  last saved verdict on session start. An anonymized channel (`openai-compatible-private`,
  contributor tier) gets a `⚠` prefix plus a one-shot warning — the same signal as the dsh pill's
  warn icon/tooltip;
- writes counters + the last verdict to `~/.pi/agent/clinepass-status.json`;
- `/clinepass` reports plan usage (5h / weekly / monthly) from Cline's billing API;
- **never rewrites a request.** Pinning is declared on the model in pi-ai's
  `compat.vercelGatewayRouting.only` (`[deepseek]`), which pi-ai 1.3.0 turns into
  `providerOptions.gateway.only` — no gate patch needed on this side. The gateway honours `only`
  for the 1017 snapshot again as of 2026-10-23; without it the weighted tier-0 pick can hand the
  request to fireworks. The stable alias and the rest of `cline-pass/*` are still re-pointed to a
  VMC contributor route.

**Synced with dsh-clinepass v0.15.0.** The two repos are behavior mirrors: whenever one side ships a
version, the other ports the same behavior and updates its marker (see [Sync](#sync)). Both sides
now pin the first-party upstream on the 1017 snapshot (`only: [deepseek]`); dsh needs its boot-time
gate patch for that, pi does not. The model here and in dsh-clinepass declares 384,000 max output.

> Renamed from `pi-clinepass-dsh`; old GitHub URLs redirect. Package name is now
> `pi-clinepass-deepseek`.

## Install

```sh
pi install git:github.com/BreakFree003/pi-clinepass-deepseek

# pin a release instead of tracking main:
pi install git:github.com/BreakFree003/pi-clinepass-deepseek@v0.1.14

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
pin); the display name is `DeepSeek V4.1 Flash`, matching dsh-clinepass 0.15.0. Costs are declared as
zero: Cline Pass is a subscription, not per-token billing. The model declares
384,000 max output. This is a client-side budget, not a gateway limit: the Cline gateway does not
validate `max_tokens` (dsh-clinepass tested 200K/400K and got 200s), so it does not make the model
generate longer replies — it only stops pi from cutting a long one off.

## Commands

| Command | What it shows |
| --- | --- |
| `/clinepass` | plan name/status, 5-hour / Weekly / Monthly bars as **% left** (dsh card wording), period end, last upstream |
| `/clinepass status` | observer counters (`verified/seen`, `unknown`), last verdict, status-file path |

## Files

| Path | Meaning |
| --- | --- |
| `~/.pi/agent/clinepass-status.json` | observer state (best-effort; never blocks the agent loop) |
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

No price catalog, no per-turn cost meter, no calibration flow, no Cline CLI/WorkOS device login.
Models are static here; usage comes straight from the billing API. The old package's model list
(and its local catalog patch for 1017) is gone — this extension is the only source of the model.

## Check

```sh
node check.mjs
```

An optional, read-only smoke check for an installed copy: it verifies that `settings.json` references
this package, that the model is listed by `pi --list-models` with the expected context, that no stale
alias override lingers in `models.json`, and that the observer markers are present in the installed
source. It reads your `~/.pi/agent` config and never changes it; `pi` must be on
`PATH`. Model-list checks are skipped until a clinepass credential exists, so run it again after
`/login`. There is no automated test suite beyond this check.

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
