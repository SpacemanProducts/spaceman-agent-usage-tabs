// Deeper edge-case pass on bin/constance-remote.mjs, complementing
// constance-remote.test.mjs. Covers what the first test leaves out: wrong-type
// inputs at every level, the clean()/clip() boundaries, checklist numbering
// quirks, the exact 15-line cap at its edge, pace-window matching rules, input
// purity, and writeRemoteStatus failure paths (a failed rename removes its
// tmp file; tmp names are unique per call so concurrent writers can't collide).
// The module never touches the home folder; the fake
// HOME/XDG dirs under mktemp are a guard so nothing real can be reached.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "constance-remote-deep-"));
process.env.HOME = path.join(tmp, "home");
process.env.XDG_STATE_HOME = path.join(tmp, "xdg-state");
process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg-config");
process.env.XDG_CACHE_HOME = path.join(tmp, "xdg-cache");
for (const d of [process.env.HOME, process.env.XDG_STATE_HOME, process.env.XDG_CONFIG_HOME, process.env.XDG_CACHE_HOME]) {
  fs.mkdirSync(d, { recursive: true });
}

const { remoteSummary, writeRemoteStatus } = await import("./constance-remote.mjs");

const MINIMAL = "Goal: none\nJobs: 0 running · 0 held · 0 finished\nLimits: no data\n";

// ---------- remoteSummary: non-object and wrong-type inputs ----------

// Anything that isn't a plain-ish object collapses to the empty summary —
// strings, numbers, booleans, null, undefined. Arrays ARE objects, so an array
// status is read for fields it doesn't have and still yields the minimal one.
for (const bad of ["text", 42, true, null, undefined, [], ["goal"], new Date(0)]) {
  assert.equal(remoteSummary(bad), MINIMAL, `status ${String(bad)}`);
}
// A symbol status is not an object either.
assert.equal(remoteSummary(Symbol("s")), MINIMAL);
// BigInt is not an object.
assert.equal(remoteSummary(10n), MINIMAL);

// ---------- goal extraction ----------

// goal as a bare string is used directly; as a number it is ignored entirely
// (only .text is read off non-strings).
assert.ok(remoteSummary({ goal: "bare string goal" }).startsWith("Goal: bare string goal"));
assert.ok(remoteSummary({ goal: 42 }).startsWith("Goal: none"), "numeric goal has no .text");
assert.ok(remoteSummary({ goal: true }).startsWith("Goal: none"));
// .text is stringified by firstLine, so non-string truthy values leak through.
assert.ok(remoteSummary({ goal: { text: 42 } }).startsWith("Goal: 42"));
assert.ok(remoteSummary({ goal: { text: ["a", "b"] } }).startsWith("Goal: a,b"), "array text joins with commas");
assert.ok(remoteSummary({ goal: { text: {} } }).startsWith("Goal: [object Object]"));
assert.ok(remoteSummary({ goal: { text: true } }).startsWith("Goal: true"));
// Falsy .text values all become "" -> "none".
for (const t of [0, false, "", null, undefined, []]) {
  assert.ok(remoteSummary({ goal: { text: t } }).startsWith("Goal: none"), `text ${String(t)}`);
}
// firstLine takes only the FIRST line: a goal whose first line is blank shows
// "none" even when later lines have text; \r\n is handled.
assert.ok(remoteSummary({ goal: "\nsecond line has words" }).startsWith("Goal: none"), "blank first line -> none");
assert.ok(remoteSummary({ goal: "first\r\nsecond" }).startsWith("Goal: first"), "CRLF split");
assert.ok(remoteSummary({ goal: { text: "obj first\nobj second" } }).startsWith("Goal: obj first"));
// A goal made only of path/email tokens cleans to empty -> "none", not "";
// plain words around them survive.
assert.ok(remoteSummary({ goal: "fix /home/x and a@b.co" }).startsWith("Goal: fix and"));
assert.ok(remoteSummary({ goal: "/home/x a@b.co" }).startsWith("Goal: none"));
assert.ok(remoteSummary({ goal: "   \n  " }).startsWith("Goal: none"), "whitespace-only goal");
// Non-Latin text survives clean() untouched.
assert.ok(remoteSummary({ goal: "ship 🚀 the feature — with ünicode" }).includes("🚀"));

