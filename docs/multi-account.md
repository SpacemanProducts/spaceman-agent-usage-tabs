# Multiple accounts per agent — plan

Goal: one agent tab can show more than one login (e.g. two Claude or two
Copilot accounts), each with its own usage. Phase 1 is this plan only.

## What already exists

Omarchy itself owns multi-account sign-in for **Claude, Codex and Grok**
(`omarchy-agent-account-add --check` prints `additional` for exactly these
three; every other provider is `first` — one sign-in, re-login replaces it).

- **Registry:** `$XDG_STATE_HOME/omarchy/agents/accounts/<provider>.json`
  records each account's `id`, `label`, `plan`, `active` flag and home.
- **Homes:** the primary login stays where the CLI put it (`~/.claude`,
  `~/.codex`, `~/.grok`). Added accounts get a home under
  `.../agents/accounts/<provider>/<id>/` holding only credentials; shared
  dirs/files (projects, settings, history…) are links back to the primary
  home, so history and settings stay one set across accounts.
- **Env overrides:** `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME` point a
  CLI (or our collectors) at a non-primary home.
- **Switching:** `omarchy-agent-account-use` moves the chosen login into the
  primary home, so only the *seated* account's credentials live there at
  once. Our collectors always read the primary home, so they automatically
  follow whichever account is active.
- **Per-account limits:** Omarchy's usage collectors
  (`omarchy-agent-usage-claude`, `-codex`, `-grok`) already iterate the
  registry and emit `accounts[]` with per-account limits into
  `agents/usage/<provider>.json`; `omarchy-agent-account-list --json`
  surfaces them.

Our plugin already consumes this end to end:

- `bin/accounts.mjs` (`buildAccounts`) turns the account list into
  `agent.accounts[]` — only for providers with **2+ signed-in** accounts,
  and it strips email/org/home (ids, labels, plan, active, limits only).
- `chip-meters.js` concatenates account limits, so **chips and the top bar
  already show the worst meter across all accounts**.
- `Panel.qml` already has an **ACCOUNTS** section per agent detail: one
  block per account with its plan, limits and an `ACTIVE` tag.
- `bin/constance-agents.mjs` `limitsOf()`/`judge()` already include account
  limits, so a busy secondary account can block or slow a worker correctly.
- The panel's **+ button** (`bin/add-account.sh`) already offers
  claude/codex/grok and asks for a label on additional accounts.

## Where each account's login lives

| Agent    | Primary home            | Extra-account homes                              | Env override      | Multi? |
|----------|-------------------------|--------------------------------------------------|-------------------|--------|
| Claude   | `~/.claude`             | `.../accounts/claude/<id>/`                      | `CLAUDE_CONFIG_DIR` | yes    |
| Codex    | `~/.codex`              | `.../accounts/codex/<id>/`                       | `CODEX_HOME`        | yes    |
| Grok     | `~/.grok`               | `.../accounts/grok/<id>/`                        | `GROK_HOME`         | yes    |
| Copilot  | `gh` keyring/hosts.yml  | —                                                | —                   | no     |
| Antigrav.| keyring + `~/.gemini/antigravity-cli` | —                                  | `AGY_DIR` (file only)| no     |
| Cursor   | `~/.cursor`             | —                                                | —                   | no     |
| Devin    | Devin CLI login         | —                                                | —                   | no     |
| Amp      | Amp CLI login           | —                                                | —                   | no     |
| OpenCode | `opencode auth`         | —                                                | —                   | no     |
| Kimi/Kiro| single CLI login        | —                                                | —                   | no     |

**Not possible today:** Copilot (`gh auth token` returns only the active
login; gh keeps one active account per host), Antigravity (one Secret
Service entry `service=gemini username=antigravity`; `AGY_DIR` only covers
its file fallback), and every other agent — Omarchy keeps one sign-in for
them and re-login replaces it. Supporting them needs upstream Omarchy
changes first; this plugin should not invent a parallel account system.

## How accounts get named

- The primary account is always `Main` (`id: "main"`).
- Added accounts get a generated id and a user-chosen **label** at
  `omarchy-agent-account-add <provider> <label>` time (e.g. `Work`);
  `omarchy-agent-account-rename` renames later. We display `label` + `plan`,
  never emails/orgs/paths.

## How they show

- **Tab/chip/bar:** worst meter across the agent's own limits *and* every
  account's limits (already implemented in `chip-meters.js`).
- **Panel detail:** ACCOUNTS section, one block per account, `ACTIVE` tag on
  the seated one (already implemented).
- **Constance:** judges the worst limit across accounts; a secondary account
  at 90% makes that agent "waiting on limits". Optional nicety for Phase 2:
  name the blocking account in the reason ("Work — at 92%").

## Gaps to close in Phase 2

1. **Freshness for Claude.** Codex and Grok are our `builtin` agents, so
   `refreshBuiltins()` already refreshes their Omarchy records (which carry
   `accounts[]`). Claude is *not* — our own `claudeLimits()` reads only the
   seated login, and nothing on our refresh cadence updates Omarchy's
   `usage-claude` record, so a second Claude account's limits would go
   stale. Fix: when `$XDG_STATE_HOME/omarchy/agents/accounts/claude.json`
   exists, also run `omarchy-agent-usage-update claude` (throttled like the
   other builtins).
2. **Grok's free-cap wall per account.** Our `grok.mjs` parses the cap wall
   from `~/.grok/logs/unified.jsonl`; a non-active Grok account's wall lives
   in its own home's log. Optional: run `grok.mjs` once per registered
   account home (`GROK_HOME=<home>` is already supported) and attach each
   wall to that account's limits. Billing meters already come from
   Omarchy's record.
3. **Constance account naming** (cosmetic, optional).
4. **Honest-data caveat:** transcript/model stats (`days`, `models`) are
   shared across accounts (the projects dir is linked), so per-account token
   usage cannot be split — only rate limits are per-account. The panel
   should keep showing models/days once per agent, not per account.

## Non-goals

- No parallel account system for providers Omarchy doesn't support.
- No credential handling: we only ever read Omarchy's account list and the
  same homes the CLIs use; sign-in/switching stays with
  `omarchy-agent-account-*`.
