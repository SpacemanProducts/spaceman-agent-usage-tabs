# Changelog

One short entry per feature release, newest first; small fix versions are folded into the release
they belong to. The full history, patch by patch, is in git (`git log`).

Bump the version in `manifest.json` and add a line here with every change
(patch for a fix, minor for a feature).

## 1.10.0 - 2026-11-22
- A **Claude Squad** button next to App. It checks that `cs` is installed (one-click install if not), lets you tick which
  agents to run, then opens a terminal and runs `cs -p <agent>` for each. The git repo folder is the last one used, else a picker with
  three things: recent git repos (backups and desktop files hidden), Create a new project (in ~/Projects, git-initialized
  with a first commit) and Browse... for anywhere else. Screenshots retaken with the button.

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