// ---------- clean(): token rules ----------

// PATHY is unanchored on "/home/" and anchored-start on "/": a RELATIVE path
// containing /home/ is still dropped, a plain relative path is kept, and a
// Windows-style backslash path is kept (no forward slashes).
// Each case asserts the exact surviving/dropped token in the Goal line.
const cleanCases = [
  ["see docs/guide/x for it", "docs/guide/x"],   // relative path kept
  ["look in my/home/dir now", null],             // /home/ substring dropped
  ["edit C:/home/x/file", null],                 // forward-slash home dropped
  ["edit C:\\home\\x\\file", "C:\\home\\x\\file"], // backslashes don't match PATHY
  ["mail a@b now", "a@b"],                       // no dot after @: kept
  ["mail a@b.co, ok", null],                     // unanchored regex eats the comma too
  ["see http://example.com/a/b", "http://example.com/a/b"], // plain URL kept
  ["see http://x/home/y", null],                 // URL with /home/ dropped
];
for (const [goalText, kept] of cleanCases) {
  const out = remoteSummary({ goal: goalText }).split("\n")[0];
  if (kept) assert.ok(out.includes(kept), `${goalText} -> ${out}`);
  else assert.ok(!out.includes("/home/") && !out.includes("a@b.co") && !out.includes("C:/home"), `${goalText} -> ${out}`);
}
// The same stripping applies inside checklist items: /tmp/job is an
// absolute-path token (leading /) and drops, but plain words survive.
const itemClean = remoteSummary({ board: { checklist: { items: [
  { text: "call bob@example.com about /tmp/job" },
  { text: "bob@example.com /home/x" },
] } } });
assert.ok(itemClean.includes("· 1 call about"), "item tokens are stripped like the goal's");
assert.ok(itemClean.includes("· 2 (no text)"), "an item that cleans to nothing shows (no text)");

// ---------- clip() boundaries ----------

// clip fires only past the limit; the ellipsis replaces the last char.
const g80 = remoteSummary({ goal: "x".repeat(80) }).split("\n")[0];
assert.equal(g80, `Goal: ${"x".repeat(80)}`, "80 chars is not clipped");
const g81 = remoteSummary({ goal: "x".repeat(81) }).split("\n")[0];
assert.equal(g81.length, "Goal: ".length + 80);
assert.ok(g81.endsWith("…"), "81 chars clips to 80 ending in ellipsis");
// Item text clips at 40.
const i39 = remoteSummary({ board: { checklist: { items: [{ text: "y".repeat(39) }] } } });
assert.ok(i39.includes("y".repeat(39)), "39 chars not clipped");
const i41 = remoteSummary({ board: { checklist: { items: [{ text: "y".repeat(41) }] } } });
const i41line = i41.split("\n").find((l) => l.includes("…"));
assert.ok(i41line && i41line.endsWith("…"), "41 chars clips to 40 ending in ellipsis");
assert.equal(i41line.length, "· 1 ".length + 40);
// clip() trims trailing whitespace before the ellipsis.
const spaced = remoteSummary({ goal: `${"x".repeat(79)}   tail` });
assert.ok(spaced.split("\n")[0].endsWith("…"), "clip trims then ellipsizes");

// ---------- checklist items: shapes and numbering ----------

