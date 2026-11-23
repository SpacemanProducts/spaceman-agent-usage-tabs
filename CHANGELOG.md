# Changelog

One short entry per feature release, newest first; small fix versions are folded into the release
they belong to. The full history, patch by patch, is in git (`git log`).

Bump the version in `manifest.json` and add a line here with every change
(patch for a fix, minor for a feature).

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
