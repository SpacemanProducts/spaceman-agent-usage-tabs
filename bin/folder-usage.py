#!/usr/bin/env python3
"""Cache recent per-session usage only for sources with a confirmed cwd."""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from datetime import date, datetime, time as day_time, timedelta
from pathlib import Path
from typing import Any


WINDOW_DAYS = 7
CACHE_MS = 5 * 60 * 1000
NANO_AIU = 1_000_000_000


class UsageError(RuntimeError):
  pass


def obj(value: Any) -> dict[str, Any]:
  return value if isinstance(value, dict) else {}


def number(value: Any) -> float:
  if isinstance(value, bool):
    return 0
  try:
    result = float(value)
  except (TypeError, ValueError, OverflowError):
    return 0
  return result if result > 0 else 0


def time_ms(value: Any) -> int | None:
  if isinstance(value, (int, float)) and not isinstance(value, bool):
    amount = float(value)
    if amount > 10**12:
      return int(amount)
    if amount > 0:
      return int(amount * 1000)
    return None
  if not isinstance(value, str) or not value.strip():
    return None
  try:
    parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
  except ValueError:
    return None
  if parsed.tzinfo is None:
    parsed = parsed.astimezone()
  return int(parsed.timestamp() * 1000)


def absolute_folder(value: Any) -> str | None:
  if not isinstance(value, str) or not value.strip() or not os.path.isabs(value.strip()):
    return None
  folder = os.path.normpath(value.strip())
  return folder if os.path.isdir(folder) else None


def session_key(value: Any) -> str:
  return str(value).strip() if value is not None else ""


class Usage:
  def __init__(self, cutoff: int, now: int) -> None:
    self.cutoff = cutoff
    self.now = now
    self.sessions: dict[tuple[str, str, str], dict[str, Any]] = {}

  def add(
    self, agent: str, folder: Any, session: Any, amount: float, unit: str,
    at: int | None, recorded_at: int | None = None, started: int | None = None,
  ) -> None:
    folder_name = absolute_folder(folder)
    session_name = session_key(session)
    amount = number(amount)
    if not folder_name or not session_name or amount <= 0 or at is None or not self.cutoff <= at <= self.now:
      return
    recorded_at = recorded_at if recorded_at is not None and self.cutoff <= recorded_at <= self.now else at
    # "start" is the session's earliest usage record (or, for Codex, its own start time), so a
    # Constance job can be matched to the session it launched by folder and start time.
    started = started if started is not None and self.cutoff <= started <= self.now else at
    key = (agent, folder_name, session_name)
    record = self.sessions.setdefault(key, {
      "folder": folder_name, "agent": agent, "session": session_name, "amount": 0.0, "unit": unit, "time": recorded_at,
      "start": started,
    })
    record["start"] = min(record["start"], started)
    if record["unit"] != unit:
      raise UsageError(f"{agent} reported inconsistent units in one session")
    record["amount"] += amount
    record["time"] = max(record["time"], recorded_at)

  def records(self) -> list[dict[str, Any]]:
    records = []
    for key in sorted(self.sessions):
      row = self.sessions[key]
      amount = round(row["amount"], 6) if row["unit"] == "AIC" else int(row["amount"])
      records.append({**row, "amount": amount})
    return records


def read_json(path: Path) -> dict[str, Any]:
  try:
    value = json.loads(path.read_text(encoding="utf-8", errors="replace"))
  except (OSError, ValueError):
    return {}
  return obj(value)


