#!/usr/bin/env python3
"""Persist Start-picker folder pins and explicit hides."""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any


VERSION = 1


class PreferenceError(RuntimeError):
  pass


def state_path() -> Path:
  state_home = Path(os.environ.get("XDG_STATE_HOME") or (Path.home() / ".local/state"))
  return state_home / "omarchy" / "agent-usage-tabs" / "folder-preferences.json"


def absolute_path(value: str) -> str:
  if not value or not os.path.isabs(value):
    raise PreferenceError("folder path must be absolute")
  return os.path.normpath(value)


def defaults() -> dict[str, Any]:
  home = Path.home()
  defaults = [
    home / "Projects" / "Bulk Radar",
    home / ".config" / "omarchy" / "plugins" / "spaceman.agent-usage-tabs",
  ]
  return {"version": VERSION, "pinned": [str(path) for path in defaults if path.is_dir()], "hidden": {}, "restored": []}


def validate(value: Any) -> dict[str, Any]:
  if not isinstance(value, dict) or value.get("version") != VERSION:
    raise PreferenceError("unsupported folder preferences format")
  pinned = value.get("pinned")
  hidden = value.get("hidden")
  restored = value.get("restored", [])
  if not isinstance(pinned, list) or not isinstance(hidden, dict) or not isinstance(restored, list):
    raise PreferenceError("folder preferences must contain pinned, hidden and restored collections")
  normalized_pins = []
  for folder in pinned:
    if not isinstance(folder, str):
      raise PreferenceError("pinned folder paths must be strings")
    folder = absolute_path(folder)
    if folder not in normalized_pins:
      normalized_pins.append(folder)
  normalized_restored = []
  for folder in restored:
    if not isinstance(folder, str):
      raise PreferenceError("restored folder paths must be strings")
    folder = absolute_path(folder)
    if folder not in normalized_restored:
      normalized_restored.append(folder)
  normalized_hidden = {}
  for folder, last_used in hidden.items():
    if not isinstance(folder, str) or isinstance(last_used, bool) or not isinstance(last_used, int) or last_used < 0:
      raise PreferenceError("hidden folders must map absolute paths to non-negative timestamps")
    normalized_hidden[absolute_path(folder)] = last_used
  return {"version": VERSION, "pinned": normalized_pins, "hidden": normalized_hidden, "restored": normalized_restored}


def save(path: Path, value: dict[str, Any]) -> None:
  path.parent.mkdir(parents=True, exist_ok=True)
  fd, temporary = tempfile.mkstemp(prefix=".folder-preferences-", dir=path.parent)
  try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
      json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))
      handle.write("\n")
      handle.flush()
      os.fsync(handle.fileno())
    os.replace(temporary, path)
  except OSError:
    try:
      os.close(fd)
    except OSError:
      pass
    try:
      os.unlink(temporary)
    except OSError:
      pass
    raise


def load(path: Path) -> dict[str, Any]:
  if not path.exists():
    value = defaults()
    save(path, value)
    return value
  try:
    if path.stat().st_size > 1_000_000:
      raise PreferenceError("folder preferences file is too large")
    with path.open(encoding="utf-8") as handle:
      return validate(json.load(handle))
  except (OSError, json.JSONDecodeError) as exc:
    raise PreferenceError(f"couldn't read folder preferences: {exc}") from exc


def main(argv: list[str]) -> int:
  if not argv:
    raise PreferenceError("usage: folder-preferences.py list | pin|unpin|hide|restore PATH")
  path = state_path()
  prefs = load(path)
  action = argv[0]
  if action == "list" and len(argv) == 1:
    print(json.dumps(prefs, ensure_ascii=False, separators=(",", ":")))
    return 0
  if action in ("pin", "unpin") and len(argv) == 2:
    folder = absolute_path(argv[1])
    if action == "pin" and folder not in prefs["pinned"]:
      prefs["pinned"].append(folder)
    if action == "unpin":
      prefs["pinned"] = [pinned for pinned in prefs["pinned"] if pinned != folder]
  elif action == "hide" and len(argv) == 3:
    folder = absolute_path(argv[1])
    try:
      last_used = int(argv[2])
    except ValueError as exc:
      raise PreferenceError("hide timestamp must be an integer") from exc
    if last_used < 0:
      raise PreferenceError("hide timestamp must be non-negative")
    prefs["hidden"][folder] = last_used
    prefs["pinned"] = [pinned for pinned in prefs["pinned"] if pinned != folder]
  elif action == "restore" and len(argv) in (2, 3) and (len(argv) == 2 or argv[2] == "--pin"):
    folder = absolute_path(argv[1])
    prefs["hidden"].pop(folder, None)
    if folder not in prefs["restored"]:
      prefs["restored"].append(folder)
    if len(argv) == 3 and folder not in prefs["pinned"]:
      prefs["pinned"].append(folder)
  else:
    raise PreferenceError("invalid folder preference operation")
  save(path, prefs)
  print(json.dumps(prefs, ensure_ascii=False, separators=(",", ":")))
  return 0


if __name__ == "__main__":
  try:
    raise SystemExit(main(sys.argv[1:]))
  except PreferenceError as exc:
    print(f"folder preferences: {exc}", file=sys.stderr)
    raise SystemExit(1)
