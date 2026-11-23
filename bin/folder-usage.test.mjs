import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "folder-usage.py");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "folder-usage-test-"));
const home = path.join(tmp, "home");
const repo = path.join(home, "Projects", "cook-meter");
const state = path.join(tmp, "state");
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const recent = iso(now - 24 * 60 * 60 * 1000);
const old = iso(now - 8 * 24 * 60 * 60 * 1000);
const mkdir = (p) => fs.mkdirSync(p, { recursive: true });

mkdir(path.join(repo, ".git"));
const claudeDir = path.join(home, ".claude", "projects", "project");
mkdir(claudeDir);
const claudeEvent = {
  type: "assistant", sessionId: "claude-session", cwd: repo, timestamp: recent, requestId: "request-1",
  message: { id: "message-1", model: "sonnet", usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 } },
};
fs.writeFileSync(path.join(claudeDir, "session.jsonl"), JSON.stringify(claudeEvent) + "\n" + JSON.stringify(claudeEvent) + "\n");

const grokDir = path.join(home, ".grok", "sessions", "workspace", "grok-session");
mkdir(grokDir);
fs.writeFileSync(path.join(grokDir, "summary.json"), JSON.stringify({ info: { cwd: repo } }));
const grokTurn = { endedAt: recent, modelUsage: { model: { inputTokens: 100, cachedReadTokens: 20, outputTokens: 10, cacheCreationTokens: 5 } } };
fs.writeFileSync(path.join(grokDir, "usage.json"), JSON.stringify({ sessionId: "grok-session", turns: [grokTurn] }));
const grokFork = path.join(home, ".grok", "sessions", "workspace", "grok-fork");
mkdir(grokFork);
fs.writeFileSync(path.join(grokFork, "summary.json"), JSON.stringify({ info: { cwd: repo } }));
fs.writeFileSync(path.join(grokFork, "usage.json"), JSON.stringify({ sessionId: "grok-fork", turns: [grokTurn] }));

const codexDir = path.join(home, ".codex", "sessions", "2026", "11", "23");
mkdir(codexDir);
const codexUsage = {
  input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 0,
  output_tokens: 30, reasoning_output_tokens: 0, total_tokens: 130,
};
fs.writeFileSync(path.join(codexDir, "rollout-2026-11-23T12-00-00-codex-session.jsonl"), [
  { type: "session_meta", payload: { id: "codex-session", cwd: repo, model_provider: "openai" } },
  { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: codexUsage, total_token_usage: codexUsage } }, timestamp: recent },
].map((row) => JSON.stringify(row)).join("\n") + "\n");

const dbSetup = `
import json, os, sqlite3
root = os.environ["FIXTURE_ROOT"]
repo = os.environ["FIXTURE_REPO"]
recent = os.environ["FIXTURE_RECENT"]
old = os.environ["FIXTURE_OLD"]
def db(path, sql, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    conn = sqlite3.connect(path)
    conn.executescript(sql)
    conn.executemany(*rows)
    conn.commit(); conn.close()
copilot = os.path.join(root, "copilot", "session-store.db")
db(copilot,
   "CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT); CREATE TABLE assistant_usage_events (session_id TEXT, created_at TEXT, total_nano_aiu INTEGER);",
   ("INSERT INTO sessions VALUES (?,?)", [("copilot-session", repo)]))
conn = sqlite3.connect(copilot)
conn.executemany("INSERT INTO assistant_usage_events VALUES (?,?,?)", [
    ("copilot-session", recent, 1_250_000_000), ("copilot-session", old, 10_000_000_000)])
conn.commit(); conn.close()
devin = os.path.join(root, "devin", "sessions.db")
db(devin,
   "CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT); CREATE TABLE message_nodes (session_id TEXT, created_at TEXT, chat_message TEXT);",
   ("INSERT INTO sessions VALUES (?,?)", [("devin-session", repo)]))
conn = sqlite3.connect(devin)
conn.executemany("INSERT INTO message_nodes VALUES (?,?,?)", [
    ("devin-session", recent, json.dumps({"metadata":{"metrics":{"input_tokens":100,"output_tokens":10,"cache_read_tokens":20,"cache_creation_tokens":5}}})),
    ("devin-session", old, json.dumps({"metadata":{"metrics":{"input_tokens":1000}}}))])
conn.commit(); conn.close()
opencode = os.path.join(root, "opencode.db")
db(opencode,
   "CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT); CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, data TEXT, time_created INTEGER);",
   ("INSERT INTO session_v2 VALUES (?,?)", [("opencode-session", repo)]))
conn = sqlite3.connect(opencode)
conn.execute("INSERT INTO session_message VALUES (?,?,?,?,?)", (
    "message-1", "opencode-session", "assistant",
    json.dumps({"model":{"providerID":"openai","id":"gpt"},"time":{"created":recent},
                "tokens":{"input":50,"output":20,"reasoning":5,"cache":{"read":10,"write":3}}}),
    int(__import__("datetime").datetime.fromisoformat(recent.replace("Z","+00:00")).timestamp()*1000)))
conn.commit(); conn.close()
`;
const setup = spawnSync("python3", ["-c", dbSetup], {
  encoding: "utf8",
  env: { ...process.env, FIXTURE_ROOT: tmp, FIXTURE_REPO: repo, FIXTURE_RECENT: recent, FIXTURE_OLD: old },
});
assert.equal(setup.status, 0, setup.stderr);