// items must be an array; every other shape yields no checklist section.
for (const items of ["nope", {}, 42, null, undefined]) {
  const out = remoteSummary({ board: { checklist: { items } } });
  assert.ok(!out.includes("Checklist:"), `items ${String(items)}`);
}
// board itself wrong-typed is fine too.
for (const board of ["x", 7, null]) {
  assert.equal(remoteSummary({ board }), MINIMAL, `board ${String(board)}`);
}
// A null/primitive item degrades to "· N (no text)".
const oddItems = remoteSummary({ board: { checklist: { items: [null, "str", 5, {}, { state: "done" }] } } });
assert.ok(oddItems.includes("Checklist: 1/5 done"), "only the real done-state item counts");
assert.ok(oddItems.includes("· 1 (no text)"));
assert.ok(oddItems.includes("· 4 (no text)"), "item {} gets index 4");
assert.ok(oddItems.includes("✓ 5 (no text)"), "done item with no text still counts and shows");
// state is matched exactly and case-sensitively for both glyph and done count.
const states = remoteSummary({ board: { checklist: { items: [
  { state: "DONE", text: "a" }, { state: " done ", text: "b" }, { state: "Done", text: "c" }, { state: "done", text: "d" },
] } } });
assert.ok(states.includes("Checklist: 1/4 done"), "only exact 'done' counts");
assert.ok(states.includes("· 1 a") && states.includes("· 2 b") && states.includes("· 3 c"), "near-miss states get the todo glyph");
// Unknown states also get "·" — the glyph table has no other fallback.
const weird = remoteSummary({ board: { checklist: { items: [{ state: "mystery", text: "x" }] } } });
assert.ok(weird.includes("· 1 x"));
// n handling: finite numbers print raw (including non-integers and strings that
// coerce), non-finite/non-numeric fall back to the 1-based index — but
// null/false/[] coerce to 0 and print their STRING FORM, which is ugly.
const nums = remoteSummary({ board: { checklist: { items: [
  { n: 2.5, text: "a" }, { n: "7", text: "b" }, { n: "abc", text: "c" },
  { n: null, text: "d" }, { n: false, text: "e" }, { n: [], text: "f" }, { n: {}, text: "g" }, { n: Infinity, text: "h" },
] } } });
assert.ok(nums.includes("· 2.5 a"), "float n prints raw");
assert.ok(nums.includes("· 7 b"), "numeric string n prints raw");
assert.ok(nums.includes("· 3 c"), "'abc' falls back to index 3");
assert.ok(nums.includes("· null d"), "null n coerces to 0 and prints 'null'");
assert.ok(nums.includes("· false e"), "false n prints 'false'");
assert.ok(nums.includes("·  f"), "[] n prints as empty string");
assert.ok(nums.includes("· 7 g"), "{} n is NaN -> index 7");
assert.ok(nums.includes("· 8 h"), "Infinity n -> index 8");
// Item text: non-strings stringify; newlines are cut to the first line.
const texts = remoteSummary({ board: { checklist: { items: [
  { text: 42 }, { text: {} }, { text: "first\nsecond" }, { text: "   " },
] } } });
assert.ok(texts.includes("· 1 42"));
assert.ok(texts.includes("· 2 [object Object]"));
assert.ok(texts.includes("· 3 first") && !texts.includes("second"), "item text is one line");
assert.ok(texts.includes("· 4 (no text)"), "whitespace text cleans to (no text)");

// ---------- the ~15-line cap, exactly at the boundary ----------

const mkItems = (n) => Array.from({ length: n }, (_, i) => ({ n: i + 1, text: `item ${i + 1}`, state: "todo" }));
// No practice: avail = 15 - 2 (goal+count) - 2 (jobs+limits) = 11 item lines.
const cap11 = remoteSummary({ board: { checklist: { items: mkItems(11) } } }).trimEnd().split("\n");
assert.equal(cap11.length, 15, "11 items fills the cap exactly");
assert.ok(!cap11.some((l) => l.includes("more")), "at the cap nothing is folded");
const cap12 = remoteSummary({ board: { checklist: { items: mkItems(12) } } }).trimEnd().split("\n");
assert.equal(cap12.length, 15, "12 items still 15 lines");
assert.ok(cap12.includes("… 2 more"), "overflow folds with a count");
assert.ok(cap12.filter((l) => l.startsWith("· ")).length === 10, "keep = avail - 1 = 10 items shown");
// With practice the tail is one longer, so the cap shrinks by one.
const capP = remoteSummary({ practice: true, board: { checklist: { items: mkItems(10) } } }).trimEnd().split("\n");
assert.equal(capP.length, 15, "practice: 10 items fills the cap");
const capP11 = remoteSummary({ practice: true, board: { checklist: { items: mkItems(11) } } }).trimEnd().split("\n");
assert.equal(capP11.length, 15);
assert.ok(capP11.includes("… 2 more"), "practice folds one item earlier");
assert.ok(capP11.some((l) => l.includes("Practice run")));
// A giant checklist never exceeds the cap.
const huge = remoteSummary({ board: { checklist: { items: mkItems(500) } } });
assert.ok(huge.trimEnd().split("\n").length <= 15);
assert.ok(huge.includes("… 490 more"), "the fold count is exact: 500 - 10 kept");