def collect_claude(usage: Usage) -> None:
  root = Path(os.environ.get("CLAUDE_CONFIG_DIR") or (Path.home() / ".claude")) / "projects"
  if not root.is_dir():
    return
  seen: set[tuple[str, str, str]] = set()
  for path in root.rglob("*.jsonl"):
    try:
      with path.open("r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
          if '"usage"' not in line:
            continue
          try:
            event = json.loads(line)
          except (ValueError, RecursionError):
            continue
          if not isinstance(event, dict):
            continue
          message = obj(event.get("message"))
          tokens = obj(message.get("usage"))
          at = time_ms(event.get("timestamp"))
          folder = event.get("cwd")
          if not tokens or not at:
            continue
          model = str(message.get("model") or "")
          if model == "<synthetic>":
            continue
          session = str(event.get("sessionId") or path.stem)
          message_id, request_id = str(message.get("id") or ""), str(event.get("requestId") or "")
          if message_id or request_id:
            unique = (session, message_id, request_id)
            if unique in seen:
              continue
            seen.add(unique)
          amount = sum(number(tokens.get(key)) for key in (
            "input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens",
          ))
          usage.add("claude", folder, session, amount, "tokens", at)
    except OSError as exc:
      raise UsageError(f"couldn't read Claude transcript {path}: {exc}") from exc


def collect_grok(usage: Usage) -> None:
  root = Path(os.environ.get("GROK_HOME") or (Path.home() / ".grok")) / "sessions"
  if not root.is_dir():
    return
  seen: set[str] = set()
  for session_dir in root.glob("*/*"):
    summary = read_json(session_dir / "summary.json")
    folder = obj(summary.get("info")).get("cwd")
    session = ""
    data = read_json(session_dir / "usage.json")
    session = session_key(data.get("sessionId")) or session_dir.name
    turns = data.get("turns")
    for turn in turns if isinstance(turns, list) else []:
      if not isinstance(turn, dict):
        continue
      at = time_ms(turn.get("endedAt"))
      model_usage = obj(turn.get("modelUsage"))
      if not at:
        continue
      signature = json.dumps([turn.get("endedAt"), model_usage], sort_keys=True, default=str)
      if signature in seen:
        continue
      seen.add(signature)
      amount = 0
      for bucket in model_usage.values():
        bucket = obj(bucket)
        input_tokens = number(bucket.get("inputTokens"))
        cached = min(input_tokens, number(bucket.get("cachedReadTokens")))
        amount += input_tokens + number(bucket.get("outputTokens")) + number(bucket.get("cacheCreationTokens"))
        if cached > input_tokens:
          amount += cached - input_tokens
      usage.add("grok", folder, session, amount, "tokens", at)


def readonly_db(path: Path) -> sqlite3.Connection | None:
  if not path.is_file():
    return None
  try:
    conn = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=2)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only = ON")
    return conn
  except sqlite3.Error as exc:
    raise UsageError(f"couldn't read usage database {path}: {exc}") from exc


def tables(conn: sqlite3.Connection) -> set[str]:
  return {str(row[0]) for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}


def columns(conn: sqlite3.Connection, table: str) -> set[str]:
  return {str(row[1]) for row in conn.execute(f'PRAGMA table_info("{table}")')}


def copilot_path() -> Path:
  return Path(os.environ.get("COPILOT_HOME") or (Path.home() / ".copilot")) / "session-store.db"


def collect_copilot(usage: Usage) -> None:
  conn = readonly_db(copilot_path())
  if conn is None:
    return
  try:
    available = tables(conn)
    event_columns = columns(conn, "assistant_usage_events")
    session_columns = columns(conn, "sessions")
    needed_events = {"session_id", "created_at", "total_nano_aiu"}
    if "assistant_usage_events" not in available or not needed_events <= event_columns:
      raise UsageError("Copilot usage store has no per-request AI-credit records")
    if "sessions" not in available or not {"id", "cwd"} <= session_columns:
      raise UsageError("Copilot usage sessions have no confirmed cwd mapping")
    rows = conn.execute(
      "SELECT e.session_id, e.created_at, e.total_nano_aiu, s.cwd "
      "FROM assistant_usage_events e JOIN sessions s ON s.id = e.session_id"
    )
    for row in rows:
      at = time_ms(row["created_at"])
      amount = number(row["total_nano_aiu"]) / NANO_AIU
      usage.add("copilot", row["cwd"], row["session_id"], amount, "AIC", at)
  except sqlite3.Error as exc:
    raise UsageError(f"couldn't read Copilot usage store: {exc}") from exc
  finally:
    conn.close()


def devin_paths() -> list[Path]:
  data_dir = Path(os.environ.get("DEVIN_DATA_DIR") or (
    Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local/share")) / "devin" / "cli"
  ))
  primary = data_dir / "sessions.db"
  if primary.is_file():
    return [primary]
  root = Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local/share")) / "devin"
  return [path for path in (root / "cli_sessions.db", root / "sessions.db") if path.is_file()]


