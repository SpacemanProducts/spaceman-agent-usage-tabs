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
assert.match(qml, /folderPickerEntries\.forEach\(function\(entry, index\) \{\s*if \(entry\.folder === root\.home\) return\s*if \(folderEntryVisible\(entry\)\) ranked\.push/, "the visible list comes from grouped picker entries, with home left to the No project chip");
assert.match(qml, /if \(aPinned !== bPinned\) return aPinned \? -1 : 1/, "pinned folders sort ahead of other active folders");
assert.match(qml, /folderUsageRecords\.forEach\(function\(record\) \{ if \(record && typeof record === "object"\) add\(record\.folder\) \}\)/, "session folders are candidates even when absent from the recent-repository list");
assert.match(qml, /folderPins\.forEach\(add\)[\s\S]*?root\.folderRestored\.forEach\(add\)[\s\S]*?Object\.keys\(hiddenFolderTimes\)\.forEach\(add\)/, "pinned, restored and hidden folders stay candidates");
assert.match(qml, /function hiddenFolderRepos\(\)[\s\S]*?!folderEntryVisible\(entry\)/, "the picker has a restorable hidden-folder model");
assert.match(qml, /bin\/folder-picker\.py", "scan"/, "folder grouping runs through the picker scanner");
assert.match(qml, /var group = root\.folderPickerGroups\[record\.folder\]/, "folder usage rolls up to the grouped project folder");
assert.match(qml, /readonly property real folderChipWidth: Math\.max/, "folder buttons use a shared two-column grid width");
assert.match(qml, /readonly property real folderNameRowHeight:[\s\S]*id: homeChip[\s\S]*height: fp\.folderNameRowHeight/, "No project stays a slim one-line grid button");
assert.match(qml, /readonly property real folderChipHeight:[\s\S]*width: fp\.folderChipWidth\s+height: fp\.folderChipHeight/, "all folder cards share fixed grid dimensions");
const usageBlock = qml.match(/component FolderUsageLine: Item \{([\s\S]*?)\n\s*\}\n\s*component FolderActionButton/)?.[1];
assert.ok(usageBlock, "folder usage line component exists");
assert.match(usageBlock, /fontSizeMode: Text\.HorizontalFit[\s\S]*minimumPixelSize:[\s\S]*wrapMode: Text\.NoWrap[\s\S]*maximumLineCount: 1/, "secondary usage shrinks to fit on one line");
assert.equal((usageBlock.match(/maximumLineCount: 1/g) || []).length, 2, "folder usage stays within two total lines");
assert.match(usageBlock, /implicitHeight: active \? lineHeight \* 2 : 0/, "usage space stays fixed when a folder has no usage");
assert.match(qml, /function folderName\(p\)[\s\S]*?s\.slice\(s\.lastIndexOf\("\/"\) \+ 1\)/, "folder labels use only the last path component");
const repoLabel = qml.match(/id: repoLabel([\s\S]*?)\n\s*\}/)?.[1];
assert.ok(repoLabel, "folder name label exists");
assert.match(repoLabel, /text: fp\.forSquad \?[\s\S]*: root\.folderName\(repoChip\.modelData\)/, "Start project names use their basename");
assert.match(repoLabel, /elide: fp\.forSquad \? Text\.ElideRight : Text\.ElideNone/, "Start project names avoid ellipses");
assert.match(qml, /text: root\.folderName\(hiddenRepoChip\.modelData\)[\s\S]*elide: Text\.ElideNone/, "hidden project names also show their full basename");
assert.match(repoLabel, /horizontalAlignment: fp\.forSquad \? Text\.AlignHCenter : Text\.AlignLeft/, "Start folder names are all left-aligned");
assert.match(qml, /anchors\.left: parent\.left[\s\S]*text: "No project"/, "No project follows the same left alignment");
assert.match(qml, /text: root\.safeTooltipText\(repoChip\.modelData\)/, "hover tooltips retain the full sanitized path");
assert.match(qml, /border\.width: fp\.forSquad \? \(fp\.plainOthers \? \(on \? 2 : 1\) : \(pinned \? 2 : \(on \? 1 : 0\)\)\) : \(on \? 1 : 0\)/, "Start selection uses only a subtle border, not a pinned-card highlight");
assert.match(qml, /fp\.plainOthers \? \(on \? root\.green : root\.soft\(root\.foreground, 0\.3\)\)/, "plain-others pickers highlight only the selected folder, in green");
assert.match(qml, /border\.width: on \? 1 : 0[\s\S]*border\.color: root\.soft\(Color\.accent, 0\.5\)/, "hidden-folder selection also uses a subtle border");
assert.match(qml, /visible: !fp\.forSquad && \(repoHover\.hovered \|\| repoChip\.pinned\)/, "folder actions appear on hover while pinned folders retain a pin");
assert.match(qml, /visible: repoHover\.hovered/, "the hide action only appears while hovering");
assert.match(qml, /onTriggered: root\.hideFolder\(repoChip\.modelData\)/, "each visible folder can be manually hidden");
assert.match(qml, /root\.restoreFolder\(hiddenRepoChip\.modelData\)/, "hidden folders can be restored");
assert.match(qml, /pluginText\("picker\.restoreButton"\)/, "the hidden-folder restore action is labeled, not just an icon");
assert.doesNotMatch(qml, /hiddenRepoPinAction|toggleFolderPin\(hiddenRepoChip/, "hidden folders offer no pin action");
assert.match(qml, /function restoreFolder\(folder\) \{\s*runFolderPreferenceAction\(\["restore", folder\]\)/, "restoring never pins: the folder returns as a normal entry");
assert.match(qml, /entry\.restored/, "restored folders count as visible without pinning");
assert.match(qml, /folderPreferencesRead\.running = true/, "persistent picker preferences load on open");
assert.match(qml, /function safeTooltipText\(value\)[\s\S]*?replace\(\/</, "dynamic folder tooltips neutralize markup");
assert.match(qml, /text: root\.safeTooltipText\(repoChip\.modelData\)/, "folder paths are sanitized before reaching the tooltip component");
const homeChip = qml.match(/id: homeChip([\s\S]*?)\n\s*Repeater \{/)?.[1];
assert.ok(homeChip, "the No project option exists");
assert.doesNotMatch(homeChip, /folderUsageEntries|FolderUsageLine/, "the No project option never shows usage");
assert.match(qml, /folderUsageRefresh\.running = true/, "usage refresh starts asynchronously when Start opens");

fs.rmSync(tmp, { recursive: true });
console.log("folder-usage: all tests passed");