// ---------- jobs counting ----------

// Only the exact lowercase strings running/held/finished count; everything
// else — case variants, whitespace-padded, non-strings, null entries — lands
// in "other".
const jobWeird = remoteSummary({ jobs: [
  null, "str", 5, {},
  { status: "Running" }, { status: " running" }, { status: "HELD" },
  { status: "running" }, { status: "held" }, { status: "finished" },
] });
assert.ok(jobWeird.includes("Jobs: 1 running · 1 held · 1 finished · 7 other"), jobWeird.split("\n").find((l) => l.startsWith("Jobs:")));
// jobs must be an array.
for (const jobs of ["x", {}, 9, null]) {
  assert.equal(remoteSummary({ jobs }), MINIMAL, `jobs ${String(jobs)}`);
}
// A job entry with extra fields (worker, title, prompt-looking text) never
// leaks into the summary — only the status is read.
const leaky = remoteSummary({ jobs: [{ status: "running", worker: "Devin", prompt: "secret /home/x a@b.co", report: "leak" }] });
assert.ok(!leaky.includes("secret") && !leaky.includes("leak") && !leaky.includes("Devin"), "only status is read off a job");

// ---------- pace windows ----------

// Title match is String(x?.title): case-insensitive but NOT trimmed. "Session "
// (trailing space) misses, "session" hits, and an array title ["Weekly"]
// stringifies into a hit.
const winMatch = remoteSummary({ pace: { windows: [
  { title: "Session ", used: 0.9 }, { title: ["Weekly"], used: 0.1 }, { title: "SESSION", used: 0.5 },
] } });
assert.ok(winMatch.includes("Limits: Session 50% · Weekly 10%"), winMatch.split("\n").find((l) => l.startsWith("Limits:")));
// Output order is fixed Session-then-Weekly regardless of window order.
const winOrder = remoteSummary({ pace: { windows: [
  { title: "Weekly", used: 0.7 }, { title: "Session", used: 0.3 },
] } });
assert.ok(winOrder.includes("Limits: Session 30% · Weekly 70%"));
// Duplicate titles: find() takes the FIRST match even when it has no usable
// `used` — a later duplicate with real data is never reached.
const dupWin = remoteSummary({ pace: { windows: [
  { title: "Session" }, { title: "Session", used: 0.9 }, { title: "Weekly", used: 0.2 },
] } });
assert.ok(dupWin.includes("Limits: Weekly 20%") && !dupWin.includes("Session"), "first title match wins, even when unusable");
// used goes through Number(): null/""/false coerce to 0 (shown as 0%), numeric
// strings and booleans coerce, everything else is skipped as no-data.
const usedCases = remoteSummary({ pace: { windows: [
  { title: "Session", used: null }, { title: "Weekly", used: "0.5" },
] } });
assert.ok(usedCases.includes("Limits: Session 0% · Weekly 50%"), "null used -> 0%, numeric string -> 50%");
const usedMore = remoteSummary({ pace: { windows: [
  { title: "Session", used: "" }, { title: "Weekly", used: true },
] } });
assert.ok(usedMore.includes("Session 0% · Weekly 100%"), "empty string -> 0, true -> 100%");
const usedSkip = remoteSummary({ pace: { windows: [
  { title: "Session", used: "abc" }, { title: "Weekly", used: Infinity },
] } });
assert.ok(usedSkip.includes("Limits: no data"), "non-numeric and Infinity used are skipped");
// Out-of-range and negative values are shown raw-rounded, not clamped.
const usedRange = remoteSummary({ pace: { windows: [
  { title: "Session", used: 1.5 }, { title: "Weekly", used: -0.2 },
] } });
assert.ok(usedRange.includes("Session 150% · Weekly -20%"), "no clamping to 0..100");
// Rounding is Math.round(used * 100) — and 0.575 * 100 is 57.4999… in binary
// floating point, so it rounds DOWN to 57, not up to 58.
const usedRound = remoteSummary({ pace: { windows: [{ title: "Session", used: 0.575 }] } });
assert.ok(usedRound.includes("Session 57%"), "float edge: 0.575 -> 57%");
const usedRound2 = remoteSummary({ pace: { windows: [{ title: "Session", used: 0.576 }] } });
assert.ok(usedRound2.includes("Session 58%"));
// windows must be an array; non-array and null entries inside are skipped.
for (const windows of ["x", {}, 3, null]) {
  assert.equal(remoteSummary({ pace: { windows } }), MINIMAL, `windows ${String(windows)}`);
}
const nullWins = remoteSummary({ pace: { windows: [null, "Session", 5, { title: "Session", used: 0.4 }] } });
assert.ok(nullWins.includes("Session 40%"), "null/string/number window entries don't crash find()");
// pace itself wrong-typed.
for (const pace of ["x", 7, null, []]) {
  assert.equal(remoteSummary({ pace }), MINIMAL, `pace ${String(pace)}`);
}
// A window title that is itself an object stringifies via String().
const objTitle = remoteSummary({ pace: { windows: [{ title: { toString: () => "Session" }, used: 0.6 }] } });
assert.ok(objTitle.includes("Session 60%"), "object title with toString matches");

