// Deep edge-case tests for handoff.mjs: wrong types, corrupt/missing inputs, boundary clocks and stale state.
// handoff.test.mjs covers the happy paths; nothing here repeats it. Everything lives under one mkdtemp dir and
// HOME/XDG_* are pointed there, so os.homedir() fallbacks and any state writes stay inside tmp.
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { spawnSync } from "node:child_process";
import { scrub, parseSections, readClaudeMd, repoInfo, buildNote, ensureAgentsLine, excludeFolder, insidePluginsDir, writeHandoff, findActiveRepo, maybeWriteHandoff, answerPending, MARKER, AGENTS_LINE, FOLDER, NOTE } from "./handoff.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-deep-"));
for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
  const d = path.join(tmp, k.toLowerCase()); fs.mkdirSync(d, { recursive: true });
  process.env[k] = d;
}
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (repo, ...a) => spawnSync("git", ["-C", repo, ...a], { env: { ...process.env, ...GIT_ENV } });
const gitIn = (cwd, ...a) => spawnSync("git", a, { cwd, env: { ...process.env, ...GIT_ENV } });
const initRepo = (dir, ...commits) => {
  fs.mkdirSync(dir, { recursive: true }); gitIn(dir, "init", "-q");
  for (const m of commits) { fs.writeFileSync(path.join(dir, "f"), m); git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", m); }
  return dir;
};
const NOW = Date.parse("2026-11-25T12:00:00Z");
const trig = { agent: "Claude Code", percent: 0.9, title: "Session", resetsIn: "", level: "warn" };
const sess = (agent, percent, title = "Session", level = "warn") => ({ agent: { name: agent }, limit: { title, percent, resetsAt: "2026-11-25T13:00:00Z" }, level });

// ---- scrub: token shapes, boundaries and non-strings ---------------------------------------------------------
{
  // too-short secrets are left alone; the regex needs 16+ chars after the prefix
  assert.equal(scrub("sk-abc123"), "sk-abc123");
  assert.equal(scrub("Bearer short"), "Bearer short");
  assert.equal(scrub(`Bearer ${"a".repeat(15)}`), `Bearer ${"a".repeat(15)}`);
  assert.equal(scrub(`Bearer ${"a".repeat(16)}`), "Bearer [token]");
  for (const p of ["sk", "ghp", "gho", "ghs", "xoxb", "xoxa", "xoxp"]) {
    assert.equal(scrub(`${p}-${"k".repeat(20)}`), "[token]", p);
    assert.equal(scrub(`${p}_${"k".repeat(20)}`), "[token]", `${p}_`);
  }
  assert.equal(scrub("apikey-" + "k".repeat(20)), "apikey-" + "k".repeat(20), "unknown prefixes are not tokens");
  // emails: plus tags and multi-level domains
  assert.equal(scrub("a+b@sub.example.co.uk"), "[email]");
  // non-strings never throw
  assert.equal(scrub(null), ""); assert.equal(scrub(undefined), ""); assert.equal(scrub(0), "", "falsy 0 becomes empty string"); assert.equal(scrub(42), "42");
}

// ---- parseSections / readClaudeMd: heading rules, bullets, caps, clipping --------------------------------------
{
  assert.deepEqual(parseSections(""), []);
  assert.deepEqual(parseSections("\n\n  \n"), [], "blank input has no sections");
  const secs = parseSections("# A\n\n## B\ntext\n#### deep\nmore\n#NoSpace\nstill B");
  assert.equal(secs.length, 2);
  assert.deepEqual(secs[1].lines, ["text", "#### deep", "more", "#NoSpace", "still B"], "#### and #nospace are not headings");

  // a section title matching goal-ish words wins over an earlier content section
  const md = "Intro paragraph here.\n\n## Overview\nThe real goal lives here.\n\n## Notes\n- a\n";
  assert.equal(readClaudeMd(md).goal, "The real goal lives here.");
  // with no titled match, the first section with content supplies the goal (even untitled)
  const untitled = readClaudeMd("just some words\nmore words\n\n## Next\n- thing\n");
  assert.equal(untitled.goal, "just some words more words");
  // bullets: -, *, 1. and 1) count; + and plain text do not; nested indent counts
  const b = readClaudeMd("## Next\n- dash\n* star\n1. dot\n2) paren\n  - indented\n+ plus\nplain line\n");
  assert.deepEqual(b.next, ["dash", "star", "dot", "paren", "indented"]);
  // a titled section with no bullets falls back to its paragraph
  const p = readClaudeMd("## Next steps\nFirst do this.\nThen that.\n\nSecond paragraph ignored.\n");
  assert.deepEqual(p.next, ["First do this. Then that."]);
  // the 8-item cap applies per field
  const many = "## Next\n" + Array.from({ length: 12 }, (_, i) => `- item ${i}`).join("\n");
  assert.equal(readClaudeMd(many).next.length, 8);
  // every problems-title spelling the regex knows
  for (const t of ["Known problems", "Open questions", "Issues", "Limitations", "Pitfalls", "Bugs", "Gaps", "Caveats"]) {
    assert.equal(readClaudeMd(`## ${t}\n- x\n`).problems.length, 1, t);
  }
  // long goal text is clipped at 220 chars with an ellipsis
  const long = "word ".repeat(80);
  const clipped = readClaudeMd(`# T\n\n${long}\n`);
  assert.ok(clipped.goal.length <= 220 && clipped.goal.endsWith("…"), "goal clipped");
}

// ---- repoInfo: non-git dirs, unborn branches, weird CLAUDE.md, log parsing -------------------------------
{
  const plain = path.join(tmp, "plain-dir"); fs.mkdirSync(plain);
  const pi = repoInfo(plain);
  assert.deepEqual(pi.log, []); assert.deepEqual(pi.status, []); assert.equal(pi.branch, "");
  assert.equal(pi.claude, null); assert.equal(pi.name, "plain-dir");

  const unborn = path.join(tmp, "unborn"); fs.mkdirSync(unborn); gitIn(unborn, "init", "-q");
  const ui = repoInfo(unborn);
  assert.deepEqual(ui.log, [], "no commits: empty log");
  assert.equal(ui.branch, "", "rev-parse fails on an unborn HEAD");

  // CLAUDE.md that is a directory is treated as absent, not an error
  const r = initRepo(path.join(tmp, "claude-dir-repo"), "one");
  fs.mkdirSync(path.join(r, "CLAUDE.md"));
  assert.equal(repoInfo(r).claude, null);

  // log is capped at 10 and subjects keep '|' characters
  const r2 = initRepo(path.join(tmp, "many-commits"));
  for (let i = 0; i < 12; i++) { fs.writeFileSync(path.join(r2, "f"), String(i)); git(r2, "add", "-A"); git(r2, "commit", "-q", "-m", `c${i} a|b`); }
  const li = repoInfo(r2);
  assert.equal(li.log.length, 10);
  assert.equal(li.log[0].subject, "c11 a|b", "pipe in subject survives the %h|%ad|%s split");
  assert.match(li.log[0].hash, /^[0-9a-f]+$/); assert.match(li.log[0].date, /^\d{4}-\d{2}-\d{2}$/);

  // status reports untracked, modified and deleted paths
  fs.writeFileSync(path.join(r2, "new.txt"), "n"); fs.writeFileSync(path.join(r2, "gone.txt"), "g"); git(r2, "add", "gone.txt"); git(r2, "commit", "-q", "-m", "add gone");
  fs.unlinkSync(path.join(r2, "gone.txt")); fs.appendFileSync(path.join(r2, "f"), "x");
  const st = repoInfo(r2).status.join("\n");
  assert.match(st, /gone\.txt/); assert.match(st, /f$/m); assert.match(st, /new\.txt/);
}

// ---- buildNote: caps, rounding, missing fields, corrupt-ish input -------------------------------------------
{
  const mk = (over = {}) => ({ name: "r", branch: "main", log: [{ hash: "abc1234", date: "2026-11-25", subject: "did a thing" }], status: [], claude: null, ...over });
  // more than 12 status lines collapses with an "…and N more" line
  const n15 = buildNote(mk({ status: Array.from({ length: 15 }, (_, i) => `f${i}.txt`) }), trig, NOW);
  assert.ok(n15.includes("…and 3 more")); assert.ok(!n15.includes("`f12.txt`"));
  // exactly 12 shows all, no ellipsis
  const n12 = buildNote(mk({ status: Array.from({ length: 12 }, (_, i) => `f${i}.txt`) }), trig, NOW);
  assert.ok(n12.includes("`f11.txt`") && !n12.includes("more`"));
  // percent is rounded and never clamped
  assert.match(buildNote(mk(), { ...trig, percent: 0.996 }, NOW), /is at 100% of its session limit/);
  assert.match(buildNote(mk(), { ...trig, percent: 1.4 }, NOW), /is at 140% of its session limit/);
  assert.match(buildNote(mk(), { ...trig, percent: 0 }, NOW), /is at 0% of its session limit/);
  // no resetsIn -> no parenthetical
  assert.ok(!/\(resets/.test(buildNote(mk(), trig, NOW)));
  // empty log and empty status say so plainly
  const empty = buildNote(mk({ log: [], status: [] }), trig, NOW);
  assert.ok(empty.includes("No commits yet.") && empty.includes("The working tree is clean"));
  // scrub runs over commit subjects and status lines too
  const dirty = buildNote(mk({
    log: [{ hash: "h", date: "d", subject: "ping bob@example.com" }],
    status: [`token sk-${"q".repeat(20)}.js`],
  }), trig, NOW);
  assert.ok(!dirty.includes("bob@example.com") && !dirty.includes("qqqq"));
  assert.ok(dirty.includes("[email]") && dirty.includes("[token]"));
  // clock edges: now=0 still stamps; an invalid clock writes NaN rather than throwing
  assert.match(buildNote(mk(), trig, 0), /Written \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  assert.ok(buildNote(mk(), trig, NaN).includes("NaN-NaN-NaN NaN:NaN"), "bad clock -> NaN stamp, no throw");
  // wrong types: a trigger without a title crashes on toLowerCase — documented, not handled
  assert.throws(() => buildNote(mk(), { agent: "A", percent: 0.5, level: "warn" }, NOW), TypeError);
}

// ---- ensureAgentsLine / excludeFolder: file-shape edge cases ---------------------------------------------------
{
  const r = initRepo(path.join(tmp, "agents-edge"), "c");
  const af = path.join(r, "AGENTS.md");
  // no trailing newline: exactly one blank line separates content from the marker line
  fs.writeFileSync(af, "no newline at end");
  assert.equal(ensureAgentsLine(r), true);
  assert.equal(fs.readFileSync(af, "utf8"), `no newline at end\n\n${AGENTS_LINE}\n`);
  // many trailing newlines collapse to one blank line
  fs.writeFileSync(af, "text\n\n\n\n");
  assert.equal(ensureAgentsLine(r), true);
  assert.equal(fs.readFileSync(af, "utf8"), `text\n\n${AGENTS_LINE}\n`);
  // the marker anywhere in the file counts as present — even mid-line — and nothing is appended
  const r2 = initRepo(path.join(tmp, "agents-inline"), "c");
  fs.writeFileSync(path.join(r2, "AGENTS.md"), `# Rules\nsee ${MARKER} inline\n`);
  const before = fs.readFileSync(path.join(r2, "AGENTS.md"), "utf8");
  assert.equal(ensureAgentsLine(r2), false);
  assert.equal(fs.readFileSync(path.join(r2, "AGENTS.md"), "utf8"), before);
  // AGENTS.md that is a directory is a hard error, not a silent skip
  const r3 = initRepo(path.join(tmp, "agents-dir"), "c");
  fs.mkdirSync(path.join(r3, "AGENTS.md"));
  assert.throws(() => ensureAgentsLine(r3), /EISDIR/);

  // excludeFolder: a non-git dir is skipped without creating anything
  const nogit = path.join(tmp, "nogit-excl"); fs.mkdirSync(nogit);
  assert.equal(excludeFolder(nogit), false);
  assert.ok(!fs.existsSync(path.join(nogit, "info")) && !fs.existsSync(path.join(nogit, ".git")));
  // "handoff" without the slash does not count; "handoff/" with trailing spaces does
  const r4 = initRepo(path.join(tmp, "excl-noslash"), "c");
  const ex = path.join(r4, ".git", "info", "exclude");
  fs.mkdirSync(path.dirname(ex), { recursive: true }); fs.writeFileSync(ex, "handoff\n");
  assert.equal(excludeFolder(r4), true);
  assert.equal(fs.readFileSync(ex, "utf8"), "handoff\nhandoff/\n");
  const r5 = initRepo(path.join(tmp, "excl-spaces"), "c");
  const ex5 = path.join(r5, ".git", "info", "exclude");
  fs.mkdirSync(path.dirname(ex5), { recursive: true });
  fs.writeFileSync(ex5, "handoff/   \n");
  assert.equal(excludeFolder(r5), false, "trimmed match counts as already excluded");
}

// ---- insidePluginsDir: path boundary cases ---------------------------------------------------------------------
{
  const home = process.env.HOME; // the tmp home set above
  const plugins = path.join(home, ".config", "omarchy", "plugins");
  assert.equal(insidePluginsDir(plugins, { HOME: home }), true, "the plugins dir itself");
  assert.equal(insidePluginsDir(plugins + "/", { HOME: home }), true, "trailing slash resolves away");
  assert.equal(insidePluginsDir(plugins + "-evil/x", { HOME: home }), false, "prefix without separator is a sibling");
  assert.equal(insidePluginsDir(path.join(home, ".config", "omarchy", "Plugins", "x"), { HOME: home }), false, "case-sensitive");
  assert.equal(insidePluginsDir("", { HOME: home }), false, "empty repo resolves to cwd, not plugins");
  // no env at all -> os.homedir(), which is our redirected HOME
  assert.equal(insidePluginsDir(path.join(plugins, "some-plugin")), true, "falls back to os.homedir() = tmp HOME");
  assert.equal(insidePluginsDir(path.join(tmp, "outside")), false);
}

// ---- findActiveRepo: newest-file-only, corrupt tails, clock boundaries, squad fallback --------------------------
{
  const mkProjects = (name) => {
    const P = path.join(tmp, name, "projects"); fs.mkdirSync(P, { recursive: true }); return P;
  };
  const repoA = initRepo(path.join(tmp, "repo-a"), "init");
  const real = (p) => fs.realpathSync(p);

  // only the single newest .jsonl is read: an older valid transcript is ignored entirely
  {
    const P = mkProjects("p-newest"); const S = path.join(tmp, "p-newest", "squad");
    fs.mkdirSync(path.join(P, "d1"), { recursive: true }); fs.mkdirSync(path.join(P, "d2"), { recursive: true });
    fs.writeFileSync(path.join(P, "d1", "old.jsonl"), JSON.stringify({ cwd: repoA }) + "\n");
    fs.utimesSync(path.join(P, "d1", "old.jsonl"), new Date(NOW - 60000), new Date(NOW - 60000));
    fs.writeFileSync(path.join(P, "d2", "new.jsonl"), JSON.stringify({ type: "user" }) + "\n"); // newest, no cwd
    assert.equal(findActiveRepo({ projectsDir: P, squadDirFile: "/nonexistent", now: NOW }), "", "newest transcript wins even with no cwd; older ones are never read");
    // a non-jsonl file never counts, however new
    fs.writeFileSync(path.join(P, "d2", "newer.txt"), "x");
    assert.equal(findActiveRepo({ projectsDir: P, squadDirFile: "/nonexistent", now: NOW }), "");
    fs.rmSync(path.join(P, "d2", "newer.txt"));
  }

  // the transcript scan reads only the last 128 KiB: a cwd earlier in a huge file is invisible
  {
    const P = mkProjects("p-tail"); const S = path.join(tmp, "p-tail", "squad");
    fs.mkdirSync(path.join(P, "d"), { recursive: true });
    fs.writeFileSync(path.join(P, "d", "big.jsonl"), JSON.stringify({ cwd: repoA }) + "\n" + "x".repeat(200000) + "\n");
    assert.equal(findActiveRepo({ projectsDir: P, squadDirFile: "/nonexistent", now: NOW }), "", "cwd beyond the 128 KiB tail is missed");
    fs.writeFileSync(S, repoA + "\n");
    assert.equal(findActiveRepo({ projectsDir: P, squadDirFile: S, now: NOW }), real(repoA), "falls back to the squad folder");
  }

  // within the tail, every cwd is tried newest-first: a later non-repo cwd does not hide an earlier repo one
  {
    const P = mkProjects("p-cwds");
    fs.mkdirSync(path.join(P, "d"), { recursive: true });
    fs.writeFileSync(path.join(P, "d", "s.jsonl"),
      JSON.stringify({ cwd: repoA }) + "\n" + JSON.stringify({ cwd: "/tmp" }) + "\n" + JSON.stringify({ cwd: "/nonexistent" }) + "\n");
    assert.equal(findActiveRepo({ projectsDir: P, squadDirFile: "/nonexistent", now: NOW }), real(repoA), "later non-repo cwd entries do not hide an earlier repo one");
    // a cwd with spaces works too
    const spaced = initRepo(path.join(tmp, "repo with space"), "init");
    fs.writeFileSync(path.join(P, "d", "s.jsonl"), JSON.stringify({ cwd: spaced }) + "\n");
    assert.equal(findActiveRepo({ projectsDir: P, squadDirFile: "/nonexistent", now: NOW }), real(spaced));
  }

  // one malformed cwd entry poisons the whole scan (JSON.parse throws -> catch -> squad fallback)
  {
    const P = mkProjects("p-badcwd"); const S = path.join(tmp, "p-badcwd", "squad");
    fs.mkdirSync(path.join(P, "d"), { recursive: true });
    fs.writeFileSync(path.join(P, "d", "s.jsonl"),
      JSON.stringify({ cwd: repoA }) + "\n" + `{"cwd":"bad \\x escape"}\n`);
    fs.writeFileSync(S, repoA + "\n");
    assert.equal(findActiveRepo({ projectsDir: P, squadDirFile: S, now: NOW }), real(repoA), "bad escape -> squad dir, good cwd never tried");
  }

  // clock boundaries: age == maxAgeMs still counts, 1 ms older does not; future mtimes count
  {
    const P = mkProjects("p-clock");
    fs.mkdirSync(path.join(P, "d"), { recursive: true });
    const f = path.join(P, "d", "s.jsonl");
    fs.writeFileSync(f, JSON.stringify({ cwd: repoA }) + "\n");
    const max = 6 * 3600 * 1000, t = NOW - max;
    fs.utimesSync(f, new Date(t), new Date(t));
    assert.ok(findActiveRepo({ projectsDir: P, squadDirFile: "/nonexistent", now: NOW }), "exactly maxAgeMs old is still fresh");
    assert.equal(findActiveRepo({ projectsDir: P, squadDirFile: "/nonexistent", now: NOW + 1 }), "", "1 ms past the window is stale");
    fs.utimesSync(f, new Date(NOW + 5000), new Date(NOW + 5000));
    assert.ok(findActiveRepo({ projectsDir: P, squadDirFile: "/nonexistent", now: NOW }), "a future mtime counts as fresh");
  }

  // input-shape edges: projectsDir a file, squad file a directory or multi-line, both missing
  {
    const P = mkProjects("p-shapes"); const af = path.join(tmp, "p-shapes", "afile"); fs.writeFileSync(af, "x");
    assert.equal(findActiveRepo({ projectsDir: af, squadDirFile: "/nonexistent", now: NOW }), "");
    const sd = path.join(tmp, "p-shapes", "squaddir"); fs.mkdirSync(sd);
    assert.equal(findActiveRepo({ projectsDir: "/nonexistent", squadDirFile: sd, now: NOW }), "");
    const sf = path.join(tmp, "p-shapes", "squadfile");
    fs.writeFileSync(sf, repoA + "\n" + repoA + "\n"); // two lines: trim leaves an invalid path
    assert.equal(findActiveRepo({ projectsDir: "/nonexistent", squadDirFile: sf, now: NOW }), "");
    fs.writeFileSync(sf, "   " + repoA + "   \n"); // surrounding whitespace is trimmed
    assert.ok(findActiveRepo({ projectsDir: "/nonexistent", squadDirFile: sf, now: NOW }));
  }
}

// ---- maybeWriteHandoff / answerPending: settings quirks, pending-file state, wrong types -----------------------
{
  const P = path.join(tmp, "mw-projects"); fs.mkdirSync(path.join(P, "d"), { recursive: true });
  const repoM = initRepo(path.join(tmp, "mw-repo"), "init");
  fs.writeFileSync(path.join(P, "d", "s.jsonl"), JSON.stringify({ cwd: repoM }) + "\n");
  const squadF = path.join(tmp, "mw-squad"); fs.writeFileSync(squadF, repoM + "\n");
  const base = { projectsDir: P, squadDirFile: squadF, now: NOW, untilReset: (r) => `in ${r}` };

  // settings null/absent is "undecided", same as {}: it asks
  const pend1 = path.join(tmp, "mw-p1.json");
  assert.equal(maybeWriteHandoff({ ...base, sent: [sess("A", 0.9)], settings: null, pendingFile: pend1 }), "asked");
  // any truthy non-true handoffNote is NOT "allowed": it still only asks
  const pend2 = path.join(tmp, "mw-p2.json");
  assert.equal(maybeWriteHandoff({ ...base, sent: [sess("B", 0.9)], settings: { handoffNote: 1 }, pendingFile: pend2 }), "asked");
  // sent missing entirely -> nothing
  assert.equal(maybeWriteHandoff({ ...base, sent: undefined, settings: { handoffNote: true } }), "");
  // a session title match is case-insensitive; a title merely containing 'session' also counts
  assert.equal(maybeWriteHandoff({ ...base, sent: [sess("C", 0.5, "SESSION")], settings: { handoffNote: false } }), "", "off switch wins even for SESSION");
  assert.equal(maybeWriteHandoff({ ...base, sent: [{ agent: { name: "D" }, limit: { title: "5h session", percent: 0.5, resetsAt: "R" }, level: "warn" }], settings: { handoffNote: false } }), "");

  // pending file: mode 0600, carries repo+trigger+at, untilReset sees resetsAt
  const pend3 = path.join(tmp, "deep", "nested", "pend.json"); // parent dirs do not exist yet
  assert.equal(maybeWriteHandoff({ ...base, sent: [sess("E", 0.9)], settings: {}, pendingFile: pend3 }), "asked");
  const pd = JSON.parse(fs.readFileSync(pend3, "utf8"));
  assert.equal(pd.at, NOW); assert.equal(pd.trigger.agent, "E"); assert.equal(pd.trigger.resetsIn, "in 2026-11-25T13:00:00Z");
  assert.equal(fs.statSync(pend3).mode & 0o777, 0o600, "pending file is owner-only");
  // a stale tmp file from a crashed earlier run is simply overwritten
  fs.writeFileSync(`${pend3}.${process.pid}.tmp`, "garbage from a crash\n");
  assert.equal(maybeWriteHandoff({ ...base, sent: [sess("F", 0.95)], settings: {}, pendingFile: pend3 }), "pending");
  assert.equal(JSON.parse(fs.readFileSync(pend3, "utf8")).trigger.agent, "F");
  assert.ok(!fs.existsSync(`${pend3}.${process.pid}.tmp`), "tmp renamed away");

  // equal percents: reduce keeps the FIRST item, not the last
  const noteM = path.join(repoM, FOLDER, NOTE);
  maybeWriteHandoff({ ...base, sent: [sess("First", 0.9), sess("Second", 0.9)], settings: { handoffNote: true } });
  assert.match(fs.readFileSync(noteM, "utf8"), /\*\*First\*\*/);
  fs.rmSync(path.join(repoM, FOLDER), { recursive: true, force: true });

  // wrong types: items missing agent/limit fields crash instead of being skipped
  assert.throws(() => maybeWriteHandoff({ ...base, sent: [{ limit: { title: "Session", percent: 0.9 } }], settings: { handoffNote: true } }), TypeError);
  const rNoPct = maybeWriteHandoff({ ...base, sent: [{ agent: { name: "NoPct" }, limit: { title: "Session", resetsAt: "R" }, level: "warn" }], settings: { handoffNote: true } });
  assert.ok(rNoPct && fs.readFileSync(rNoPct, "utf8").includes("is at 0%"), "missing percent renders as 0%");
  fs.rmSync(path.join(repoM, FOLDER), { recursive: true, force: true });

  // pending-file write failures propagate (no silent swallow)
  const blocker = path.join(tmp, "mw-blocker"); fs.writeFileSync(blocker, "x");
  assert.throws(() => maybeWriteHandoff({ ...base, sent: [sess("G", 0.9)], settings: {}, pendingFile: path.join(blocker, "p.json") }));
  const pendDir = path.join(tmp, "mw-penddir"); fs.mkdirSync(pendDir);
  assert.throws(() => maybeWriteHandoff({ ...base, sent: [sess("G", 0.9)], settings: {}, pendingFile: pendDir }), /EISDIR/);

  // answerPending on missing/corrupt/ shapeless pending files
  assert.equal(answerPending(path.join(tmp, "mw-nofile.json"), "allow"), "");
  const corrupt = path.join(tmp, "mw-corrupt.json"); fs.writeFileSync(corrupt, "{not json\n");
  assert.equal(answerPending(corrupt, "allow"), ""); assert.ok(!fs.existsSync(corrupt), "corrupt pending is still removed");
  const shapeless = path.join(tmp, "mw-shapeless.json"); fs.writeFileSync(shapeless, JSON.stringify({ hello: 1 }));
  assert.equal(answerPending(shapeless, "allow"), ""); assert.ok(!fs.existsSync(shapeless));
  // pendingFile that is a directory: read fails, unlink fails, "" returned
  assert.equal(answerPending(pendDir, "allow"), "");
  // wrong types: a pending trigger without title crashes writeHandoff
  const badTrig = path.join(tmp, "mw-badtrig.json");
  fs.writeFileSync(badTrig, JSON.stringify({ repo: repoM, trigger: { agent: "X", percent: 0.5 }, at: NOW }));
  assert.throws(() => answerPending(badTrig, "allow"), TypeError);
  assert.ok(!fs.existsSync(badTrig), "pending removed even when the write throws");
}

// ---- writeHandoff on repos git can't read -----------------------------------------------------------------------
{
  const plain = path.join(tmp, "wh-plain"); fs.mkdirSync(plain);
  const r = writeHandoff(plain, trig, NOW);
  assert.ok(r.file.endsWith(path.join(FOLDER, NOTE)) && r.addedLine);
  const note = fs.readFileSync(r.file, "utf8");
  assert.ok(note.includes("No commits yet.") && note.includes("The working tree is clean"));
  assert.ok(!note.includes("Branch"), "no commits -> the branch line is skipped entirely");
  // a plain dir still gets AGENTS.md but no exclude line (no git dir)
  assert.ok(fs.existsSync(path.join(plain, "AGENTS.md")));
  assert.ok(!fs.existsSync(path.join(plain, ".git")));
  // handoff/ existing as a regular file is a hard error
  const blocked = path.join(tmp, "wh-blocked"); initRepo(blocked, "c");
  fs.writeFileSync(path.join(blocked, FOLDER), "i am a file");
  assert.throws(() => writeHandoff(blocked, trig, NOW), /EEXIST/);
}

// ---- known bugs (kept as documentation; the module is not changed here) -----------------------------------------
// BUG: findActiveRepo picks the newest *.jsonl entry by mtime but never checks it is a file. A directory named
//      "x.jsonl" with a fresh mtime shadows the real transcript: openSync/readSync throws, the catch falls through
//      to the squad file, and the valid older transcript is never read.
//   {
//     const P = path.join(tmp, "bug-proj"); fs.mkdirSync(path.join(P, "d"), { recursive: true });
//     const f = path.join(P, "d", "real.jsonl");
//     fs.writeFileSync(f, JSON.stringify({ cwd: repoA }) + "\n");
//     fs.utimesSync(f, new Date(NOW - 60000), new Date(NOW - 60000));
//     fs.mkdirSync(path.join(P, "d", "aaa.jsonl")); // directory, newest mtime
//     // want: the real transcript's repo; got: "" (or the squad fallback)
//     assert.ok(findActiveRepo({ projectsDir: P, squadDirFile: "/nonexistent", now: NOW }));
//   }
// BUG: answerPending("allow") trusts the stored repo path. If the repo was deleted between the ask and the answer,
//      writeHandoff mkdirSync's the whole path and drops handoff/HANDOFF.md + AGENTS.md into a fresh non-repo
//      directory. It should verify the path is still a git repo (or at least still exists) before writing.
//   {
//     const gone = path.join(tmp, "bug-gone-repo");
//     const pf = path.join(tmp, "bug-pending.json");
//     fs.writeFileSync(pf, JSON.stringify({ repo: gone, trigger: trig, at: NOW }));
//     // want: "" and no directories created; got: a recreated folder tree with a note and AGENTS.md
//     assert.equal(answerPending(pf, "allow"), "");
//     assert.ok(!fs.existsSync(gone));
//   }

fs.rmSync(tmp, { recursive: true, force: true });
console.log("handoff.deep: all tests passed");
