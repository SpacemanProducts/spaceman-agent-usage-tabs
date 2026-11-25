# Freebuff and Kilo Code as Constance agents

Research notes for making `freebuff` (Codebuff-based) and `kilo` (opencode-based)
runnable as Constance workers. Everything below is either **[checked]** — read
from the CLI's own `--help`/read-only output on this host — or **[host]** — a
fact given about this machine's installs. Anything not verified is marked
**[unknown]**.

## Kilo Code (`kilo`)

Version on host: **7.8.32** [checked: banner in `kilo --help`].

### Headless mode

**Yes.** `kilo run [message..]` is the non-interactive entry point [checked:
`kilo run --help`]. It is opencode-derived; the plain `kilo [project]` command
starts the interactive TUI, and `kilo run` takes the prompt as positional
arguments:

```
kilo run [message..] [options]
```

- Prompt: positional `message` array; also `--prompt` exists on the top-level
  CLI but `kilo run` itself documents the positional [checked].
- Working directory: `--dir <dir>` (on `kilo run`; path on the remote server if
  attaching) [checked]. The top-level CLI also accepts a `[project]` positional
  path and a `--worktree` flag [checked]. For sandboxed runs, `--dir` plus
  `cd`-equivalent behavior needs a live test — the help does not say whether
  `--dir` is honored for local runs or only remote attach [unknown].
- Model: `-m, --model provider/model` (e.g. `kilo/kilo-auto/free`) [checked].
- Attach to an existing server: `--attach <url>` with `-u/--username` and
  `-p/--password` (defaults `KILO_SERVER_USERNAME`/`KILO_SERVER_PASSWORD`)
  [checked].
- Agent selection: `--agent <name>`; sessions: `-c/--continue`, `-s/--session`,
  `--fork`, `--cloud-fork`, `--share` [checked].
- `-i, --interactive` runs a "direct interactive split-footer mode" — not
  needed for headless [checked].

### Auto-approve / permissions

`--auto` — "auto-approve permissions that are not explicitly denied
(dangerous!)", default false [checked: `kilo run --help`]. This exists both on
`kilo run` and on the top-level CLI [checked]. Caveat for Constance: the
worker sandbox (bubblewrap) already confines writes, so `--auto` is the
opencode-style permission bypass, not a filesystem guarantee — combine with
the sandbox, don't rely on it alone.

### Output format

`--format default|json` — "default (formatted) or json (raw JSON events)",
default `default` [checked]. For machine parsing use `--format json`.
`--print-logs` writes logs to stderr and `--log-level DEBUG|INFO|WARN|ERROR`
controls verbosity [checked].

### Exit codes

**[unknown]** — not documented in help. Needs a live probe (a fake-home test
run with a failing command, or reading the bundled JS). Do not assume 0 =
success-only; parse `--format json` events for a definitive done/error signal
if used.

### Config, sign-in, data

- Config: `~/.config/kilo/kilo.jsonc` [host].
- Data + login: `~/.local/share/kilo/kilo.db` — sqlite. Tables include
  `account`, `credential`, `session` (with `cost`, `tokens_input`,
  `tokens_output`, `tokens_reasoning` columns); `message.data` JSON carries
  `role`, `time`, `modelID`, `providerID`, `cost`, token counts [host].
  `kilo db [query]` opens an interactive sqlite shell or runs one query
  (`--format json|tsv`), `kilo db path` prints the path [checked].
- Model cache: `~/.cache/kilo/models.json` [host].
- Sign-in is NOT in the keyring [host] — safe to treat like grok/copilot
  file-based credentials for sandbox `PROFILES` purposes.
- `kilo auth list|login|logout` manages providers/credentials [checked];
  `kilo profile` shows account profile [checked].

### Usage / cost visibility

- `kilo stats` — token usage and cost stats; `--days N`, `--models [N]`,
  `--tools N`, `--project <name|"">` [checked]. On this host it rendered a
  table (sessions/messages/cost/tokens) and exits 0 [checked live].
- Per-run cost is recorded in `kilo.db` session/message rows [host], so a
  collector can attribute spend to a job folder via session rows.

### Free-model selection

`kilo models [provider]` lists models; `--verbose` adds metadata including
`isFree`, `cost`, limits, capabilities, and `mayTrainOnYourPrompts` [checked].
Observed on 2026-11-25 [checked live]:

- `kilo/kilo-auto/free` — "Auto Free", `isFree: true`, cost 0/0, 256k context,
  rotates through `autoRouting.models` (currently `baidu/ernie-5.5-flash-preview:free`,
  `nvidia/nemotron-3-ultra-550b-a55b:free`, `nvidia/nemotron-3.5-super-vl:free`,
  `reflection/beam-free`). Description warns prompts may be logged by upstream
  providers — flag for the owner before using on private code.