// ---------- practice flag ----------

// Any truthy practice value adds the line; falsy ones don't. It is not
// boolean-checked.
for (const p of [1, "yes", {}, []]) {
  assert.ok(remoteSummary({ practice: p }).includes("Practice run"), `practice ${JSON.stringify(p)}`);
}
for (const p of [0, "", null, undefined, false]) {
  assert.ok(!remoteSummary({ practice: p }).includes("Practice run"), `practice ${String(p)}`);
}

// ---------- purity ----------

// remoteSummary only reads: a deeply frozen status produces the same output
// and is not mutated.
const frozen = Object.freeze({
  goal: Object.freeze({ text: Object.freeze("frozen goal") }),
  board: Object.freeze({ checklist: Object.freeze({ items: Object.freeze([Object.freeze({ n: 1, text: "a", state: "done" })]) }) }),
  jobs: Object.freeze([Object.freeze({ status: "running" })]),
  pace: Object.freeze({ windows: Object.freeze([Object.freeze({ title: "Session", used: 0.5 })]) }),
  practice: true,
});
const frozenOut = remoteSummary(frozen);
assert.ok(frozenOut.includes("Goal: frozen goal") && frozenOut.includes("Practice run"));
assert.equal(remoteSummary(frozen), frozenOut, "deterministic on repeated calls");

// ---------- writeRemoteStatus ----------

const wdir = fs.mkdtempSync(path.join(tmp, "write-"));

// Returns the file path it was given.
const wf = path.join(wdir, "a", "status.txt");
assert.equal(writeRemoteStatus({ goal: "hi" }, wf), wf);
// A second write overwrites cleanly (tmp+rename, not append).
writeRemoteStatus({ goal: "second" }, wf);
assert.equal(fs.readFileSync(wf, "utf8"), remoteSummary({ goal: "second" }));
assert.deepEqual(fs.readdirSync(path.dirname(wf)), ["status.txt"], "no tmp left after success");