def collect_devin(usage: Usage) -> None:
  for path in devin_paths():
    conn = readonly_db(path)
    if conn is None:
      continue
    try:
      available = tables(conn)
      if "message_nodes" not in available or "sessions" not in available:
        continue
      message_columns, session_columns = columns(conn, "message_nodes"), columns(conn, "sessions")
      if not {"session_id", "created_at", "chat_message"} <= message_columns:
        continue
      if not {"id", "working_directory"} <= session_columns:
        raise UsageError("Devin usage sessions have no confirmed working-directory mapping")
      rows = conn.execute(
        "SELECT m.session_id, m.created_at, m.chat_message, s.working_directory "
        "FROM message_nodes m JOIN sessions s ON s.id = m.session_id "
        "WHERE m.chat_message LIKE '%\"metrics\"%'"
      )
      for row in rows:
        at = time_ms(row["created_at"])
        if not at:
          continue
        try:
          message = obj(json.loads(row["chat_message"]))
        except (ValueError, TypeError, RecursionError):
          continue
        metrics = obj(obj(message.get("metadata")).get("metrics"))
        amount = sum(number(metrics.get(key)) for key in (
          "input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens",
        ))
        usage.add("devin", row["working_directory"], row["session_id"], amount, "tokens", at)
    except sqlite3.Error as exc:
      raise UsageError(f"couldn't read Devin usage database {path}: {exc}") from exc
    finally:
      conn.close()


def opencode_path() -> Path:
  configured = os.environ.get("OPENCODE_DB", "").strip()
  if configured:
    candidate = Path(configured).expanduser()
    return candidate if candidate.is_absolute() else (
      Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local/share")) / "opencode" / candidate
    )
  return Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local/share")) / "opencode" / "opencode.db"


def opencode_amount(value: Any) -> float:
  entry = obj(value)
  tokens = obj(entry.get("tokens"))
  cache = obj(tokens.get("cache"))
  return sum(number(item) for item in (
    tokens.get("input"), tokens.get("output"), tokens.get("reasoning"), cache.get("read"), cache.get("write"),
  ))


def collect_opencode(usage: Usage) -> None:
  conn = readonly_db(opencode_path())
  if conn is None:
    return
  try:
    available = tables(conn)
    seen: set[str] = set()
    if "session_message" in available and "session_v2" in available:
      message_columns, session_columns = columns(conn, "session_message"), columns(conn, "session_v2")
      if {"id", "session_id", "type", "data"} <= message_columns and {"id", "directory"} <= session_columns:
        rows = conn.execute(
          "SELECT m.id, m.session_id, m.type, m.data, m.time_created, s.directory "
          "FROM session_message m JOIN session_v2 s ON s.id = m.session_id "
          "WHERE m.type IN ('assistant', 'compaction')"
          if "time_created" in message_columns else
          "SELECT m.id, m.session_id, m.type, m.data, NULL, s.directory "
          "FROM session_message m JOIN session_v2 s ON s.id = m.session_id "
          "WHERE m.type IN ('assistant', 'compaction')"
        )
        for row in rows:
          if str(row["id"]) in seen:
            continue
          try:
            entry = obj(json.loads(row["data"]))
          except (ValueError, TypeError, RecursionError):
            continue
          at = time_ms(obj(entry.get("time")).get("created")) or time_ms(row["time_created"])
          amount = opencode_amount(entry)
          if amount > 0:
            seen.add(str(row["id"]))
            usage.add("opencode", row["directory"], row["session_id"], amount, "tokens", at)
    if "message" in available and "session" in available:
      message_columns, session_columns = columns(conn, "message"), columns(conn, "session")
      if {"session_id", "data"} <= message_columns and {"id", "directory"} <= session_columns:
        id_column = "m.id" if "id" in message_columns else "m.rowid"
        created_column = "m.time_created" if "time_created" in message_columns else "NULL"
        rows = conn.execute(
          f"SELECT {id_column} AS id, m.session_id, m.data, {created_column} AS time_created, s.directory "
          "FROM message m JOIN session s ON s.id = m.session_id"
        )
        for row in rows:
          if str(row["id"]) in seen:
            continue
          try:
            entry = obj(json.loads(row["data"]))
          except (ValueError, TypeError, RecursionError):
            continue
          if entry.get("role") not in ("assistant", "compaction"):
            continue
          at = time_ms(obj(entry.get("time")).get("created")) or time_ms(row["time_created"])
          amount = opencode_amount(entry)
          if amount > 0:
            seen.add(str(row["id"]))
            usage.add("opencode", row["directory"], row["session_id"], amount, "tokens", at)
  except sqlite3.Error as exc:
    raise UsageError(f"couldn't read OpenCode usage database: {exc}") from exc
  finally:
    conn.close()


def codex_home() -> Path:
  return Path(os.environ.get("CODEX_HOME") or (Path.home() / ".codex"))