- Other `kilo-auto/*` routers exist: `balanced`, `efficient`, `frontier`,
  `small` — all `isFree: false` on this listing, cost-bearing [checked].
- `:free`-suffixed models exist under several providers (`baidu`, `inclusionai`,
  `liquid`, `nvidia`, `particle-ai`, `recursive`), plus `openrouter/free` and
  `openrouter/auto*` [checked]. The `kilo/~provider/model-latest` entries are
  kilo's own alias shortcuts.
- `kilo-auto/free` is the safe default for "never spend" workers; any other
  `-m` value needs a cost check.

### Detecting a run that would cost money

Best available signals [checked/host mix]:

1. `kilo models --verbose` → `isFree`/`cost` per model — a collector can
   refuse any `-m` whose entry isn't `isFree: true` (or match `:free` suffix /
   `kilo-auto/free`).
2. Post-run: `kilo stats --days 1 --project <dir>` or the `session.cost`
   column in `kilo.db` shows whether the run actually spent [host].
3. `kilo-auto/free`'s `autoRouting.models` are all `:free` today, but the list
   is server-driven and can change — re-check `isFree` on the resolved model
   per run if strictness matters [checked: description says it "rotates through
   available free models"].

## Freebuff (`freebuff`)

Version on host: **0.2.38** [checked: `freebuff -v`]. Codebuff-based [host].

### Headless mode

**Not found.** `freebuff --help` shows only:

- `-v/--version`, `--continue [conversation-id]`, `--cwd <directory>`,
  `--trust-agents` ("load this repository's .agents files and mcp.json without
  asking (for CI)"), `-h/--help` [checked].
- Commands: only `login` and `doctor` — `login` opens sign-in, `doctor` runs
  read-only diagnostics [checked].

There is **no message/prompt positional and no `--prompt` flag** in the help,
and no `run`/`exec`/`headless` command [checked]. Whether a prompt can be
passed via stdin, env var, or an undocumented flag is **[unknown]** — the help
is the whole surface and it shows none. Likely interactive-TUI only; treat as
"no headless mode unless a hidden flag is found" and do not build a worker on
it yet. `doctor --json` exists and is machine-readable [checked], useful for
sign-in/health checks if freebuff is ever wired in.

### Working directory / permissions

- `--cwd <directory>` sets the working directory (default: cwd) [checked].
- `--trust-agents` auto-loads `.agents`/`mcp.json` "for CI" — implies freebuff
  is meant to run unattended in CI somehow, but the mechanism isn't in help
  [unknown how the prompt reaches it].
- No `--auto`/permission flag in help [checked].

### Output format / exit codes

- No `--format` option [checked]. `doctor` supports `--json`, `--markdown`,
  `--ask`, `--full-paths`, `--verbose` [checked].
- Exit codes: `--help`/`-v`/`doctor` exit 0 [checked]; run-mode codes
  **[unknown]**.

### Config, sign-in, data, ads

All **[host]** unless noted:

- Config + login: `~/.config/manicode/` — `credentials.json` (login),
  `settings.json` (includes `adsEnabled`), `freebuff-live-*.json`, and
  `projects/<name>/chats/<ts>/run-state.json` containing `creditsUsed` and
  `contextTokenCount`.
- `~/.freebuff/project-id` marks the project.
- Neither login is in the keyring [host].
- **Ads**: `adsEnabled` in `settings.json` controls them [host]. Where the ads
  appear in output (TUI banners? injected into context?) is **[unknown]** —
  needs a live interactive look or source read before wiring into Constance,
  since ad text in a worker's context could pollute reports.
- `creditsUsed`/`contextTokenCount` in run-state.json are the usage signals a
  collector would read; `freebuff-live-*.json` likely holds live session state
  [host, filenames observed].

## Bottom line for Constance

- **Kilo is ready to wire as a worker**: `kilo run --dir <wt> --auto --format
  json -m kilo/kilo-auto/free "<prompt>"` is the candidate invocation. Open
  items: verify `--dir` locally, confirm exit codes, decide whether
  `kilo-auto/free`'s prompt-logging warning is acceptable for private repos,
  and add `~/.config/kilo` + `~/.local/share/kilo` to the sandbox `PROFILES`.
- **Freebuff is not**: no documented headless/prompt path. Next step is a
  careful look for hidden flags or stdin support (read-only probing only) —
  or skip it. Its `creditsUsed` tracking and `adsEnabled` setting also need
  understanding before it can be a trustworthy worker.