// Tmp names are unique per call (pid + random suffix), so a stale tmp left by
// a crashed earlier run is never consumed and never in the way — it just
// litters where it was, and a successful write adds no tmp of its own.
const sf = path.join(wdir, "stale.txt");
fs.writeFileSync(`${sf}.crash.tmp`, "crash junk");
writeRemoteStatus({ goal: "ok" }, sf);
assert.equal(fs.readFileSync(sf, "utf8"), remoteSummary({ goal: "ok" }));
assert.ok(fs.existsSync(`${sf}.crash.tmp`), "stale tmp from an old name is left behind");
assert.deepEqual(
  fs.readdirSync(path.dirname(sf)).filter((f) => f.startsWith("stale.txt.") && f.endsWith(".tmp")),
  ["stale.txt.crash.tmp"],
  "a successful write leaves no tmp file of its own",
);

// Failure paths: the tmp file is written BEFORE the rename. A failed rename
// removes the tmp again, so nothing litters; a failed tmp write never reaches
// the rename and the target is never created.
// 1) Target is an existing directory: rename file->dir fails EISDIR.
const dirTarget = path.join(wdir, "is-a-dir");
fs.mkdirSync(dirTarget);
assert.throws(() => writeRemoteStatus({ goal: "x" }, dirTarget), /EISDIR/);
assert.deepEqual(
  fs.readdirSync(wdir).filter((f) => f.startsWith("is-a-dir.")),
  [],
  "failed rename removes the tmp file",
);
assert.equal(fs.readdirSync(dirTarget).length, 0, "the directory itself is untouched");
// 2) A parent component is a regular file: mkdirSync recursive throws ENOTDIR
//    before any tmp is written.
const blocker = path.join(wdir, "blocker");
fs.writeFileSync(blocker, "x");
assert.throws(() => writeRemoteStatus({ goal: "x" }, path.join(blocker, "sub", "f.txt")), /ENOTDIR/);
assert.ok(!fs.existsSync(path.join(blocker, "sub")), "nothing created under the file");
// 3) A tmp write failure never reaches the rename, so the target file is
//    never created. The unique tmp name can't be pre-blocked by a directory,
//    so this path is exercised by the read-only case below.
// 4) Read-only parent directory: the tmp write fails EACCES (skipped when the
//    test runs as root, where perms don't apply).
if (typeof process.getuid === "function" && process.getuid() !== 0) {
  const roDir = path.join(wdir, "readonly");
  fs.mkdirSync(roDir);
  fs.chmodSync(roDir, 0o555);
  try {
    assert.throws(() => writeRemoteStatus({ goal: "x" }, path.join(roDir, "f.txt")), /EACCES/);
    assert.ok(!fs.existsSync(path.join(roDir, "f.txt")), "target absent after tmp-write failure");
  } finally {
    fs.chmodSync(roDir, 0o755);
  }
}

// Regression: writeRemoteStatus is safe for concurrent callers in the same
// process. Worker threads share the pid, so the tmp name carries a random
// suffix per call; two writers can no longer rename each other's tmp away.
// Before the fix this produced ~4400 ENOENT throws over 4 x 3000 writes.
const workerTest = async () => {
  const { Worker } = await import("node:worker_threads");
  const raceFile = path.join(wdir, "race.txt");
  const errs = [];
  const mk = (id) => new Worker(
    `import {parentPort, workerData} from "node:worker_threads";
     const {writeRemoteStatus} = await import(workerData.mod);
     for (let i = 0; i < 500; i++) {
       try { writeRemoteStatus({ goal: "w" + workerData.id + "-" + i }, workerData.file); }
       catch (e) { parentPort.postMessage(e.code); }
     }
     parentPort.postMessage("done");`,
    { eval: true, workerData: { mod: new URL("./constance-remote.mjs", import.meta.url).href, file: raceFile, id } },
  );
  const workers = [mk(0), mk(1), mk(2), mk(3)];
  workers.forEach((w) => w.on("message", (m) => { if (m !== "done") errs.push(m); }));
  await Promise.all(workers.map((w) => new Promise((r) => w.once("exit", r))));
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(errs, [], "concurrent same-file writes must not throw");
  assert.ok(fs.existsSync(raceFile));
};
await workerTest();

fs.rmSync(tmp, { recursive: true, force: true });
console.log("constance-remote.deep: ok");