def codex_metadata(path: Path, collectors: Any) -> tuple[str | None, dict[str, int], int | None]:
  folder = None
  started = None
  latest: dict[str, int] = {}
  with collectors._codex_open(path) as handle:
    for raw in handle:
      if not any(marker in raw for marker in (b'"session_meta"', b'"token_usage_record"', b'"token_count"')):
        continue
      try:
        entry = json.loads(raw)
      except (ValueError, RecursionError):
        continue
      if not isinstance(entry, dict):
        continue
      if folder is None and entry.get("type") == "session_meta":
        meta = obj(entry.get("payload"))
        folder = meta.get("cwd")
        started = time_ms(meta.get("timestamp")) or time_ms(entry.get("timestamp"))
      payload = obj(entry.get("payload"))
      if entry.get("type") == "token_usage_record" or payload.get("type") == "token_count":
        at = time_ms(entry.get("timestamp"))
        if at:
          day = datetime.fromtimestamp(at / 1000).astimezone().date().isoformat()
          latest[day] = max(latest.get(day, 0), at)
  return absolute_folder(folder), latest, started


def collect_codex(usage: Usage) -> None:
  home = codex_home()
  if not any((home / name).is_dir() for name in ("sessions", "archived_sessions")):
    return
  sys.path.insert(0, "/usr/share/omarchy/shell/plugins/agents")
  try:
    import collectors
  except ImportError as exc:
    raise UsageError(f"Omarchy's Codex session reader is unavailable: {exc}") from exc
  cache = collectors.codex_rollout_cache()
  records, complete = collectors.codex_rollouts(cache, reuse=True, native=True)
  if not complete:
    raise UsageError("Codex session scan was incomplete; keeping the previous folder-usage snapshot")
  for name, record in records.items():
    session = session_key(record.get("session"))
    days = obj(record.get("days"))
    if not session or not days:
      continue
    folder, latest, started = codex_metadata(Path(name), collectors)
    if not folder:
      continue
    for day_name, models in days.items():
      try:
        day = date.fromisoformat(day_name)
      except (TypeError, ValueError):
        continue
      day_time_ms = int(datetime.combine(day, day_time.min).astimezone().timestamp() * 1000)
      amount = 0
      for totals in obj(models).values():
        if isinstance(totals, list):
          amount += sum(number(value) for value in totals[:4])
      usage.add("codex", folder, session, amount, "tokens", day_time_ms, latest.get(day_name), started)


def state_path() -> Path:
  if value := os.environ.get("FOLDER_USAGE_STATE_DIR"):
    return Path(value).expanduser() / "folder-usage.json"
  root = Path(os.environ.get("XDG_STATE_HOME") or (Path.home() / ".local/state"))
  return root / "omarchy" / "agent-usage-tabs" / "folder-usage.json"


def time_bounds(now: int) -> tuple[int, int]:
  local_now = datetime.fromtimestamp(now / 1000).astimezone()
  first_day = local_now.date() - timedelta(days=WINDOW_DAYS - 1)
  start = datetime.combine(first_day, day_time.min).astimezone()
  return int(start.timestamp() * 1000), now


def refresh(path: Path, force: bool) -> None:
  now = int(os.environ.get("FOLDER_USAGE_NOW_MS") or time.time() * 1000)
  if not force:
    existing = read_json(path)
    refreshed = time_ms(existing.get("refreshedAt"))
    if refreshed and 0 <= now - refreshed < CACHE_MS:
      return
  cutoff, now = time_bounds(now)
  usage = Usage(cutoff, now)
  collect_claude(usage)
  collect_grok(usage)
  collect_copilot(usage)
  collect_devin(usage)
  collect_opencode(usage)
  collect_codex(usage)
  path.parent.mkdir(parents=True, exist_ok=True)
  temporary = path.with_suffix(".json.tmp")
  temporary.write_text(json.dumps({"version": 1, "refreshedAt": now, "records": usage.records()}, separators=(",", ":")) + "\n", encoding="utf-8")
  temporary.chmod(0o600)
  temporary.replace(path)


def main() -> int:
  parser = argparse.ArgumentParser()
  parser.add_argument("--force", action="store_true")
  args = parser.parse_args()
  try:
    refresh(state_path(), args.force)
  except (UsageError, OSError, sqlite3.Error) as exc:
    print(f"folder-usage: {exc}", file=sys.stderr)
    return 1
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
