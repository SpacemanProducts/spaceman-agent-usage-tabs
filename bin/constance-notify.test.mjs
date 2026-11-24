// Constance's ears: the busctl monitor parser reads real Notify blocks, a
// finished notification is matched to a running job by agent + done file +
// folder, a missing done file gets the folder inspected, and an agent with no
// job of hers is logged as the owner's own — never touched.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { NotifyParser, notificationsIn, agentInText, matchJob, handleNotification, inspectJobDir, recentSignals, notifyFile } from "./constance-notify.mjs";
import { doneFile } from "./constance-jobs.mjs";

// A busctl monitor chunk in the exact shape captured live (method_call Notify
// followed by an unrelated method_return, then a second Notify with no trailing
// block — the parser's end() must still emit it).
const chunk = `‣ Type=method_call  Endian=l  Flags=0  Version=1 Cookie=9  Timestamp="x"
  Sender=:1.5100  Destination=:1.5071  Path=/org/freedesktop/Notifications  Interface=org.freedesktop.Notifications  Member=Notify
  UniqueName=:1.5100
  MESSAGE "susssasa{sv}i" {
          STRING "Devin";
          UINT32 0;
          STRING "";
          STRING "Devin finished";
          STRING "task done";
          ARRAY "s" {
          };
          ARRAY "{sv}" {
                  DICT_ENTRY "sv" {
                          STRING "urgency";
                          VARIANT "y" {
                                  BYTE 1;
                          };
                  };
          };
          INT32 -1;
  };

‣ Type=method_return  Endian=l  Flags=1  Version=1 Cookie=96  ReplyCookie=9  Timestamp="x"
  Sender=:1.5071  Destination=:1.5100
  UniqueName=:1.5071
  MESSAGE "u" {
          UINT32 1;
  };

‣ Type=method_call  Endian=l  Flags=0  Version=1 Cookie=10  Timestamp="x"
  Sender=:1.5100  Destination=:1.5071  Path=/org/freedesktop/Notifications  Interface=org.freedesktop.Notifications  Member=Notify
  UniqueName=:1.5100
  MESSAGE "susssasa{sv}i" {
          STRING "Grok";
          UINT32 0;
          STRING "";
          STRING "Grok finished";
          STRING "";
          ARRAY "s" {
          };
          ARRAY "{sv}" {
          };
          INT32 -1;
  };
`;

const evs = notificationsIn(chunk);
assert.equal(evs.length, 2, "both Notify calls parse, the method_return is ignored");
assert.deepEqual(evs[0], { app: "Devin", summary: "Devin finished", body: "task done" });
assert.deepEqual(evs[1], { app: "Grok", summary: "Grok finished", body: "" });
// Feeding line-by-line gives the same result as one-shot.
const p = new NotifyParser();
const streamed = [];
for (const line of chunk.split("\n")) { const e = p.feed(line); if (e) streamed.push(e); }
const tail = p.end(); if (tail) streamed.push(tail);
assert.deepEqual(streamed, evs, "streaming and one-shot agree");

// Agent names in notification text.
assert.equal(agentInText("Devin finished").id, "devin");
assert.equal(agentInText("grok is done").id, "grok");
assert.equal(agentInText("cursor-agent exited").id, "cursor");
assert.equal(agentInText("build succeeded"), null, "no agent named, no match");
assert.equal(agentInText("strategy session"), null, "agy inside a word does not match");

// Scratch project + state for matching tests.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "constance-notify-"));
const repo = path.join(root, "repo"), stateDir = path.join(root, "state");
fs.mkdirSync(repo); fs.mkdirSync(stateDir, { recursive: true });
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
fs.writeFileSync(path.join(repo, "a.txt"), "a\n"); git("add", "a.txt"); git("commit", "-qm", "init");

const jobs = [
  { id: 1, agent: "grok", status: "running", dir: repo, startedAt: 1 },
  { id: 2, agent: "devin", status: "running", dir: repo, startedAt: 2 },
  { id: 3, agent: "copilot", status: "accepted", dir: repo, startedAt: 3 },
];
// Job 2's done file exists; job 1's does not.
fs.mkdirSync(path.join(repo, ".constance"), { recursive: true });
fs.writeFileSync(doneFile(repo, 2), '{"summary":"done","commit":""}');

// "Devin finished" -> job 2 (its done file exists).
let m = matchJob("Devin finished", jobs);
assert.equal(m.kind, "agent-done"); assert.equal(m.job, 2); assert.equal(m.agent, "devin");
// "Grok finished" -> job 1, no done file -> still matched, flagged for inspection.
m = matchJob("Grok finished", jobs);
assert.equal(m.kind, "agent-done"); assert.equal(m.job, 1);
// A non-finish signal on a running agent is only a signal.
m = matchJob("Grok is thinking", jobs);
assert.equal(m.kind, "agent-signal"); assert.equal(m.job, 1);
// An agent with no running job is foreign — the owner's own run.
m = matchJob("Devin finished", jobs.filter((j) => j.id !== 2));
assert.equal(m.kind, "foreign"); assert.equal(m.agent, "devin");
assert.equal(m.job, undefined);
// An accepted job does not count as running.
m = matchJob("Copilot finished", jobs);
assert.equal(m.kind, "foreign");
// Nothing agent-shaped -> null.
assert.equal(matchJob("your coffee is ready", jobs), null);

// handleNotification records the event and inspects the folder when the done
// file is missing.
const ev = handleNotification({ app: "Grok", summary: "Grok finished", body: "" }, { jobs, storeDir: stateDir });
assert.equal(ev.kind, "agent-done"); assert.equal(ev.job, 1);
assert.match(ev.inspection, /no done file yet/);
assert.match(ev.inspection, /git log: /, "the git log is inspected");
assert.ok(fs.existsSync(notifyFile(stateDir)), "notify.jsonl is written");
assert.equal(recentSignals(stateDir).length, 1);
assert.equal(recentSignals(stateDir)[0].agent, "grok");
// Unrelated notifications never reach the file.
assert.equal(handleNotification({ app: "Music", summary: "track changed", body: "" }, { jobs, storeDir: stateDir }), null);
assert.equal(recentSignals(stateDir).length, 1);

// inspectJobDir on a clean repo.
const info = inspectJobDir(repo, 99);
assert.match(info, /no done file yet/);
assert.match(info, /worktree clean|uncommitted/);

fs.rmSync(root, { recursive: true, force: true });
console.log("constance-notify: tests passed");