const env = {
  ...process.env,
  HOME: home,
  XDG_STATE_HOME: path.join(tmp, "xdg-state"),
  XDG_DATA_HOME: path.join(tmp, "xdg-data"),
  FOLDER_USAGE_STATE_DIR: state,
  FOLDER_USAGE_NOW_MS: String(now),
  CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
  GROK_HOME: path.join(home, ".grok"),
  COPILOT_HOME: path.join(tmp, "copilot"),
  DEVIN_DATA_DIR: path.join(tmp, "devin"),
  OPENCODE_DB: path.join(tmp, "opencode.db"),
  CODEX_HOME: path.join(home, ".codex"),
};
const result = spawnSync("python3", [script, "--force"], { encoding: "utf8", env });
assert.equal(result.status, 0, result.stderr);
const snapshot = JSON.parse(fs.readFileSync(path.join(state, "folder-usage.json"), "utf8"));
const byAgent = new Map(snapshot.records.map((record) => [record.agent, record]));
assert.deepEqual([...byAgent.keys()].sort(), ["claude", "codex", "copilot", "devin", "grok", "opencode"]);
for (const record of snapshot.records) assert.equal(record.folder, repo);
assert.equal(byAgent.get("claude").amount, 135, "Claude duplicate request rows count once");
assert.equal(byAgent.get("grok").amount, 115, "Grok fork copies count once");
assert.equal(byAgent.get("codex").amount, 130);
assert.equal(byAgent.get("codex").time, Date.parse(recent), "Codex records retain the usage event time");
assert.equal(byAgent.get("copilot").amount, 1.25);
assert.equal(byAgent.get("copilot").unit, "AIC");
assert.equal(byAgent.get("devin").amount, 135, "Devin only includes recent message usage");
assert.equal(byAgent.get("opencode").amount, 88);
const snapshotMtime = fs.statSync(path.join(state, "folder-usage.json")).mtimeMs;
const cached = spawnSync("python3", [script], { encoding: "utf8", env });
assert.equal(cached.status, 0, cached.stderr);
assert.equal(fs.statSync(path.join(state, "folder-usage.json")).mtimeMs, snapshotMtime, "fresh snapshots avoid rescanning");

const qml = fs.readFileSync(path.join(here, "..", "Panel.qml"), "utf8");
assert.match(qml, /function folderUsageEntries\(folder\)/);
assert.match(qml, /if \(a === first\) return -1/, "the agent being started is listed first");
assert.match(qml, /if \(a === "copilot"\) return -1\n\s*if \(b === "copilot"\) return 1/, "Copilot is next so its usage remains visible");
assert.match(qml, /FolderUsageLine \{ width: parent\.width; entries: repoChip\.usageItems; active: !fp\.forSquad \}/, "only the Start picker shows folder usage");
const homeChip = qml.match(/id: homeChip([\s\S]*?)\n\s*Repeater \{/)?.[1];
assert.ok(homeChip, "the No project option exists");
assert.doesNotMatch(homeChip, /folderUsageEntries|FolderUsageLine/, "the No project option never shows usage");
assert.match(qml, /folderUsageRefresh\.running = true/, "usage refresh starts asynchronously when Start opens");

fs.rmSync(tmp, { recursive: true });
console.log("folder-usage: all tests passed");
