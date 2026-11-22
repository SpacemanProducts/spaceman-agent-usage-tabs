# Changelog

Bump the version in `manifest.json` and add a line here with every change
(patch for a fix, minor for a feature).

## 1.8.0 - 2026-11-22
- Reorder the tab chips by dragging one onto another; the order is saved in the plugin's own settings.json and survives
  restarts. The gear menu lists every agent with left/right arrows (the fallback if dragging misbehaves) and a **Reset order**
  button that restores Claude Code, Antigravity, Grok, Codex and the rest. An agent that is new to the list goes at the end.
- The first tab is Omarchy's default agent: when the first position changes, the default is set (so the keyboard shortcut,
  the right-click on the robot and the header terminal button follow), with a small dot on the first chip. Only agents
  `omarchy default agent` supports are used; an unsupported or uninstalled first tab leaves the default alone. The plugin
  writes `~/.config/omarchy/defaults/agent` (what that command stores) instead of running it, because the command also launches
  the agent in a terminal and installs a missing one.

## 1.7.1 - 2026-11-22
- A panel header at the very top, above the tab chips, like the stock panel's: "Agents" on the left, and the + (add
  subscription), >_ (default agent) and gear buttons on the right, all the same 34-unit size. The selected agent's name
  and plan stay below the chips (or "Settings" while the gear is open).

## 1.7.0 - 2026-11-22
- Follows the active Omarchy theme live: panel text, background and borders use the theme's popup colors, icons its
  accent, and secondary text is the text color pulled toward the background (it used to be `darker()`, which vanishes
  on light themes). Header buttons: + (Omarchy's add-subscription flow) and >_ (the default agent) beside the gear.
- Meter colors have a bright set for dark backgrounds and a deeper set for light ones (all at least 4.5:1); the bar number
  picks its set from the bar's own background. Celebration confetti, sparkles, rings and the chip flash use light-theme
  variants with no white. `bin/theme-colors.test.mjs` guards the contrast.

## 1.6.2 - 2026-11-22
- A "MAKE SOMETHING" section at the bottom, built like the stock panel's (separator, small label, one stock-style tile
  a third of the width, app-window icon plus "App"), with no Theme or Plugin. The App tile starts the selected
  agent's own CLI on building a new Omarchy app (the same task as the stock panel's App tile), started plainly with no
  permission-skipping flags. An agent with no way to take a starting prompt (Kimi) opens plain with the prompt copied
  to the clipboard. Hidden for an agent with no CLI; the tooltip names the agent. Claude, Codex and Grok follow the active account.

## 1.6.1 - 2026-11-22
- The bottom button is now a single small **App** button (the stock panel's 34-unit tinted square, bottom right) that opens the selected agent's own CLI in a terminal
  (Claude Code opens `claude`, Antigravity `agy`, Grok `grok`, ...), with no permission-skipping flags. It is hidden
  for an agent with no CLI, and its tooltip names the agent. The Theme button is gone.

## 1.6.0 - 2026-11-22
- Multiple accounts: an agent with two or more signed-in accounts (Claude, Codex, Grok, from Omarchy's
  own `omarchy agent account` list and usage records) lists each in its tab with label, plan, an ACTIVE
  mark and its own session and weekly meters. Credentials are never read and emails are never stored.
- Tab chips, the bar number and the 95% alerts use the worst meter across all accounts; alerts and reset
  celebrations name the account ("Claude Code (Work) session reset, go cook."). One-account agents are unchanged.
- A bottom row with App and Theme buttons and hover tooltips (reworked in 1.6.1).
- The Test celebration button is now Test session reset, matching Test weekly reset and Test surprise reset.

## 1.5.0 - 2026-11-21
- Every celebration names the window that reset: "Claude Code weekly reset, go cook.", and monthly or
  daily for agents with those meters (which now celebrate too). A weekly reset gets a bit bigger burst
  than a session one, a monthly one bigger still. The surprise Antigravity wording names it too.
- A Test weekly reset button in the gear settings; a GIF of the surprise reset in the README.

## 1.4.0 - 2026-11-21
- Friendly name: the plugin's display name, the settings footer and every notification now say
  **Cook Meter**, with the tagline "Know exactly when you can go cook." The plugin id and the repo
  name (`spaceman-agent-usage-tabs`) are unchanged, so installs and links don't break.
- The README intro now says the idea in one line: a dashboard for developers in flow state, with a
  celebration when a reset lands.

## 1.3.0 - 2026-11-21
- Surprise resets: an Antigravity meter that drops by more than 50 points before its recorded
  reset time (more than 5 minutes early) gets its own celebration, separate from the normal
  5-hour and weekly ones: a much bigger gold-and-rainbow burst with shockwave rings, a longer
  animation, a gold chip flash, a jackpot sound, and its own notification picture.
- Honest wording: the message says "Antigravity just reset early, go cook." and only says
  "Google just reset everyone, go cook." when agyresets.com has a matching announcement (looked
  up only when a surprise is detected; offline or no match keeps the honest wording).
- A **Test surprise reset** button next to Test celebration in the gear settings.

## 1.2.1 - 2026-11-21
- Prepared for public release: README rewritten to match what the plugin does today, new
  screenshots, the MIT LICENSE and a Ko-fi funding file template, account-specific notes
  generalized, and personal details removed.

## 1.2.0 - 2026-11-21
- Reset celebration: confetti over the chip, green flash, cha-ching (own synthesized
  clip, with volume), auto-open without taking keyboard focus, and a desktop
  notification with a cash-burst picture saying "<Agent> reset. Go cook."
- Gear switches for the animation, the sound (and volume) and auto-open; a Test
  celebration button.
- Only plan limits, usage and resets are shown: spend, overage, on-demand and top-up
  meters are filtered out, and Amp's purchased balance is no longer shown.
- Fixed: a refactor had silently removed the reset detection; it is restored with a
  test that fails if the collector stops calling it.
- Fixed: a layout mistake that stopped the whole plugin loading.

## 1.1.0 - 2026-11-21
- A Models section on every tab (live data first, then the editable `models.json`),
  with unused models dimmed, unavailable ones marked, and announced removals flagged.
- Plan and free-tier notes (Copilot, OpenCode, Kimi, Kiro, Amp, Hermes), Kiro credits meter.
- Tabs for agents that aren't installed are hidden; they appear on their own once
  installed, with a one-time notification. A tab you hide on purpose stays hidden.
- Gear settings, "Data looks wrong" note with a log, one-time "now available" notice
  when a hidden agent gets a login, Antigravity and Grok tokens refreshed in the background.

## 1.0.0 - 2026-11-21
- First version: a tab per installed agent with session and weekly meters, reset
  countdowns, tokens by model, a collapsible daily history, a bar number and 95% alerts.
