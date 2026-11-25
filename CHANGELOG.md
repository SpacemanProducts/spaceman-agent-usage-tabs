# Changelog

One short entry per feature release, newest first; small fix versions are folded into the release
they belong to. The full history, patch by patch, is in git (`git log`).

## 1.53.0 - 2026-11-25
- **1.53.1: Qt runs headless in the sandbox.** Workers inherited the session's `QT_QPA_PLATFORM=wayland;xcb` but, rightly, no display socket, so any `qml6` call (even `qml6 --help`) aborted with SIGABRT and left a core dump and a desktop crash notification. `sandboxEnv()` and the self-merge suite (`runSuite`) now pin `QT_QPA_PLATFORM=offscreen`; the Wayland socket still stays out. The worker prompt says to check QML with `QT_QPA_PLATFORM=offscreen qml6 <file>`. `bin/constance-sandbox.test.mjs` checks that a sandboxed `qml6 --help` exits 0.
- **Freebuff and Kilo Code get Cook Meter tabs.** Both read only local usage records — Kilo Code from its `kilo.db` (tokens, requests and cost), Freebuff from its run-state credits and tokens — and neither can read plan limits, which are cloud-only, so neither gets meters and each says so in one calm line. `bin/kilo-usage.mjs`, `bin/freebuff-usage.mjs`, `bin/collect-freebuff-kilo.test.mjs`.
- **Kilo Code is a free-only Constance worker.** It runs `kilo run --auto -m kilo-auto/free` in its own bubblewrap profile, capped at 2 copies and ranked right after Devin; a run whose output shows a paid model or any cost over 0 fails the job (`bin/kilo-free.mjs`). Both agents keep file logins, so neither needs `constanceKeyringAgents`. Research notes: `docs/agents-freebuff-kilo.md`.
- **Freebuff is shown but never delegated to.** Its CLI has no headless or prompt mode (interactive TUI only), so `judge()` refuses it; its sponsor banners are stripped from the text Constance reviews (`bin/freebuff-ads.mjs`).

## 1.52.0 - 2026-11-25
- **Constance: the goal queue keeps going.** `queueStops()` in `bin/constance-goalqueue.mjs` splits a finished goal's problems into stops (you pressed Stop, `C needs-owner`, a merge conflict) and notes (a failed goal, unreviewed or still-running jobs, open checklist items). Only stops pause the queue and send the silent notification naming the reason; notes are kept on the goal (`endNotes`) and logged, and the next queued goal starts right away. A goal that fails three times keeps a one-line `failReason` in history. A "hit your limit" exit is still a pause until the stated reset, then the same goal resumes. `bin/constance-queue4.test.mjs` runs 4 queued goals end to end, with a limit hit in goal 2 and a real failure in goal 3.
- **Constance: Copy summary.** A "Copy summary" chip next to Copy all copies `C summary` (`bin/constance-summary.mjs`): each goal's status, the checklist, failed jobs with a one-line error, the leverage numbers and the last 30 log lines, never more than 80 lines.
- **Constance: pick her brain.** A "Brain" picker above the Milk slider runs her quarterback on Claude Code (Opus, the default) or Antigravity's `agy` with its top live model (`bin/constance-brain.mjs`, setting `constanceBrain`). Pacing, the Session tile, leverage and the slider ("Milk Antigravity") then read that backend's own bars (for agy, the quota pool its model burns). Antigravity's login is in the desktop keyring, so it is used only when `constanceKeyringAgents` includes "antigravity"; otherwise she stays on Claude and says why. While agy is her brain it is not a worker. See `docs/brain-backends.md`.

