# Constance's brain backends

Constance's own planning and review brain — the "quarterback" that reads the
board, splits work and reviews the reports — can run on two CLIs. The choice
is yours; everything else about how she works stays the same.

## Picking one

The **Brain** chips sit above the Milk slider on her screen: **Claude** or
**Antigravity**. The choice is saved as `constanceBrain` in settings.json
(`node bin/settings-set.mjs constanceBrain claude` or `... antigravity`; the
panel's chips do the same thing). A switch takes effect at her next start —
a new goal, or a resume after a pause or restart. Nothing mid-run changes.

Claude Code is the default and what you get if the setting is missing or
says anything else.

## The keyring catch

Antigravity keeps its login in the desktop keyring. Her brain runs as the
real `agy` CLI, outside the worker sandbox, so choosing Antigravity is only
honored when you have already opted that agent in:

```json
// settings.json
"constanceKeyringAgents": ["antigravity"]
```

That is the same opt-in that lets Antigravity work sandboxed as a worker —
it means you accept that the agent can read the whole keyring. Without it,
`constanceBrain: "antigravity"` is ignored: she stays on Claude Code, the
panel shows one calm line saying why, and the log notes it once. There is no
error and nothing to fix unless you want the other brain.

## Which model

When Antigravity is the brain, `topModel()` picks the best model `agy`'s own
live model list still offers, in this preference order:

Claude Opus 5.5, Gemini 4 Carbon, Orchestrator Carbon, Gemini 4 Argon,
Claude Sonnet 5.5, Claude Opus 4.6, Gemini 4 Hydrogen, Claude Sonnet 4.6,
Gemini 3.8 Flash.

A model `agy` itself marks unavailable never wins, no matter where it sits;
if nothing on the list matches, the first usable model is taken. You can
override the pick with `constanceBrainModel` in settings.json, by id or by
name (case-insensitive) — it only applies if that model is on the live list.

## Limits and pacing

Pacing always reads the picked backend's own bars, so the same rules apply
to either brain:

- delegate when a window is burning faster than its time allows, or at 70%;
- pause at 90% (97% in the last stretch before a reset), resume on the
  reading;
- a window at 100% is a hard stop Keep going can't override;
- Keep going works the same way.

For Antigravity the bars are the quota pool the chosen model burns — Claude
and GPT models share one pool, Gemini models share the other — renamed to
plain **Session**/**Weekly** so the pacing windows line up with Claude's.
The header Session tile and the leverage meter use the same bars. The Milk
slider's label becomes **Milk Antigravity** with the same 0/25/100 levels.

One thing is Claude-only: model fallback. If the plan rejects Opus, she
drops to Sonnet, then Haiku and restarts the goal on a fresh session. agy
has no such ladder — a rejected model is just a failed run.

## Limit walls

Claude's "hit your limit · resets \<time\>" exit is parsed exactly as
before: `wall.json` records the stated reset and the goal pauses until then.

For agy there is no such exit line. A failed run whose output contains a
quota, rate-limit, 429 or resource-exhausted line counts as a wall instead.
She waits until the latest reset among the nearly-spent bars (at or above
85%), or the earliest reset if none qualify, or one hour if no reset is
readable at all. The pause reads "Antigravity said it hit its limit" and
she resumes the same goal 60 s after that time. A wall is never counted as
a failure.

## Real differences

- **No session resume.** `agy` has no system-prompt flag and no preset
  session ids, so every run starts fresh: her role goes at the top of the
  prompt instead of a system prompt, and she re-reads the board (`C status`,
  `C jobs`) each run to pick up where she was. Claude resumes its session.
- **No shared quota.** While Antigravity is her brain it is not handed
  worker jobs, so the two never draw from one pool. Claude is never a
  worker either way.

## What never changes

The worker sandbox, the guardrails (allowed-files diff check, home and
projects snapshot, task-size strikes), practice mode, the second-try rule,
the goal queue and the pace itself are identical on either brain. Nothing
is spent or bought — the only difference is which CLI's plan her own
planning tokens come from. Credentials are only ever read by the CLIs
themselves; Constance never touches a token.
