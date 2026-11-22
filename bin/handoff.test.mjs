import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { spawnSync } from "node:child_process";
import { maybeWriteHandoff, answerPending, scrub, readClaudeMd, repoInfo, buildNote, writeHandoff, ensureAgentsLine, findActiveRepo, AGENTS_LINE, MARKER } from "./handoff.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-test-"));
const env = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (repo, ...a) => spawnSync("git", ["-C", repo, ...a], { env: { ...process.env, ...env } });
const repo = path.join(tmp, "proj"); fs.mkdirSync(repo); git(repo, "init", "-q");
const commit = (msg) => { fs.writeFileSync(path.join(repo, "f.txt"), msg); git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", msg); };
fs.writeFileSync(path.join(repo, "CLAUDE.md"), `# Proj notes

## Goal (read this first)

Ship the importer so a user can load a CSV in one click. Contact me at someone@example.com.

## Next
- Add the progress bar to the importer
- Write the retry test

## Known problems
- The importer drops the last row when the file has no trailing newline
- sk-abcdefghijklmnopqrstuvwxyz1234 must never be committed

## Decisions
- Use streaming parsing.
`);
commit("Add CSV parser"); commit("Wire the importer button"); commit("Fix header detection");
fs.writeFileSync(path.join(repo, "wip.js"), "// unfinished");
const trig = { agent: "Claude Code", percent: 0.96, title: "Session", resetsIn: "resets in 1h 20m", level: "warn" };
const NOW = Date.parse("2026-11-22T10:30:00");

// ---- CLAUDE.md is read for the goal, what's next, and open problems
const c = readClaudeMd(fs.readFileSync(path.join(repo, "CLAUDE.md"), "utf8"));
assert.match(c.goal, /^Ship the importer/);
assert.deepEqual(c.next, ["Add the progress bar to the importer", "Write the retry test"]);
assert.equal(c.problems.length, 2); assert.match(c.problems[0], /drops the last row/);
assert.deepEqual(readClaudeMd(""), { goal: "", next: [], problems: [] }, "no CLAUDE.md: nothing invented");

// ---- the note covers all four parts, from commits and CLAUDE.md
const note = buildNote(repoInfo(repo), trig, NOW);
for (const h of ["## What we were working on", "## What's done", "## What's next", "## Open problems"]) assert.ok(note.includes(h), h);
assert.match(note, /Claude Code\*\* is at 96% of its session limit \(resets in 1h 20m\)/);
assert.match(note, /Fix header detection/); assert.match(note, /Wire the importer button/); assert.match(note, /Add CSV parser/);
assert.match(note, /Add the progress bar to the importer/);
assert.match(note, /drops the last row/);
assert.match(note, /Uncommitted work in progress \(\d+ files?\)[\s\S]*wip\.js/, "unfinished work is listed");
assert.match(note, /Ship the importer so a user can load a CSV/);
// ---- nothing personal or secret lands in the repo
assert.ok(!note.includes("someone@example.com") && !note.includes("sk-abcdefghijklmnopqrstuvwxyz"), "emails and tokens scrubbed");
assert.equal(scrub("mail a@b.co and Bearer abcdefghijklmnopqrstuvwxyz0123"), "mail [email] and Bearer [token]");
// ---- a repo with no CLAUDE.md says so instead of making things up
const bare = path.join(tmp, "bare"); fs.mkdirSync(bare); git(bare, "init", "-q"); fs.writeFileSync(path.join(bare, "a"), "1"); git(bare, "add", "-A"); git(bare, "commit", "-q", "-m", "First");
const bareNote = buildNote(repoInfo(bare), { ...trig, level: "limit" }, NOW);
assert.match(bareNote, /hit its session limit/); assert.match(bareNote, /Nothing is recorded as next in CLAUDE\.md/); assert.match(bareNote, /None recorded in CLAUDE\.md/);

// ---- writing: handoff/HANDOFF.md, plus ONE line in AGENTS.md (created if missing, never duplicated)
let r = writeHandoff(repo, trig, NOW);
assert.equal(r.file, path.join(repo, "handoff", "HANDOFF.md")); assert.ok(r.addedLine);
assert.ok(fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8").includes("handoff/"), "AGENTS.md points at the folder");
assert.equal(fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8").trim(), AGENTS_LINE);
assert.match(fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8"), /^handoff\/$/m, "handoff/ stays untracked (local exclude)");
assert.ok(!spawnSync("git", ["-C", repo, "status", "--short"], { encoding: "utf8" }).stdout.includes("handoff/"), "git does not list the folder");
// ---- updated each time the warning fires, replacing the old note, without touching AGENTS.md again
commit("Add retry logic");
r = writeHandoff(repo, { ...trig, percent: 0.99, level: "limit" }, NOW + 3600000);
const note2 = fs.readFileSync(r.file, "utf8");
assert.ok(!r.addedLine); assert.match(note2, /Add retry logic/); assert.match(note2, /hit its session limit/);
assert.equal(fs.readdirSync(path.join(repo, "handoff")).length, 1, "one note, rewritten");
assert.equal((fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8").match(new RegExp(MARKER, "g")) || []).length, 1);
// ---- an existing AGENTS.md keeps its content; the line is appended once
const other = path.join(tmp, "other"); fs.mkdirSync(other); git(other, "init", "-q"); fs.writeFileSync(path.join(other, "AGENTS.md"), "# Rules\n\n- Use tabs.\n");
assert.ok(ensureAgentsLine(other)); assert.ok(!ensureAgentsLine(other));
assert.match(fs.readFileSync(path.join(other, "AGENTS.md"), "utf8"), /^# Rules\n\n- Use tabs\.\n\n<!-- cook-meter-handoff -->/);

// ---- the active repo: the newest Claude Code session's cwd, else the last Claude Squad folder
const projects = path.join(tmp, "claude-projects"); fs.mkdirSync(path.join(projects, "p1"), { recursive: true });
fs.writeFileSync(path.join(projects, "p1", "s.jsonl"), `{"type":"x"}\n{"cwd":${JSON.stringify(repo)},"msg":1}\n`);
const squadFile = path.join(tmp, "squad-dir"); fs.writeFileSync(squadFile, other + "\n");
assert.equal(fs.realpathSync(findActiveRepo({ projectsDir: projects, squadDirFile: squadFile })), fs.realpathSync(repo), "recent Claude session wins");
assert.equal(fs.realpathSync(findActiveRepo({ projectsDir: projects, squadDirFile: squadFile, now: Date.now() + 99 * 3600000 })), fs.realpathSync(other), "stale session: the Squad folder");
assert.equal(findActiveRepo({ projectsDir: "/nonexistent", squadDirFile: "/nonexistent" }), "", "no repo: nothing written anywhere");

// ---- what the collector calls: only session alerts, the agent closest to its limit, and it ASKS before the first write
{
  const item = (agent, title, percent, level = "warn") => ({ agent: { name: agent }, limit: { title, percent, resetsAt: "2026-11-22T12:00:00Z" }, level });
  const pendingFile = path.join(tmp, "handoff-pending.json");
  const base = { projectsDir: projects, squadDirFile: squadFile, untilReset: () => "resets in 1h", pendingFile };
  const note = path.join(repo, "handoff", "HANDOFF.md");
  fs.rmSync(path.join(repo, "handoff"), { recursive: true, force: true });
  assert.equal(maybeWriteHandoff({ ...base, sent: [item("Claude Code", "Weekly", 0.97)], settings: { handoffNote: true } }), "", "a weekly alert is not a session alert");
  assert.ok(!fs.existsSync(path.join(repo, "handoff")), "nothing written");
  assert.equal(maybeWriteHandoff({ ...base, sent: [item("Claude Code", "Session", 0.97)], settings: { handoffNote: false } }), "", "never: the switch is off");
  assert.ok(!fs.existsSync(path.join(repo, "handoff")) && !fs.existsSync(pendingFile), "off writes nothing and asks nothing");

  // undecided (the first time): NOTHING is written; it remembers what would be, and says it asked
  const agentsFile = path.join(repo, "AGENTS.md"), agentsBefore = fs.existsSync(agentsFile) ? fs.readFileSync(agentsFile, "utf8") : null;
  assert.equal(maybeWriteHandoff({ ...base, sent: [item("Claude Code", "Session", 0.97)], settings: {} }), "asked");
  assert.ok(!fs.existsSync(path.join(repo, "handoff")), "no handoff folder before you say yes");
  assert.equal(fs.existsSync(agentsFile) ? fs.readFileSync(agentsFile, "utf8") : null, agentsBefore, "and AGENTS.md is untouched");
  const pend = JSON.parse(fs.readFileSync(pendingFile, "utf8"));
  assert.equal(pend.repo && fs.realpathSync(pend.repo), fs.realpathSync(repo)); assert.equal(pend.trigger.agent, "Claude Code");
  // it only asks once: a second warning updates the waiting note silently
  assert.equal(maybeWriteHandoff({ ...base, sent: [item("Grok", "Session", 0.99, "limit")], settings: {} }), "", "no second question");
  assert.equal(JSON.parse(fs.readFileSync(pendingFile, "utf8")).trigger.agent, "Grok");
  // Not now: forget it, write nothing (it will ask again)
  assert.equal(answerPending(pendingFile, "dismiss"), ""); assert.ok(!fs.existsSync(pendingFile) && !fs.existsSync(path.join(repo, "handoff")));
  assert.equal(maybeWriteHandoff({ ...base, sent: [item("Claude Code", "Session", 0.97)], settings: {} }), "asked", "asks again after Not now");
  // Allow: the waiting note is written now, once, from what was waiting
  const wrote = answerPending(pendingFile, "allow");
  assert.equal(wrote, note); assert.ok(!fs.existsSync(pendingFile)); assert.match(fs.readFileSync(note, "utf8"), /Claude Code\*\* is at 97%/);
  assert.equal(answerPending(pendingFile, "allow"), "", "nothing waiting: nothing happens");
  fs.rmSync(path.join(repo, "handoff"), { recursive: true, force: true });

  // allowed (handoffNote: true): writes straight away, the agent closest to its limit is named
  const file = maybeWriteHandoff({ ...base, sent: [item("Grok", "Session", 0.96), item("Claude Code", "Session", 1.0, "limit"), item("Codex", "Weekly", 1.0, "limit")], settings: { handoffNote: true } });
  assert.equal(file, note);
  const written = fs.readFileSync(file, "utf8");
  assert.match(written, /Claude Code\*\* hit its session limit/, "the agent closest to its limit is named");
  assert.ok(!/Grok\*\*/.test(written));
  assert.equal(maybeWriteHandoff({ sent: [item("Claude Code", "Session", 0.97)], projectsDir: "/nonexistent", squadDirFile: "/nonexistent", pendingFile, settings: { handoffNote: true } }), "", "no active repo: nothing written, nothing asked");
  assert.equal(maybeWriteHandoff({ ...base, sent: [], settings: {} }), "");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("handoff: all tests passed");
