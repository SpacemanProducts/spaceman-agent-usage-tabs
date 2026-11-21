# Changelog

Bump the version in `manifest.json` and add a line here with every change
(patch for a fix, minor for a feature).

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
