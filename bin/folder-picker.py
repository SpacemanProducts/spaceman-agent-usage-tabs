#!/usr/bin/env python3
"""Group Start-picker folders into project roots and separate system/tool clutter."""

from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any


WINDOW_DAYS = 7
PROJECT_MARKERS = (
    ".git",
    "package.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "Gemfile",
    "composer.json",
    "deno.json",
    "tsconfig.json",
)

HOME_S = os.path.normpath(str(Path.home()))
HOME = Path(HOME_S)
STATE = (Path(os.environ.get("XDG_STATE_HOME") or (HOME / ".local/state")).expanduser()
         / "omarchy" / "agent-usage-tabs")


def norm(value: Any) -> str | None:
  if not isinstance(value, str):
    return None
  value = value.strip()
  if not value or not os.path.isabs(value):
    return None
  return os.path.normpath(value)


def is_within(path: str, root: str) -> bool:
  return path == root or path.startswith(root + os.sep)


def has_project_marker(path: Path) -> bool:
  try:
    return any((path / marker).exists() for marker in PROJECT_MARKERS)
  except OSError:
    return False


def project_root(path: str, roots: set[str]) -> str:
  """Outermost project root at or below home; home itself is the boundary, not a parent project."""
  if path == HOME_S:
    return HOME_S
  boundary = HOME_S if is_within(path, HOME_S) else None
  current = Path(path)
  marker = None
  while True:
    if boundary is not None and str(current) == boundary:
      break
    if has_project_marker(current):
      marker = str(current)
    parent = current.parent
    if str(parent) == str(current):
      break
    current = parent
  if marker is not None:
    return marker
  current = Path(path)
  while True:
    if boundary is not None and str(current) == boundary:
      break
    current_s = str(current)
    if current_s in roots:
      return current_s
    parent = current.parent
    if str(parent) == current_s:
      break
    current = parent
  return path


def backup_name(name: str) -> bool:
  lower = name.lower()
  return ("backup" in lower or ".bak" in lower or "-before-" in lower
          or re.search(r"-pre[a-z]+$", lower) is not None
          or re.search(r"-20\d{2}-\d{2}-\d{2}", lower) is not None)


def system_root(path: str) -> str | None:
  """The hidden system/tool folder a path belongs to, or None for ordinary folders."""
  if path == HOME_S or not is_within(path, HOME_S):
    return None
  parts = os.path.relpath(path, HOME_S).split(os.sep)
  first = parts[0]
  if first.startswith("."):
    if first == ".local":
      if len(parts) > 1 and parts[1] == "state":
        return str(HOME / ".local" / "state")
      return str(HOME / ".local")
    if first == ".config":
      if len(parts) > 1 and parts[1] == "omarchy":
        return str(HOME / ".config" / "omarchy")
      return str(HOME / ".config")
    return str(HOME / first)
  if backup_name(first):
    return str(HOME / first)
  return None


def read_json(path: Path) -> dict[str, Any]:
  try:
    value = json.loads(path.read_text(encoding="utf-8", errors="replace"))
  except (OSError, ValueError):
    return {}
  return value if isinstance(value, dict) else {}


def read_lines(path: Path) -> list[str]:
  try:
    return [line.strip() for line in path.read_text(encoding="utf-8", errors="replace").splitlines() if line.strip()]
  except OSError:
    return []


def clean_paths(values: Any) -> list[str]:
  out = []
  for value in values if isinstance(values, list) else []:
    folder = norm(value)
    if folder and folder not in out:
      out.append(folder)
  return out


def load_preferences() -> tuple[list[str], dict[str, int], list[str]]:
  data = read_json(STATE / "folder-preferences.json")
  pinned = clean_paths(data.get("pinned"))
  restored = clean_paths(data.get("restored"))
  hidden_raw = data.get("hidden")
  hidden: dict[str, int] = {}
  if isinstance(hidden_raw, dict):
    for folder, last_used in hidden_raw.items():
      normalized = norm(folder)
      if normalized is None or isinstance(last_used, bool):
        continue
      try:
        at = int(last_used)
      except (TypeError, ValueError):
        continue
      if at >= 0:
        hidden[normalized] = max(hidden.get(normalized, 0), at)
  return pinned, hidden, restored


def picked_paths() -> list[str]:
  paths = []
  for name in ("start-picks", "squad-recent"):
    paths.extend(read_lines(STATE / name))
  squad_dir = read_lines(STATE / "squad-dir")
  if squad_dir:
    paths.append(squad_dir[0])
  return clean_paths(paths)