## 1.51.0 - 2026-11-25
- **Constance groundwork: ten new helper modules, each pure and tested.** `bin/constance-route.mjs` picks Opus, Sonnet or Haiku for each of her own steps — plan, review-failed and conflict always Opus, the summary always Haiku, spec/review/fix follow the Milk Opus slider with a one-tier bump after a failed try — and keeps a small `routes.jsonl` tally. `bin/constance-autosplit.mjs` turns a goal into ready-to-delegate jobs, one per checklist item with a file list that never overlaps (a new module brings its test file; the list is capped by the scorecard's size hint), padding with "deeper test" jobs for constance modules that have none. `bin/constance-brief.mjs` caches a short per-project brief — layout, how to test, the rules, files never to touch — rebuilt only when the tree moved a lot or the cache is a week old. `bin/constance-batchreview.mjs` groups pending self-merged jobs into batches of five for one review prompt; a missing or unparseable verdict counts as a fail. `bin/constance-specs.mjs` fills job-spec templates (feature, test, bugfix, refactor, docs) that always end in a "Done when:" line and refuses anything missing or over-long. `bin/constance-refill.mjs` turns open backlog items into queued tasks when the ready queue runs low and free slots exist — test, docs, task and bug kinds only, never touching busy or already-claimed files. `bin/constance-progress.mjs` builds her one-line progress ping (free-worker tokens, tokens per 1% of her session against the 5M target, copies running, session %) and sends it through a throttled notify-send. `bin/constance-ratio-report.mjs` writes an end-of-goal ratio report — free tokens per session %, Opus routing by step, average copies, idle slot-minutes, top fixes — to `history.jsonl` with 1–3 lesson lines for the worst items. `bin/constance-resume.mjs` decides whether a goal paused by Claude's own limit resumes (only after the stated reset plus a 60 s grace) and keeps an "asked the owner" ledger for the morning report.
- **Constance: auto-retry with the error output.** `bin/constance-retry.mjs` gains `shouldAutoRetry`/`retrySpec`: a finished job that failed on its own (failing tests, a guard violation or a crash) gets one automatic redo on a fresh copy of the same agent, its task plus the last 1500 chars of the error output, linked with `again` — still bound by the second-try rule, and never twice.
- **Constance: second wiring pass — the helpers now run the show.** `bin/constance.mjs` drives them: after each sweep the ready queue is refilled from the project's open backlog items when it runs low and copy slots are free (`constance-refill`; the take is marked with the new job id via `refills.json` only when the task actually starts). The auto-retry above is wired in: a failed copy is redone once before review, and a refused handoff falls back to normal review. `C batchreview [--apply FILE]` groups up to five merged, unreviewed jobs into one review prompt; `--apply` parses the verdicts and confirms or reverts each through the normal path. At goal end `afterGoal` saves the ratio report to `history.jsonl` (`kind:"ratio"`, filtered out of goal records) with 1–3 lesson lines for the worst items, and the driver heartbeat records a copies-running sample for it. `C split` autosplits a goal's text into delegate-ready jobs, `C spec KIND` fills a job-spec template, and `C route STEP` reports which model her step runs on. The heartbeat also sends the progress ping and follows `resumePlan` for goals paused by Claude's own limit wall.
- **Constance: edge-case fixes found by the deep tests.** Guard: an allowed directory entry now covers the files inside it, renames are checked on both sides (`--name-status` plus `-z` porcelain, `--untracked-files=all` so untracked dirs can't hide files), and a pre-run HEAD that is no longer an ancestor is reported as "history rewritten" instead of passing clean. Sandbox: dangerous `extraRw` entries are refused and `.git/config` is always bound read-only. Merge lock: stale-lock takeover is atomic (the corpse is renamed aside and re-verified) so two contenders can't both hold it, and the locked fn must be synchronous. Self-merge: the pending-reviews list is read-modify-write under the lock (lost-update race closed), and a merge that dies after staging but before MERGE_HEAD cleans the index and tree instead of leaving a half-merge. Wall: the stated reset is honored even when the "resets" line sits before the hit line. Ramp: malformed machine/ramp readings fail closed instead of letting a copy start on a NaN check. Tokens: a null record can't crash it, unusable amounts stay hidden and `fmtTokens` rolls units correctly. Scorecard, ready-queue (writes now locked), pace (null limits ignored), backlog (CRLF, tag-shaped text), `judge()` (malformed input makes an agent unavailable, never a crash), the notify watcher (a body is never stored, the parser can't be reset by member text, dir matching needs a whole path token) and the spare planner (impossible percents, non-array limits) all take bad input without crashing or leaking; goal-queue `move`/`edit` reject empty targets and null text.

## 1.50.0 - 2026-11-25
- **1.50.1: self-merge races fixed.** `wait` could hand out a self-merged job a moment before its background process cleared the self-merging flag, or just after its sweep marked it finished but before the self-merge started, so her review was refused and the goal went off track. The flag now clears in the same update that marks it merged, and a just-finished job stays out of `wait` (and `review`) until its sweep has run the guard and decided on a self-merge. The merge lock (`bin/constance-mergelock.mjs`) is owned by a pid and only taken over once that process is gone (it used to count as stale after 30 s, while a self-merge holds it through a whole suite, so two merges could run at once). A copy now rebases onto the current branch under the lock right before merging, re-running the suite if that brought in new work, and always merges with `--no-ff` so a send-back reverts all of its commits.
- **Constance: no idle slots.** Copies start whenever memory allows (no load check, no 30 s spacing), and every free slot takes the next ready queued task right away.
- **Constance: self-merge.** A copy that passes its own tests, the guard, the diff check and the full suite merges itself; her review runs later and a send-back reverts the merge. A conflict gets one rebase and retry, then it is flagged.
- **Constance: leverage meter and Milk Opus slider.** Free-agent tokens per 1% of her session (target 5M) in big tiles, status and history. The slider sets how much she reviews and does herself; sandbox and guardrails always stay on.
- **Constance keeps going.** A clean exit with work still open resumes her (up to 3 times); needs-owner is only for real owner decisions.
- **Fix: her panel closed by itself.** Done files and handoff notes were written inside the plugin folder, which makes the shell reload every plugin. They now go elsewhere.
- **Calmer panel** (shorter labels, big numbers) and a read-only remote status file with a proposal for phone access (nothing enabled).

## 1.49.0 - 2026-11-24
- **30-day history and a Week view:** `data.json` now carries each agent's last 30 days of tokens (`history`, oldest first, days with no reading stay `null`) and a top-level `weekly` summary (`bin/usage-history.mjs`, `bin/weekly-summary.mjs`, wired in `bin/collect.mjs`). A tab's detail view shows a **Last 30 days** bar chart in the tab chip's own meter color — unreported days stay empty, and the block hides when there's no data. A new **Week** header button opens a summary of the week: tokens per agent, the busiest day and how many resets hit.
- **CSV export:** Settings gains a **DATA** section with **Export usage history (CSV)**, which runs `bin/export-csv.mjs` and shows the written file's path (or the one-line error) underneath.
- **Local usage readers for OpenCode, Kimi, Qwen Code, DeepSeek Harness and MiniMax Code** (`bin/opencode-usage.mjs`, `kimi-usage.mjs`, `qwen-usage.mjs`, `dsh-usage.mjs`, `mcode-usage.mjs`) read each tool's own local records; Amp stays cloud-only, unchanged. Deep collector tests for Claude, Codex, Grok and Devin.
- **1.49.1: Constance never resumes into a hit limit.** A window at 100% stops her even after Keep going (the panel hides the button then), Keep going's reset-time match tolerates the endpoint's sub-second jitter, a paused goal resumes only on a current reading, and Claude's own "You've hit your … limit · resets 5:50pm (zone)" exit is a pause until that stated time (`wall.json`, `bin/constance-wall.mjs` + test), never a failed run.
- **Constance: agent scorecard.** Every reviewed job counts once per agent (jobs, accepted, sent back, average tokens and time) in `scorecard.json`. `agents` lists available agents best record first, each with a size hint (how many files a job suits it); `delegate` says when a job is bigger than that; `scorecard` prints it, and her panel has a SCORECARD section. `bin/constance-scorecard.mjs` + test.
- **Constance: second-try rule.** A redo goes out with `delegate --again ID`. Work sent back twice (linked by `--again`, or the same file set) is never resent as it was: `delegate` refuses it unless it is a smaller split, and the second send-back tells her to split it or do it herself. `bin/constance-retry.mjs` + test.
- **Constance: use it or lose it.** A per-project backlog of worthwhile work (`<project>/.constance/backlog.md`, owner-editable; `C backlog add|take|done|rm`). When her goal queue is empty and an agent has room it would lose before a close reset, she starts one goal made only of backlog items (once per reset window, never made-up work); her own leftover Opus takes only reviews, tangled bugs and design. `C spare` shows the plan during a goal. On by default; the panel's "Use it or lose it" switch (`constanceUseItOrLoseIt`) turns it off. `bin/constance-spare.mjs`, `bin/constance-backlog.mjs` + tests.
- **Constance: morning report.** When the goal queue runs empty she writes `morning-report.md` in her state folder (goals done, merged and sent-back jobs, tokens, what needs the owner) and sends one silent desktop notification instead of a separate "needs you" one. `bin/constance-morning.mjs` + test.
- **Constance: copies don't excuse each other.** A job with its own worktree is never excused by another job's file list and never excuses one; only shared-folder jobs still do.
- **Constance: lessons tidied.** Duplicates merged into seven lessons, the obsolete "one agent per folder" dropped, guardrail lessons capped at the newest three, and the list capped at 20. Her existing lessons file is tidied once, the first time this version reads it.

## 1.48.0 - 2026-11-24
- **Constance panel redesign, progress at a glance:** a plain-English **Now** line ("Devin 2 is on fixing the guard; 2 jobs waiting for review."); a **goal checklist** that splits the goal into its numbered or bulleted items and ticks each one when its job is merged, with a progress bar and "3 of 6 done" (she tags handoffs with `--item N` and a short `--title`, and ticks items she did herself with `check N`); a **job board** of compact cards (worker, status: queued, held, running, in review, merged, sent back, conflict; files, time taken or live elapsed time, tokens, one-line result), where a click opens the full report and prompt; **history** of past goals (date, outcome, jobs, items, tokens, time taken), kept in `history.jsonl` and rebuilt from the log for older goals; and the raw **log folded away**, with filters by job, worker and kind. Ready-queue tasks show as queued cards; the token meter's worker lines moved onto the cards. `bin/constance-checklist.mjs`, `bin/constance-board.mjs` + tests.
- **Constance goal queue:** add several goals, each with its own folder, while one runs (the goal box becomes "Add to queue"); reorder, edit or remove them under the checklist. When a goal ends well she starts the next one by herself (her pacing still gates it). When it ends needing the owner (a failure, a merge conflict, an unreviewed or still-running job, checklist items left undone outside practice, or her own `needs-owner` note) the queue stops, the panel says why, and a silent notification tells the owner; **Start next** carries on. `bin/constance-goalqueue.mjs` + test; the end-to-end test runs three queued goals through a stop and a restart.

## 1.47.0 - 2026-11-24
- **Constance token meter:** her panel has a TOKENS section with one line per worker she's running (Devin 1–10, Grok, …) showing the tokens its current job has used, updating while it runs, and one total line: this goal split by agent, and today. Counts come from the same per-session usage records the agent tabs read (`folder-usage.json`, which now records each session's start time), matched to a job by its folder (a copy's worktree, or the project) and the session starting during the job. No single matching session, an overlap, or an agent that reports credits instead of tokens shows "can't tell", never a guess. A finished job keeps its last count, so totals survive the worktree being dropped. `bin/constance-tokens.mjs` + test; the end-to-end test matches a live Grok session.
- **Constance tests run inside her sandbox:** the goal, sandbox and worktree tests use the system temp folder (TMPDIR / `os.tmpdir()`) instead of `/var/tmp`, which is read-only in the sandbox.

## 1.46.0 - 2026-11-24
- **1.46.1 – six Constance review fixes:** every new commit is diff-checked whatever the agent reports; home/Projects changes are notices, not strikes; finish signals also come from a job's exit, done file and log; model fallback matches only Claude Code's exact rejection message; `review` refuses unfinished jobs (only `finished` may be accepted or sent back — practice jobs are born finished, so they still work); and Stop runs the guard on halted jobs, so a stopped agent's stray changes are still checked and logged before its worktree/tmp is dropped.
- **Constance's pause follows the reset:** in the last fifth of a session or weekly window she no longer stops at 90% — she stays on delegate pace (planning, review and merges only, editing and testing go to the free agents) and stops only at 97%, so she never runs out before the reset. Far from a reset the 90% pause is unchanged. `bin/constance-pace.mjs` picks the stop line per window from its `resetsAt`.
- **Keep going button:** while Constance is paused, her panel shows a green **Keep going** next to Stop. It drops a `keep-going.json` in her state dir naming the window that paused her; until that window resets she can't be auto-paused for it (the owner takes the risk). The file expires by itself — a reset changes `resetsAt`, and a window with no reset time honors it for one window length only.

## 1.45.0 - 2026-11-24
- **Copyable Constance log:** every log entry is selectable text (drag to select, Ctrl+C copies, Escape gives the panel its keys back) with its own Copy button, and **Copy all** copies the whole log (every entry in `log.jsonl`, not just the ones shown) with practice prompts in full, through the new `constance.mjs log` command (`bin/constance-logtext.mjs` + test). Long entries show their first lines with "Show all"; mouse drags over the log select instead of scrolling the panel.
- **Practice matches real Devin copies:** a practice handoff to a multi-copy agent now gets the prompt a real copy would, naming its worktree under `/var/tmp/constance-worktrees/` for the `pwd` check and the done file, and the log and delegate reply show that path. Nothing is created: the path is kept as `practiceWorktree`, so no merge or cleanup ever acts on it. The end-to-end test's fake Devin now runs the prompt's `pwd` check and only writes its done file inside its worktree; the test checks she read it from there and that the main folder's `.constance/` got nothing.
- **1.45.1 – tests keep out of the real worktree folder:** `CONSTANCE_WORKTREES` overrides where copy worktrees go, and the end-to-end and worktree tests point it at their own temp folder. They no longer delete `/var/tmp/constance-worktrees` (which could wipe a real run's copies); the end-to-end test removes only the worktrees and `constance/*` branches it made in its own repo.

## 1.44.0 - 2026-11-24
- **Up to 10 Devin copies, ramped to the machine:** the copy limit is now Devin's published 10 concurrent sessions, and the `constanceMaxCopies` setting (the panel's −/+ next to the copies line, 1–10) lowers it. Copies start one at a time, at least 30 s apart, and only while the 1-minute load is under 0.8 per core and free memory is at least the larger of 2 GiB and 10% of total. A copy that can't start yet is **held**: its files and number stay reserved, the reason is shown, and it starts by itself (oldest first) when there's room. The panel shows "Devin copies: N of 10 running · M held: why", and held copies get their own rows. `bin/constance-ramp.mjs` + tests; the end-to-end test runs 10 copies at once, refuses an 11th, and holds a copy until the load drops.

## 1.43.0 - 2026-11-24
- **Constance can run up to 4 Devins at once:** each editing Devin job gets its own git worktree on its own branch in a temp area outside your projects, tracked in the panel as Devin 1–4, sandboxed with write access only to that worktree (the main repo's `.git/hooks` and `.git/config` stay read-only inside every sandbox). She gives copies tasks with no overlapping files and hears each one finish separately. After you accept a copy's work she merges its branch into the project one at a time; a conflict stops and is reported instead of forcing anything, and the worktree/branch are kept for you. Accepted copies get the next queued task right away, and worktrees/branches are cleaned up after merge or rejection. `bin/constance-worktree.mjs` + tests cover the worktrees, merges and conflicts.
- 1.43.1: Constance's goal box no longer cuts off long goals. It grows to about 12 lines, then scrolls inside the box; there is no line or length limit, and `bin/constance-goal.test.mjs` checks that a 20-line goal reaches her in full.

## 1.42.1 - 2026-11-24
- **Constance's goal box takes keyboard input again:** clicking it focuses the text area, so typing, Ctrl+V, Ctrl+Shift+V and right-click paste work, and leaving the view or closing the panel releases the keys back to the panel.

## 1.42.0 - 2026-11-24
- **Constance's agents run sandboxed:** every worker she launches runs inside bubblewrap. It can write only the project, its own config and login folders, and a fresh temp folder. Your home starts empty inside (no `~/.ssh`, `~/.config`, Documents, other projects, or other agents' or Claude's logins), the rest of the system is read-only, and it gets no session bus, ssh-agent or display. The project's `.git/config` and `.git/hooks` are read-only. An agent that can't be sandboxed is never launched with its prompts off, and without `bwrap` none are. Copilot, Cursor and Antigravity keep their logins in the desktop keyring, so they stay off until you allow each one (`constanceKeyringAgents` in settings.json). Allowing one gives it read access to the whole keyring. Checked live with all six CLIs; `bin/constance-sandbox.test.mjs` shows a sandboxed process can't delete or move anything outside its project.

## 1.41.0 - 2026-11-24
- **1.41.1 safety fixes:** the guard never deletes, moves, checks out or cleans anything anymore. It reverts only a commit it has confirmed the run made (and aborts a revert that can't apply cleanly), blames only paths that weren't already dirty before the run, and reports everything else. The notification watcher only listens to Ghostty and agent CLIs, so chat, mail, browsers and this plugin's own alerts are dropped unread. It never stores a notification body, keeps no text at all for runs Constance didn't start, and exits once her goal ends. Constance refuses the home folder (the panel's fallback when no folder is picked), and the tests use a fake home and a fake bus.
- **Constance hears when an agent finishes:** a read-only watcher on the session bus (`busctl monitor`, spawned with the driver, deduped, killed on Stop) parses `org.freedesktop.Notifications` calls — the same notifications Ghostty raises from an agent CLI's OSC escape. A "Devin finished"-style signal is matched to her running job by agent, folder and done file; when the done file is missing she gets the folder's git log and status inspected for her. Signals for agents she didn't start are logged as the owner's own and left alone. `C signals` lists them, `wait` and `status` carry the recent ones, and they show in her panel log.
- **The ready-task queue is real now:** `C queue --task "..." [--files a,b] [--agent ID]` keeps a per-project queue in her state folder while she plans; `C queue` lists it, `C queue rm ID` drops one. When she accepts a finished job, the next queued task is handed to the same agent automatically (re-checking availability, conflicts and guardrail caps — a refusal leaves it queued with the reason). The panel shows the queue under READY QUEUE, and `wait`/`jobs`/`status` report it.

## 1.40.0 - 2026-11-24
- **Constance learns between goals:** a lessons file in her state folder (outside any repo) is seeded with nine hard-won rules — keep free agents busy with a ready-task queue, watch the terminal's "finished" notification as well as the done file, check every report against its handoff, demand proof for "it's just an artifact" and "nothing's wrong", agents never touch the real home (tests use a mktemp fake home, backups never /tmp), one agent per project folder, per-project rules live in the project's own rules file, weaker models get one narrow task. She reads the lessons before every goal, adds short lessons herself with `C lesson`, and they are advice only — they can never override her core rules.
- **Per-project rules:** a `.constance/rules.md` in a project is read fresh and added to her goal prompt and every handoff for that project.
- **Guardrails for the free agents:** every handoff now carries an allowed-files list, bans on `mv`/`rm` outside the project, `rm -rf`, `git reset --hard`, force-push and branch deletes, and a stop-and-report rule for surprises or scope growth. After each run she checks the diff touched only allowed files and that the home and project lists match a pre-run snapshot; a violation reverts the bad commit (never a reset), cleans stray files, quarantines folders created in the projects dir, logs a lesson and counts a strike — struck agents get smaller tasks only (3 files, then 1). `C agents` and `C status` show the strikes.

## 1.39.0 - 2026-11-24
- **First-run welcome screen:** the first time the panel opens after install it shows a Welcome screen with three tips (the glanceable meters and celebrations, tabs/models/drag-order and the header buttons, and the privacy rules) and a "Got it" button that dismisses it for good. Until then it reappears on each open; auto-opened reset panels never trigger it.
- **Durable backups:** `bin/backup.sh` writes a timestamped tarball of the plugin folder plus `shell.json` into `~/.local/share/agent-usage-tabs-backups/` (keeping the newest 10) instead of /tmp, and CLAUDE.md now requires it before editing.

## 1.38.0 - 2026-11-24
- **Public-release polish:** README rewritten for new users — install check, update and uninstall steps, settings, Constance with practice mode and model fallback, multi-account support, privacy and the Ko-fi link. Fresh panel-only screenshots in dark and light themes (tabs, Start picker, Constance) with folder names blurred. New `bin/install-check.mjs` preflight tells a new user what their machine is missing before they install, and a lifecycle test proves a clean install and uninstall leave nothing behind.

## 1.37.0 - 2026-11-24
- **The whole plugin now follows the active Omarchy theme like the stock panels:** meter colors moved into `usage-colors.js`, which picks the bright or deep set for each surface's actual background and verifies WCAG contrast — any color that wouldn't read is adjusted toward black or white, and a mid-tone background that would collapse the three levels triggers a hue-preserving rebuild so low, medium and high stay tellable apart. The panel popups, tab chips, limit bars, top-bar percentage and robot, Start picker, Constance panel and settings all draw from the same live `Color`/`Style` sources, so a theme switch updates everything without a restart. Celebrations keep their dark/light variants.

## 1.36.0 - 2026-11-24
- **Constance's panel got a layout pass:** the goal is a multi-line box that grows as you type, the folder picker highlights only the selected folder, "Give it to Constance" is a full-width button disabled only while the goal is empty, and the Practice switch sits right beside it. Constance's own row now shows her session and weekly percentages instead of delegate pace. The agents are grouped Ready / Waiting on limits / Can't use — waiting rows name the blocking limit and when it resets, and Can't use collapses to a count. The log moved above the agents and keeps the most room, newest entry first.

## 1.35.0 - 2026-11-23
- **Constance has a Practice switch and a model fallback:** Practice mode (on by default for now, in her panel under PRACTICE) is a dry run — she still plans the goal and picks agents, but every handoff only writes the agent, the reason and the full prompt into her log; nothing launches and nothing changes, and she can still review each piece. If Opus isn't allowed on the Claude plan, she drops to the best model that is (Sonnet, then Haiku), says so in the log and starts the goal over on the new model instead of failing — other errors never downgrade her. Her panel shows the model she's actually on.

## 1.34.0 - 2026-11-23
- **Constance's handoffs got stricter and her review got cheaper:** every handoff prompt is now fully self-contained — folder check, git status, the task, what not to touch, tests and build, its own commit, no push or deploy unless the task says so, a plain-text report (what changed, test results, files; no screenshots unless the look is the task) and the done file. She delegates one small, clear task at a time and gives weaker agents smaller pieces. A bug with an unknown cause is investigated first with a read-only handoff (omit `--files`: change nothing, find the cause, report in a few lines, stop); the fix is a second handoff. She reads the agent's report and checks it against the goal, and reads the full diff herself only when the change is risky or the report doesn't add up. Large files get summarized by a free agent instead of being read by her, while live database changes, tangled cross-part bugs and anything with secrets stay with her.

## 1.33.4 - 2026-11-23
- **Dragging a tab into first spot selects it:** the first tab is the default agent, but a reorder left the panel showing the previously selected agent's limits until it was clicked. A drop that changes which tab is first now selects the new first tab right away, so the details and the top bar switch with the order; drops that leave the first tab alone keep the current selection.

## 1.33.3 - 2026-11-23
- **The bar mirrors the tab chip, and the percent sits right:** the percentage is drawn by the button's built-in label again, so it gets the same spacing, centering and vertical alignment as before — "100%" no longer overlaps the neighbouring icon. Colors now mirror the chip exactly: the percentage and the button's active state (its underline) take the chip's outside-border color (the session tint) and the robot takes the chip's inside color (the weekly tint), both through the chip's own `tintFor` rule so unsure readings never go green. The robot no longer uses the theme's `urgent` color for the angry state — on themes where urgent isn't red (e.g. Hackerman's green) a maxed-out agent showed a green robot; it now shows the weekly tint, which is red at 100%.

## 1.33.2 - 2026-11-23
- **The bar splits session and weekly again:** the percentage beside the robot is the default agent's session usage in the session's own color, and the robot itself is colored by the weekly's level — Claude at 62% session and 38% weekly shows "62%" in amber and a green robot. Both readings come from the same `chipMeters` session/weekly meters the tab chip's borders use (one limit serves both when that is all the agent reports), and each level uses the same `meterColorFor` thresholds as the tab's limit bars, so 100% is always red. The button's active state follows the robot, and the tooltip shows both numbers.

## 1.33.1 - 2026-11-23
- **The bar robot follows the tab again:** 1.32.0's separate severity table hid the percentage below 90% (Claude at 51% showed nothing) and used its own 90% red line while the tab bars turn red above 85%. The robot now reads the same session/weekly meters the chip colors from and uses the same `meterColorFor` thresholds as the tab's limit bars — the percentage always shows when the agent reports a limit, and 100% is always red. The tooltip shows both session and weekly, naming the real meter (a cap, monthly, credits) when that is what is maxed out.

## 1.33.0 - 2026-11-23
- **Constance, the quarterback (first version):** a big C button next to CS. Give her a goal once; she runs as Claude Code (Opus) on the paid plan, hands routine pieces to free agents that are under their limits (re-checked before every handoff, never anything that charges), reviews each result in finish order, and reports. Handoffs start with a folder check, keep jobs off each other's files, and end with a done file. She paces herself against her session and weekly limits (delegates more when burning fast, pauses at 90% until the reset). Stop halts everything; the screen shows every agent and what it is on, plus a log of every handoff and result. Jobs survive a shell restart.

## 1.32.0 - 2026-11-23
- **One severity rule for the bar icon, every agent:** the robot is colored and labeled from the worst limit the agent reports (the fullest bar in its tab) through a single shared table — green under 60%, amber 60–89%, red 90% and up with the percentage shown (so Antigravity 99% and Copilot 94% now show their number, and Cursor/Codex at 100% are always red). The tooltip names the agent the bar represents and the limit behind the color.

## 1.31.1 - 2026-11-23
- **One severity system on the bar:** the robot now falls back to the fullest real meter when the agent reports no weekly limit, so Copilot at 94% shows red instead of neutral, and Cursor at its cap shows red instead of nothing. The percentage still only appears for a real session limit. Copilot's editor-autocomplete meter is gone — the CLI never uses it, so it could never be the right number to show.

## 1.31.0 - 2026-11-23
- **The bar shows session and weekly separately:** the percentage is now the default agent's session limit and the robot its weekly limit, each with its own color (green/amber/red). Agents that don't report one kind show nothing invented for it — no percent, a neutral robot — and the tooltip says which is which ("Devin — session 42% · weekly 67%"). The angry robot now means the weekly limit is used up.

## 1.30.1 - 2026-11-23
- **Models no longer double-count:** a used record went to every row whose name prefix-matched it, so Devin's `swe-2-flash-medium` showed the same total under both SWE-2 and SWE-2 Flash. Each record now belongs to the single best-matching row (SWE-2 Flash), and compactor stays its own line.

## 1.30.0 - 2026-11-23
- **Start launches agents with permission prompts off:** the default agent gets its own skip-permissions flag (Claude `--dangerously-skip-permissions`, Copilot `--allow-all`, Devin `--permission-mode dangerous`, Cursor `--yolo --trust`, Grok `bypassPermissions`, Codex `--dangerously-bypass-approvals-and-sandbox`, Antigravity `--dangerously-skip-permissions`, OpenCode `--auto`, Kimi `--auto`, Kiro `chat --trust-all-tools --trust-workspace`, Amp `--dangerously-allow-all`, Qwen `--yolo`, DeepSeek Harness `DSH_PERMISSION_MODE=danger-full-access`). A new "Skip permission prompts" switch in Settings (on by default) turns them all off, and the Start button shows a "no prompts" mark while it's on. Agents without a known flag still go through `omarchy-agent` unchanged.

## 1.29.2 - 2026-11-23
- The agent detail usage line gets a fixed height and hides when empty, so it no longer leaves a blank gap.

## 1.29.1 - 2026-11-23
- **Kiro shows an honest "can't read" note:** `kiro-cli` has no headless usage command (`/usage` is interactive-only), so the guessed collector is removed rather than showing stale or invented numbers.

## 1.29.0 - 2026-11-23
- **Hidden folders are restore-only:** the Hidden folders view shows a labeled Restore button and no pin control; restoring returns a folder to the main list unpinned (it can be pinned there), and hiding a pinned folder unpins it.

## 1.28.0 - 2026-11-23
- **Antigravity surprise reset:** its notification stays on screen until clicked (sent at critical urgency, the only kind Omarchy's shell doesn't expire); clicking it plays the gold celebration unless it already played while the panel was open. Session and weekly resets are unchanged.

## 1.27.2 - 2026-11-23
- Devin's tab notes that SWE-2 Flash is free until Dec 4, so its quota meters staying at 0% is expected; the note disappears on its own afterward.

## 1.27.1 - 2026-11-23
- Align Start-picker folder cards and names, keep usage rows aligned, and show full folder paths on hover.

## 1.27.0 - 2026-11-23
- **Start picker groups folders into projects:** subfolders roll up to their project (the plugin folder, `~/Rough Rider Eats`), system and tool folders (`~/.gemini`, `~/.local/state`, `~/.config/omarchy`, backups, Claude Squad worktrees) hide by default, and only picker-started, pinned or real project folders show. Hidden folders keep a restorable view, pins still sort first, and folder usage is unchanged.

## 1.26.0 - 2026-11-23
- Restyle the Start picker as a fixed folder grid, with compact usage text, recent-activity sorting, persistent pins, and a restorable Hidden folders view.

## 1.25.1 - 2026-11-23
- Keep Copilot's per-folder usage visible in the Start picker, and don't show usage under "No project".

## 1.25.0 - 2026-11-23
- The Start-agent picker shows each folder's usage over the last seven days for Claude Code, Codex, Copilot, Grok, Devin and OpenCode.
  Copilot stays in AIC and the others in tokens; agents without a confirmed session-to-folder mapping are omitted.

Bump the version in `manifest.json` and add a line here with every change
(patch for a fix, minor for a feature).

## 1.23.0 - 2026-11-23
- **Start agent in home:** the Start picker has a "No project" choice, and Start defaults to `~` when no folder is selected.
  Existing folder choices are unchanged; the default agent picker still supports every installed agent.

## 1.22.0 - 2026-11-23
- **Surprise reset for Claude:** a Claude meter that drops before its scheduled reset (a banked reset spent, or Anthropic resetting)
  plays the surprise celebration. The wording stays honest ("Claude weekly reset came early, go cook.").
- **Start button always opens a terminal or says why:** it used to close the panel right after starting the launcher, and the terminal
  sometimes never appeared. Start now runs through `bin/launch-wait.sh`, which confirms a new window really opened (any workspace) and
  closes the panel only then; otherwise the panel shows the error. Tested with Copilot and Claude Code on a real repo, four launches in a row.
  The Claude Squad **Run** button works the same way.

## 1.21.0 - 2026-11-23
- **Cursor:** its dashboard can say 0% after the CLI was stopped by "You've hit your usage limit" (checked on a Free account). The CLI records
  that in its transcripts, so a standing hit now shows a red "Cursor limit" row (`bin/cursor-wall.mjs`) until a later turn succeeds or the
  meters reset. The "Auto · 44.7%" in Cursor's status bar is the context-window fill, not usage, and is not shown. Cursor has no token source,
  so its tab no longer says "Today 0".
- **Copilot:** the Free chat allowance is in AI credits (AIC, the unit in Copilot's status bar); the meter says how many of the 200 are used.
  GitHub's counters trail a finished session by a short while, so the meter can lag it.
- **Start-agent Browse:** the folder you pick now appears in the list, selected, and a repo under a dot-folder (like this plugin in
  `~/.config`) is no longer hidden from the recent list.

## 1.20.0 - 2026-11-22
- The header **>_** button opens its own screen with a Back button and the same folder picker as CS: recent repos first with the last
  one preselected, then + New project, then Browse. Start opens the default agent in a tiled terminal in that folder
  (`bin/agent-here.sh`, tested in `bin/agent-here.test.mjs`). The robot's right-click and the keyboard shortcut still start it at
  once, with no picker. The folder list is shared with CS (`bin/folders.sh`), so the last repo used is the same in both.

## 1.19.0 - 2026-11-22
- OpenClaw and Hermes are gone: no tab, reader, fix button or default-agent entry. Both are personal assistants with no
  limits of their own, and the provider quotas they pass on already show in those providers' own tabs. The reason is
  recorded under `dropped` in `agents-catalog.json`. The bar now has eleven core agents plus the catalog (Qwen Code,
  Mistral Vibe, DeepSeek Harness, MiniMax Code). A saved tab order or hidden list that still names them just skips them.

## 1.18.0 - 2026-11-22
- A gray tab has one small button under its reason line that goes straight to the fix: Install (a terminal running the agent's
  official install command), Sign in (a terminal running its login command) or Add key (the agent's official API-key page).
  Commands come only from each agent's official docs (`fixes.js`, with sources); with no confirmed command it links the official
  setup page. Tested in `bin/fixes.test.mjs`.

## 1.17.0 - 2026-11-22
- Every notification (limit alerts, resets, notices) closes by itself after about 8 seconds; the 100% alert was "critical" and
  stayed until dismissed. Still once per window.
- A window whose reset time has passed counts as reset right away: 0% ("Reset, waiting for fresh data"), no hit and no red on the
  chip, the bar number or the tab, then fresh data is fetched. The collector does the same and skips Claude's 5-minute cache then.
- Angry robot: while the default agent is at 100%, the bar robot gets angry eyes in the theme's red, and goes back by itself when
  the limit resets or frees up. Gear switch under Alerts, on by default.
- Antigravity models cover the last 7 days (from agy's own transcripts), like Claude. Raw model ids get readable names, background
  worker models are grouped as "Background workers", and the "unknown" row is "Unlabeled usage" with a tooltip saying Antigravity
  didn't name the model.
- Antigravity: the Claude/GPT weekly pool and "no Gemini limit on Ultra" are verified on a real Ultra account. A 5-hour bucket on
  Pro/Ultra hasn't been seen; if Google sends one it shows as its own Session bar before the weekly (an untouched one included).
- A gray tab always says why in one line; Claude Code used without a plan login says so instead of "Not signed in".

## 1.16.0 - 2026-11-22
- Grok's free per-model cap is always shown on a Free plan. Until it's hit, the bar is estimated from the tokens Grok's log records for
  each call in the last 24 h (uncached input + a quarter of cached input + output; within 4% of Grok's own count, and corrected by the
  latest hit), never shown full. When Grok reports the hit, it's red at 100%. Both say "Grok doesn't report how much is left." The cap
  colors the chip like any other wall.
- Grok's Weekly bar shows only when Grok sends a weekly number (paid plans); the Free plan doesn't, so it's hidden.
- The bar number follows only the default agent (the first tab): its session usage, or its weekly when higher, and it's always
  colored like that agent's chip (green, amber, red). It used to show the highest session usage of any agent.
- The Test reset buttons in Settings switch back to the main view first, then play the celebration, so you can see it.
- Gray "unsure" is only for readings that are out of date (Claude limits not refreshed for 15 minutes, a collector that hasn't written
  for three refreshes). Grok no longer marks readings unsure.

## 1.15.0 - 2026-11-22
- Grok's free per-model cap (e.g. 600K tokens per rolling 24 h for grok-4.7) now shows as a meter once Grok reports hitting it, read
  from Grok's own log (`~/.grok/logs/unified.jsonl`); it turns the chip red and clears after a later turn succeeds or 24 h pass.
  Grok's billing endpoints don't report this cap, which is why the tab stayed green while Grok was out.
- Any limit at 100% turns the whole chip red, whatever its title.
- **Unsure instead of green:** a reading the plugin can't confirm is current and complete shows gray with "· unsure" and an
  "Unsure: …" line saying why: Grok's Weekly when Grok sends no usage figure, a Grok Free plan with no cap hit yet, Claude limits that
  couldn't be refreshed for 15 minutes, and every tab when the collector hasn't written for three refreshes. Amber and red still show.

## 1.14.0 - 2026-11-22
- The gear, **+** and **CS** each open as their own screen: the chips and usage meters are hidden, only that screen is shown, and a
  Back button in the header returns. Claude Squad's screen has the agent picker and a folder step (recent repos, new project, browse).
  The add-account screen's helper text is now "Adds another login for one of these agents. You'll be asked to name it."
- The handoff note asks first (Allow / Not now / Never; nothing is written until you allow it), triggers only at 90% session usage or
  more, and only once per usage window. It no longer follows the alert threshold.
- Claude Squad shows "Starting agents" and ignores your keypresses until the sessions are started, then discards what you typed.
- Copilot: a Free account is now labelled Free (it was "Pro"), and its real limits are shown: **Chat and agent requests** (shared plan
  quota) and **Editor autocomplete** (not used by the CLI), with the numbers unchanged.
- Antigravity's removal warning: Sonnet 4.6, Opus 4.6 and GPT-OSS-120b now say "removing Nov 30" (the latest date reported, from a
  community forum post); once a removal date passes while the model is still listed, no warning is shown. One bar per Antigravity
  pool is covered by tests (a Free plan only reports the Claude/GPT weekly bucket).
- Readers and plain "Can't read" lines: OpenClaw (`openclaw status --usage --json`, two-line tab, can't-read only when a provider
  failed), Amp (7-day token total from `amp usage --details`; its credit balance and dollar costs are never shown), and OpenCode, Kimi
  and Hermes (through Omarchy's usage records) each say plainly what they can't read. The catalog is trimmed to five agents with a
  working way to read usage (Qwen Code, Mistral Vibe, DeepSeek Harness, MiniMax Code, OpenClaw); Factory Droid and Augment are out.
- A GitHub Action runs the tests on every push and pull request (one Omarchy-only check skips itself elsewhere).
- Screenshots retaken.

## 1.13.1 - 2026-11-22
- Claude Squad opens one window at a time: the window holds a lock while it is open, and a second launch says so instead of running a
  second `cs` that would overwrite the first one's saved sessions. A crashed window leaves no stale lock.
- The plugin no longer writes `cs` profiles into `~/.claude-squad/config.json` (cs 1.0.20 shows no profile picker, so it did nothing
  useful). It never edits cs's own config now.

## 1.13.0 - 2026-11-22
- A **CS** header button (same style as + and >_) opens Claude Squad; the bottom Launch row and the App button are gone. The Claude
  Squad picker now opens under the header.
- The **+** button opens a picker of agents (Claude Code, Codex, Grok) first, then runs Omarchy's add-account flow for your choice,
  instead of jumping straight to the selected tab's provider.
- A built-in catalog (`agents-catalog.json`) of CLI agents beyond the twelve: only maintained ones with a working way to read usage
  or plan limits (Qwen Code, Mistral Vibe, Factory Droid, Augment, DeepSeek Harness, MiniMax Code, OpenClaw), each with how it
  reports usage, a tab note, install detection and unverified claims flagged. Gemini CLI, Aider and agents with nothing to read are
  left out. Uninstalled ones stay hidden by the existing switch.
- A handoff note: when a session meter's warning fires, `handoff/HANDOFF.md` is written in the active repo (what we were working on,
  what's done, what's next, open problems, from git and CLAUDE.md), with one line in AGENTS.md pointing agents at it; rebuilt each
  time. Off switch under Alerts in the gear settings.
- Screenshots and both GIFs retaken.

## 1.12.1 - 2026-11-22
- Fix: alerts no longer repeat while a condition stays true. The 95% warning fired on every refresh because Claude's reset time
  carries microseconds that change each fetch, so each refresh looked like a new window. Alerts are now remembered per agent
  and window (not per reset string), in two levels: a warning when usage first passes the threshold, and one when the limit is
  hit (100%), each once. They survive restarts and clear only when the window resets. Reset celebrations are likewise once per
  reset, remembered across restarts. Tests hold usage at 100% (and 96%) for many checks and confirm one alert.

## 1.12.0 - 2026-11-22
- A quieter, more native-feeling panel: chips get thin, softer borders and a bit more space between them, the header buttons
  are faint theme tints, and the usage bars are slightly thicker so they stand out. Meter colors stay on the chips.
- The bottom row is now **LAUNCH**: **Claude Squad** is the main button and **App** a smaller, outlined one beside it.
- Fix: Claude Squad opens ONE window. A leftover loop was still opening a helper terminal per extra agent, each running its own
  `cs` (which clobbered the saved sessions and left the Antigravity one unsaved); it is gone, a test guards it, and any
  stray Squad window is closed once the sessions are started.
- The Claude Squad folder picker always shows, with the last repo preselected (Enter reuses it).
- "COULD NOT CONFIRM" is gone: a session is started once its program runs, so an agent at a trust or login prompt counts. Only a
  session that never came up, or whose program exits at once, says `COULD NOT START`. Detaching no longer depends on the agent
  accepting a keypress. Screenshots retaken.

## 1.11.0 - 2026-11-22
- **Claude Squad** button next to App: checks that `cs` is installed (one-click install if not), lets you tick agents, then
  opens ONE tiled window in a git repo folder and starts a `cs` session per agent in it (the plugin types the keys, since
  `cs` has no command for it). It shows the repo first and titles the terminal after it. The folder is the last one used,
  else a picker with recent git repos, Create a new project and Browse... App-button terminals now tile too. Screenshots retaken with the button.

## 1.9.0 - 2026-11-22
- A gray tab (no meter at all) now says why: not installed, not signed in, or no usage source.
- The gear menu is shorter: Display, Reset celebration and Tabs headings, tab switches two to a row. The left/right reorder
  arrows are gone (drag to reorder; **Reset order** stays).
- README screenshots and both GIFs retaken for the current panel, plus a labeled two-account view.

## 1.8.0 - 2026-11-22
- Drag a tab chip onto another to reorder; the order is saved. **Reset order** restores the default (Claude Code, Antigravity,
  Grok, Codex, ...); new agents go at the end.
- The first tab is Omarchy's default agent, marked with a small dot, so the shortcut, the robot right-click and the header
  terminal button follow it. Unsupported or uninstalled first tabs are skipped. It writes the default file directly, because
  `omarchy default agent` also launches the agent.

## 1.7.0 - 2026-11-22
- Follows the active Omarchy theme live (text, background, borders, icons). Meter and celebration colors have deeper variants
  for light themes, all readable (at least 4.5:1).
- A panel header above the tabs: "Agents", with + (add subscription), >_ (default agent) and gear buttons like the stock panel.

## 1.6.0 - 2026-11-22
- Multiple accounts: an agent with two or more signed-in accounts (Claude, Codex, Grok, from Omarchy's own account list)
  lists each with label, plan, an ACTIVE mark and its own meters. No credentials read, no emails stored. Chips, the bar
  number and alerts use the worst meter; alerts and celebrations name the account.
- A "Make something" row with an **App** tile that starts the selected agent's own CLI on building a new Omarchy app
  (plain start, no permission-skipping flags; Kimi gets the prompt on the clipboard). Hidden for an agent with no CLI.
- Test celebration is now **Test session reset**, matching the weekly and surprise tests.

## 1.5.0 - 2026-11-21
- Every celebration names the window that reset (session, weekly, monthly or daily); bigger windows get a bigger burst.
  A **Test weekly reset** button and a GIF of the surprise reset.

## 1.4.0 - 2026-11-21
- Renamed **Cook Meter** ("Know exactly when you can go cook."). The plugin id and repo name are unchanged, so installs
  and links keep working.

## 1.3.0 - 2026-11-21
- Surprise resets: an Antigravity meter that drops more than 50 points before its recorded reset time gets its own bigger
  celebration, with honest wording unless agyresets.com confirms a Google-wide reset. A **Test surprise reset** button.

## 1.2.0 - 2026-11-21
- Reset celebration: confetti, green chip flash, cha-ching with volume, auto-open without taking focus, and a cash-burst
  notification; gear switches for each. Only plan limits, usage and resets are shown (no spend or top-ups).
- Prepared for public release: README, screenshots, MIT license, Ko-fi funding file.

## 1.1.0 - 2026-11-21
- A Models section on every tab (live lists plus `models.json`), plan and free-tier notes, hidden tabs for agents that
  aren't installed, gear settings, a "Data looks wrong" note, and a one-time notice when a hidden agent gets a login.

## 1.0.0 - 2026-11-21
- First version: a tab per installed agent with session and weekly meters, reset countdowns, tokens by model, a daily
  history, a bar number and 95% alerts.
