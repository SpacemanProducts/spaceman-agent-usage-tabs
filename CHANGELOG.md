# Changelog

Bump the version in `manifest.json` and add a line here with every change
(patch for a fix, minor for a feature).

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
