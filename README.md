# pi-clinepass-dsh

Cline Pass for [pi](https://pi.dev), mirroring what `dsh-clinepass` does in DeepSeek Harness — minus
the billing/price-tracking machinery:

- registers the `clinepass` OpenAI-compatible provider with **two** models:
  - `cline-pass/deepseek-v4.1-flash` (stable alias)
  - `cline-pass/deepseek-v4.1-flash-1017` (dated snapshot)
- **observes** the real upstream provider of every cline-pass request (`provider_stream_event` →
  `provider_metadata.gateway.routing.finalProvider`, OpenRouter `provider`, or
  `provider_metadata.deepseek.systemFingerprint`) and shows it in the footer using the dsh pill's
  wording: `Provider: deepseek`, `Provider: --` while awaiting a reply, and the last saved verdict on
  session start. An anonymized channel (`openai-compatible-private`, contributor tier) gets a `⚠`
  prefix plus a one-shot warning — the same signal as the dsh pill's warn icon/tooltip;
- writes counters + last verdict to `~/.pi/agent/clinepass-status.json`;
- `/clinepass` reports plan usage (5h / weekly / monthly) from Cline's billing API;
- **never rewrites a request.** Pinning stays in your own config: `models.json` `samplingParams`
  for the 1017 snapshot (the gateway enforces `providerOptions.gateway.only` there).

**Synced with dsh-clinepass v0.12.6.**

## Install

```sh
pi install /Users/breakfree/Documents/Projects/pi-clinepass-dsh
```

## Auth

One of:

- `CLINE_PASS_API_KEY` in the environment, or
- `/login` → **Cline Pass** → paste the API key.

Either way pi stores it as the provider credential (`~/.pi/agent/auth.json` → `clinepass`). An
existing Cline Pass login from the old `pi-clinepass` package is reused as-is (both store the access
token there).

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
| `~/.pi/agent/models.json` → `providers.clinepass.modelOverrides` | your pinning / overrides (not touched by this plugin) |

## Sync

This is a behavior mirror of `dsh-clinepass`. Whenever that plugin ships a version (tag + release),
port the same behavior here, bump this package's patch version, and update the marker above. When a
pi-side change lands first, mirror it back to dsh and release there before bumping the marker.
Steps: `~/Documents/Projects/dsh/dsh-clinepass/RELEASING.md` §7. After every sync:
`node check.mjs` green, plus one live request per model.

## Difference from the old pi-clinepass

No price catalog, no per-turn cost meter, no calibration flow, no Cline CLI/WorkOS device login.
Models are static here; usage comes straight from the billing API. The old package's model list
(and its local catalog patch for 1017) is gone — this extension is the only source of the two models.

## Check

```sh
node ~/Documents/Projects/pi-clinepass-dsh/check.mjs
```

Verifies the package is installed, `models.json` still pins 1017 and leaves the alias unpinned,
`settings.json` still defaults to 1017, and `pi --list-models` lists both.