def as_ms(value: Any) -> int | None:
  if isinstance(value, bool):
    return None
  if isinstance(value, (int, float)):
    amount = float(value)
    if amount > 10**12:
      return int(amount)
    if amount > 0:
      return int(amount * 1000)
    return None
  if isinstance(value, str) and value.strip():
    try:
      from datetime import datetime
      parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
      return int(parsed.timestamp() * 1000)
    except ValueError:
      return None
  return None


def activity_by_folder(now: int) -> dict[str, int]:
  data = read_json(STATE / "folder-usage.json")
  refreshed = as_ms(data.get("refreshedAt"))
  if refreshed is None or refreshed < 0 or refreshed > now + 60_000 or now - refreshed > WINDOW_DAYS * 86_400_000:
    return {}
  cutoff = now - WINDOW_DAYS * 86_400_000
  latest: dict[str, int] = {}
  records = data.get("records")
  for record in records if isinstance(records, list) else []:
    if not isinstance(record, dict):
      continue
    folder = norm(record.get("folder"))
    at = as_ms(record.get("time"))
    if folder is None or at is None or at < cutoff or at > now + 60_000:
      continue
    latest[folder] = max(latest.get(folder, 0), at)
  return latest


def scan(paths: list[str], keep: list[str]) -> dict[str, Any]:
  pinned, hidden, restored = load_preferences()
  picked = picked_paths()
  keep_n = set(clean_paths(keep))
  explicit_roots = keep_n | set(pinned) | set(picked)
  activity = activity_by_folder(int(os.environ.get("FOLDER_PICKER_NOW_MS") or time.time() * 1000))

  candidates: list[str] = []
  seen: set[str] = set()

  def add(folder: Any) -> None:
    normalized = norm(folder)
    if normalized and normalized not in seen:
      seen.add(normalized)
      candidates.append(normalized)

  for folder in paths:
    add(folder)
  for folder in activity:
    add(folder)
  for folder in pinned:
    add(folder)
  for folder in hidden:
    add(folder)
  for folder in restored:
    add(folder)
  for folder in picked:
    add(folder)
  for folder in keep_n:
    add(folder)

  def group_key(path: str) -> str:
    project = project_root(path, explicit_roots)
    system = system_root(project)
    explicit = project in explicit_roots or (
      has_project_marker(Path(project)) and any(is_within(root, project) for root in explicit_roots)
    )
    return system if system and not explicit else project

  groups: dict[str, dict[str, Any]] = {}
  for candidate in candidates:
    folder = group_key(candidate)
    group = groups.setdefault(folder, {
      "folder": folder,
      "sources": set(),
      "pinned": False,
      "picked": False,
      "restored": False,
      "keep": folder in keep_n,
      "project": has_project_marker(Path(folder)),
      "system": system_root(folder) is not None,
      "activity": 0,
      "hiddenAt": None,
    })
    group["sources"].add(candidate)

  for folder in pinned:
    key = group_key(folder)
    if key in groups:
      groups[key]["pinned"] = True
  for folder in picked:
    key = group_key(folder)
    if key in groups:
      groups[key]["picked"] = True
  for folder in restored:
    key = group_key(folder)
    if key in groups:
      groups[key]["restored"] = True
  for folder, last_used in hidden.items():
    key = group_key(folder)
    if key in groups:
      previous = groups[key]["hiddenAt"]
      groups[key]["hiddenAt"] = last_used if previous is None else max(previous, last_used)

  folders = []
  for group in groups.values():
    activity_for_group = max((activity.get(source, 0) for source in group["sources"]), default=0)
    group["activity"] = activity_for_group
    group["sources"] = sorted(group["sources"])
    folders.append(group)
  return {"version": 1, "home": HOME_S, "folders": folders}


def main(argv: list[str]) -> int:
  if not argv or argv[0] != "scan":
    print("usage: folder-picker.py scan [--keep PATH]... [FOLDER]...", file=sys.stderr)
    return 2
  keep: list[str] = []
  paths: list[str] = []
  args = argv[1:]
  index = 0
  while index < len(args):
    if args[index] == "--keep" and index + 1 < len(args):
      keep.append(args[index + 1])
      index += 2
    else:
      paths.append(args[index])
      index += 1
  print(json.dumps(scan(paths, keep), ensure_ascii=False, separators=(",", ":")))
  return 0


if __name__ == "__main__":
  raise SystemExit(main(sys.argv[1:]))
