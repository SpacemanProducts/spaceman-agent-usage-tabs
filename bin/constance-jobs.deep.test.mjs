// Deeper edge-case pass on bin/constance-jobs.mjs, complementing
// constance-jobs.test.mjs. Covers stateDir env fallbacks, overlaps/conflicts
// boundary shapes, reviewQueue ordering and non-mutation, settling/inHand clock
// edges, handoffPrompt wrong-type and degenerate inputs, openStore's corrupt
// and wrong-shape jobs.json handling, readLog slicing/parsing edges, and the
// jobs.lock races (fresh lock waits then fails, stale lock is broken, a
// poisoned lock is never cleared). Everything lives under one mkdtemp dir with
// HOME and the XDG vars pointed there; the real home is never touched.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore, overlaps, conflicts, handoffPrompt, reviewQueue, doneFile, stateDir, settling, inHand, SETTLE_MS, STATUSES } from "./constance-jobs.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "constance-jobs-deep-"));
process.env.HOME = path.join(tmp, "home");
fs.mkdirSync(process.env.HOME, { recursive: true });
for (const v of ["XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
  process.env[v] = path.join(tmp, v.toLowerCase());
  fs.mkdirSync(process.env[v], { recursive: true });
}

try {
  // ---------- stateDir: env fallbacks ----------

  assert.equal(stateDir({ XDG_STATE_HOME: "/s", HOME: "/h" }), "/s/omarchy/agent-usage-tabs/constance", "XDG_STATE_HOME wins over HOME");
  assert.equal(stateDir({ HOME: "/h" }), "/h/.local/state/omarchy/agent-usage-tabs/constance", "HOME fallback");
  assert.equal(stateDir({ XDG_STATE_HOME: "", HOME: "/h" }), "/h/.local/state/omarchy/agent-usage-tabs/constance", "empty XDG_STATE_HOME falls back");
  assert.equal(stateDir({}), path.join(os.homedir(), ".local/state/omarchy/agent-usage-tabs/constance"), "no env at all uses os.homedir()");
  const envObj = { XDG_STATE_HOME: "/s" };
  stateDir(envObj);
  assert.deepEqual(envObj, { XDG_STATE_HOME: "/s" }, "stateDir does not mutate the env it is given");

  // ---------- overlaps: shapes the first test does not reach ----------

  assert.deepEqual(overlaps([], []), []);
  assert.deepEqual(overlaps(["a"], []), []);
  assert.deepEqual(overlaps([], ["a"]), []);
  // Duplicate pairs collapse through the Set.
  assert.deepEqual(overlaps(["x"], ["x", "x"]), ["x"]);
  // A prefix that is not a path segment does not overlap: "src" vs "src2/f".
  assert.deepEqual(overlaps(["src"], ["src2/f.js"]), []);
  assert.deepEqual(overlaps(["src2/f.js"], ["src"]), []);
  // Trailing slashes are stripped before comparing.
  assert.deepEqual(overlaps(["a/"], ["a"]), ["a"]);
  assert.deepEqual(overlaps(["a/b/"], ["a/b/c"]), ["a/b ~ a/b/c"]);
  // Only ONE leading "./" is stripped: "././a" normalizes to "./a", which no
  // longer equals "a" — a quirk worth pinning.
  assert.deepEqual(overlaps(["././a"], ["a"]), [], "double ./ prefix survives one strip");
  // Internal "//" is never collapsed either.
  assert.deepEqual(overlaps(["a//b"], ["a/b"]), []);
  // "." on either side overlaps everything; the hit keeps the "x ~ y" form.
  assert.deepEqual(overlaps(["."], ["."]), ["."]);
  assert.deepEqual(overlaps(["."], ["x"]), [". ~ x"]);
  assert.deepEqual(overlaps(["x"], ["."]), ["x ~ ."]);
  // Matching is case-sensitive.
  assert.deepEqual(overlaps(["A.js"], ["a.js"]), []);
  // Non-string entries are stringified, so null and 5 can "overlap".
  assert.deepEqual(overlaps([null], [null]), ["null"]);
  assert.deepEqual(overlaps([5], ["5"]), ["5"]);
  // ".." is not resolved: "a/../b" is just a string.
  assert.deepEqual(overlaps(["a/../b"], ["b"]), []);

  // ---------- conflicts: statuses, repo-vs-dir, malformed jobs ----------

  const mk = (id, status, extra = {}) => ({ id, status, dir: "/p", files: ["f.js"], ...extra });
  for (const st of STATUSES) {
    const hit = conflicts([mk(1, st)], "/p", ["f.js"]).length === 1;
    const expected = ["waiting", "running", "finished"].includes(st);
    assert.equal(hit, expected, `status "${st}" ${expected ? "blocks" : "does not block"}`);
  }
  assert.equal(conflicts([mk(1, "held")], "/p", ["f.js"]).length, 1, "held is not in STATUSES but still reserves files");
  // j.repo wins over j.dir for the folder match.
  const repoJob = { id: 1, status: "running", repo: "/r", dir: "/d", files: ["f.js"] };
  assert.equal(conflicts([repoJob], "/r", ["f.js"]).length, 1, "repo is the match key when present");
  assert.equal(conflicts([repoJob], "/d", ["f.js"]).length, 0, "dir is ignored when repo is set");
  // Folder matching is an exact string compare.
  assert.equal(conflicts([mk(1, "running")], "/p/", ["f.js"]).length, 0, "trailing slash is a different folder");
  assert.equal(conflicts([mk(1, "running")], "/P", ["f.js"]).length, 0, "case-sensitive folder");
  // A job with no files never conflicts; files:undefined is tolerated.
  assert.equal(conflicts([{ id: 1, status: "running", dir: "/p" }], "/p", ["f.js"]).length, 0);
  assert.equal(conflicts([mk(1, "running", { files: [] })], "/p", ["f.js"]).length, 0, "empty file list overlaps nothing");
  // files:null is a wrong type: overlaps() calls .map on it and throws.
  assert.throws(() => conflicts([mk(1, "running", { files: null })], "/p", ["f.js"]), TypeError);
  // A job with neither repo nor dir only "matches" an undefined dir argument.
  assert.equal(conflicts([{ id: 1, status: "running", files: ["f.js"] }], undefined, ["f.js"]).length, 1,
    "undefined === undefined dir matches a dir-less job");

  // ---------- reviewQueue: ordering edges and non-mutation ----------

  const rqIn = [
    { id: 5, status: "finished" },                          // no finishedAt -> 0
    { id: 2, status: "finished", finishedAt: 10 },
    { id: 3, status: "finished", finishedAt: 10 },          // tie -> id order
    { id: 1, status: "finished", finishedAt: -5 },          // negative sorts first
    { id: 4, status: "running", finishedAt: 1 },
  ];
  const rqOut = reviewQueue(rqIn);
  assert.deepEqual(rqOut.map((j) => j.id), [1, 5, 2, 3], "finishedAt ascending, ties by id, missing counts as 0");
  assert.notEqual(rqOut, rqIn, "returns a new array");
  assert.deepEqual(rqIn.map((j) => j.id), [5, 2, 3, 1, 4], "the input array is not reordered");
  assert.deepEqual(reviewQueue([]), []);

  // ---------- settling / inHand: clock edges ----------

  const now = 1_700_000_000_000;
  assert.equal(settling({ settling: now - SETTLE_MS }, now), false, "exactly SETTLE_MS old is no longer settling");
  assert.equal(settling({ settling: now - SETTLE_MS + 1 }, now), true, "one ms inside the window settles");
  assert.equal(settling({ settling: now + 999_999 }, now), true, "a future marker still counts (clock skew)");
  assert.equal(settling({ settling: "soon" }, now), false, "a non-numeric marker is NaN and never settles");
  assert.equal(settling({ settling: 0 }, now), false, "0 is falsy, not a timestamp");
  assert.equal(settling({ settling: null }, now), false);
  assert.equal(inHand({ selfMerging: 1 }, now), true, "any truthy selfMerging counts");
  assert.equal(inHand({ settling: now - SETTLE_MS - 1 }, now), false, "expired settle marker is not in hand");

  // ---------- handoffPrompt: coercion and degenerate inputs ----------

  // task is stringified: numbers, null and objects all produce text.
  assert.match(handoffPrompt({ id: 1, dir: "/p", task: 42 }), /Task \(job 1[^\n]*\n42\n/);
  assert.match(handoffPrompt({ id: 1, dir: "/p", task: null }), /\nnull\n/);
  const multi = handoffPrompt({ id: 1, dir: "/p", task: "  first\nsecond  " });
  assert.ok(multi.includes("\nfirst\nsecond\n"), "task is trimmed but interior newlines survive");
  // files:null is read-only like files:[], but a non-empty string is a wrong
  // type: files.length is truthy and files.join does not exist.
  assert.match(handoffPrompt({ id: 1, dir: "/p", task: "t", files: null }), /read-only job/);
  assert.throws(() => handoffPrompt({ id: 1, dir: "/p", task: "t", files: "a.js" }), TypeError);
  // account variants: missing label (empty string, 0, non-object) adds no line.
  for (const account of [{}, { label: "" }, { label: 0 }, "Work", null]) {
    assert.doesNotMatch(handoffPrompt({ id: 1, dir: "/p", task: "t", account }), /Account:/, `account ${JSON.stringify(account)} adds no line`);
  }
  // Degenerate worktree: branch "" still takes the worktree branch of the
  // prompt, producing an empty "(branch )" — pinned as-is.
  const wtNoBranch = handoffPrompt({ id: 1, dir: "/repo", task: "t", files: ["a"], worktree: "/wt", branch: "", mainDir: "" });
  assert.match(wtNoBranch, /\(branch \)/, "empty branch renders literally");
  assert.match(wtNoBranch, /of the project \/repo/, "missing mainDir falls back to dir");
  assert.doesNotMatch(wtNoBranch, / or merge/, "empty branch drops the merge warning");
  // worktree:"" with a branch set is treated as a plain folder job.
  assert.match(handoffPrompt({ id: 1, dir: "/p", task: "t", files: ["a"], worktree: "", branch: "b" }), /^Check: this job is for the project folder/);
  // extra is appended after a blank line only when truthy.
  assert.ok(handoffPrompt({ id: 1, dir: "/p", task: "t" }, "").endsWith('"files": ["the files you changed"]}.'), "empty extra adds nothing");
  const withExtra = handoffPrompt({ id: 1, dir: "/p", task: "t" }, "GUARDRAILS:\n- be nice");
  assert.ok(withExtra.endsWith('"files": ["the files you changed"]}.\n\nGUARDRAILS:\n- be nice'), "extra trails the done-file line");
  // id is interpolated raw: 0 and strings both work.
  assert.ok(handoffPrompt({ id: 0, dir: "/p", task: "t" }).includes("job 0"));
  assert.ok(handoffPrompt({ id: "abc", dir: "/p", task: "t" }).includes(doneFile("/p", "abc")));
  // File order in the edit list is the order given.
  assert.match(handoffPrompt({ id: 1, dir: "/p", task: "t", files: ["b.js", "a.js"] }), /Only edit these files: b\.js, a\.js/);

  // ---------- openStore: corrupt and wrong-shape jobs.json ----------

  const storeDir = (name, content) => {
    const d = path.join(tmp, name);
    fs.mkdirSync(d, { recursive: true });
    if (content !== undefined) fs.writeFileSync(path.join(d, "jobs.json"), content);
    return d;
  };
  const expectDefault = (d) => assert.deepEqual(openStore(d).read(), { goal: null, jobs: [], next: 1, guards: {} });

  expectDefault(storeDir("missing"));                                   // no file at all
  expectDefault(storeDir("garbage", "not json {{{"));                    // unparseable
  expectDefault(storeDir("nul", "null"));                                // JSON null
  expectDefault(storeDir("num", "42"));                                  // JSON number
  expectDefault(storeDir("arr", "[1,2,3]"));                             // JSON array
  expectDefault(storeDir("emptyobj", "{}"));                             // empty object
  // Partial shapes: each missing/wrong field falls back independently.
  assert.deepEqual(openStore(storeDir("partial", JSON.stringify({ goal: "g", jobs: "nope", next: 0, guards: null }))).read(),
    { goal: "g", jobs: [], next: 1, guards: {} }, "falsy next/guards normalize, string jobs does not");
  // Truthy wrong types pass through untouched.
  assert.deepEqual(openStore(storeDir("weird", JSON.stringify({ goal: 7, jobs: { 0: {} }, next: "abc", guards: "x" }))).read(),
    { goal: 7, jobs: [], next: "abc", guards: "x" }, "read() does no type checking beyond Array.isArray(jobs)");
  // A real guards map survives.
  assert.deepEqual(openStore(storeDir("guards", JSON.stringify({ guards: { g1: { ok: true } } }))).read().guards, { g1: { ok: true } });
  // jobs.json that is a directory reads as the default state.
  const dirAsJobs = path.join(tmp, "dirasjobs");
  fs.mkdirSync(path.join(dirAsJobs, "jobs.json"), { recursive: true });
  expectDefault(dirAsJobs);
  // openStore on a path that is a file cannot mkdir and throws.
  const fileDir = path.join(tmp, "filedir");
  fs.writeFileSync(fileDir, "i am a file");
  assert.throws(() => openStore(fileDir));

  // ---------- openStore: read freshness and update semantics ----------

  const s = openStore(storeDir("live"));
  const d1 = s.read();
  d1.jobs.push({ id: 99, status: "running" });
  assert.deepEqual(s.read().jobs, [], "mutating a read() result does not touch the file");
  // update() persists in-place mutations of d and returns fn's return value;
  // a returned replacement object is ignored — only d is written.
  const ret = s.update((d) => { d.goal = "real goal"; return { goal: "fake" }; });
  assert.deepEqual(ret, { goal: "fake" }, "update returns whatever fn returns");
  assert.equal(s.read().goal, "real goal", "the mutated state is what gets written");
  s.update((d) => ({ ...d, goal: "never saved" }));
  assert.equal(s.read().goal, "real goal", "returning a new object without mutating d saves nothing");
  // The file is pretty-printed JSON with a trailing newline; no tmp leftovers.
  const raw = fs.readFileSync(s.file, "utf8");
  assert.ok(raw.endsWith("}\n"), "jobs.json ends with a newline");
  assert.deepEqual(JSON.parse(raw).goal, "real goal");
  assert.deepEqual(fs.readdirSync(s.dir).filter((f) => f.endsWith(".tmp")), [], "no tmp files left behind");
  // A corrupt next counter flows through: "abc"++ is NaN, which JSON writes as null.
  const badNext = openStore(storeDir("badnext", JSON.stringify({ next: "abc", jobs: [] })));
  badNext.update((d) => { d.jobs.push({ id: d.next++, status: "waiting" }); });
  assert.equal(badNext.read().jobs[0].id, null, "NaN id serializes to null in jobs.json");
  // Two store objects on the same dir see each other's writes (the lock is
  // per-call, not per-handle).
  const s2 = openStore(s.dir);
  s2.update((d) => { d.jobs.push({ id: 1000, status: "waiting" }); });
  assert.equal(s.read().jobs.at(-1).id, 1000);

  // ---------- log / readLog ----------

  const ls = openStore(storeDir("logs"));
  assert.deepEqual(ls.readLog(), [], "missing log file reads empty");
  for (let i = 1; i <= 5; i++) ls.log({ kind: "k", i });
  assert.equal(ls.readLog().length, 5);
  assert.equal(ls.readLog(2).length, 2);
  assert.deepEqual(ls.readLog(2).map((e) => e.i), [4, 5], "slice(-n) keeps the NEWEST n entries");
  assert.equal(ls.readLog(99).length, 5, "n larger than the log returns everything");
  assert.equal(ls.readLog(1)[0].i, 5);
  // An entry's own `at` field overrides the timestamp the logger adds.
  ls.log({ kind: "custom", at: 42 });
  assert.equal(ls.readLog().at(-1).at, 42, "entry.at wins over Date.now()");
  assert.equal(typeof ls.readLog()[0].at, "number", "normal entries get a numeric at");
  // One corrupt line makes the WHOLE readLog return [] — the parse is inside
  // the same try as the read, so there is no partial recovery.
  fs.appendFileSync(ls.logFile, "this is not json\n");
  assert.deepEqual(ls.readLog(), [], "a single bad line discards the entire log read");
  // A whitespace-only line is just as fatal mid-file (JSON.parse('   ')
  // throws); a TRAILING one is eaten by trim() and harmless.
  const ls2 = openStore(storeDir("logs2"));
  ls2.log({ kind: "ok" });
  fs.appendFileSync(ls2.logFile, "   \n");
  assert.equal(ls2.readLog().length, 1, "a trailing whitespace line is trimmed away");
  ls2.log({ kind: "after" });
  assert.deepEqual(ls2.readLog(), [], "once a later entry lands, the whitespace line is mid-file and nukes the read");
  // logFile as a directory: appendFileSync throws.
  const ls3dir = storeDir("logdir");
  fs.mkdirSync(path.join(ls3dir, "log.jsonl"), { recursive: true });
  assert.throws(() => openStore(ls3dir).log({ kind: "x" }));
  assert.deepEqual(openStore(ls3dir).readLog(), [], "but readLog on it still reads empty");
  // n <= 0 asks for no entries: slice(-0) is slice(0), which would return
  // EVERY line, and a negative n would silently drop the first |n| lines.
  // Pinned on a clean store (ls/ls2 above have corrupt logs that mask it).
  const ls4 = openStore(storeDir("logs4"));
  for (let i = 1; i <= 3; i++) ls4.log({ kind: "k", i });
  assert.deepEqual(ls4.readLog(0), [], "readLog(0) returns no entries");
  assert.deepEqual(ls4.readLog(-1), [], "readLog(-1) returns no entries");
  assert.deepEqual(ls4.readLog("2").map((e) => e.i), [1, 2, 3], "a non-number n uses the default, not the string");

  // ---------- jobs.lock: the races ----------

  // A fresh lock makes update() spin ~5 s (200 x 25 ms) then throw; the lock
  // belongs to someone else and is left in place.
  const locked = storeDir("locked");
  const lockPath = path.join(locked, "jobs.lock");
  fs.mkdirSync(lockPath);
  const t0 = Date.now();
  assert.throws(() => openStore(locked).update((d) => d), /job file is locked/);
  assert.ok(Date.now() - t0 >= 4000, "the lock wait actually waited (~5 s of retries)");
  assert.ok(fs.existsSync(lockPath), "a lock we never acquired is not removed by the failed update");

  // A lock older than 10 s is stale: update() breaks it and proceeds.
  const staleDir = storeDir("stale");
  const staleLock = path.join(staleDir, "jobs.lock");
  fs.mkdirSync(staleLock);
  const old = new Date(Date.now() - 20000);
  fs.utimesSync(staleLock, old, old);
  const staleStore = openStore(staleDir);
  const staleId = staleStore.update((d) => { d.jobs.push({ id: d.next, status: "waiting" }); return d.next++; });
  assert.equal(staleId, 1, "stale lock was broken and the update ran");
  assert.ok(!fs.existsSync(staleLock), "the stale lock dir was removed");

  // A lock dir with anything inside can never be rmdir'd: even when stale,
  // rmdirSync throws ENOTEMPTY, the error is swallowed, and update() retries
  // until it gives up — a poisoned lock bricks the store permanently.
  const poisonDir = storeDir("poison");
  const poisonLock = path.join(poisonDir, "jobs.lock");
  fs.mkdirSync(poisonLock);
  fs.writeFileSync(path.join(poisonLock, "holder"), "x");
  const pold = new Date(Date.now() - 20000);
  fs.utimesSync(poisonLock, pold, pold);
  assert.throws(() => openStore(poisonDir).update((d) => d), /job file is locked/, "non-empty stale lock is never cleared");

  // jobs.lock as a regular file also blocks forever (mkdirSync EEXIST, and
  // rmdirSync could never remove it anyway).
  const fileLockDir = storeDir("filelock");
  fs.writeFileSync(path.join(fileLockDir, "jobs.lock"), "x");
  assert.throws(() => openStore(fileLockDir).update((d) => d), /job file is locked/);

  // A failed update inside the lock still releases it (covered by the first
  // test for the throw path; here for a stale-lock-then-throw path).
  const relDir = storeDir("release");
  const relStore = openStore(relDir);
  assert.throws(() => relStore.update(() => { throw new Error("inner"); }), /inner/);
  assert.ok(!fs.existsSync(path.join(relDir, "jobs.lock")), "lock released after fn threw");
  relStore.update((d) => { d.goal = "after"; });
  assert.equal(relStore.read().goal, "after", "store usable again after a failed update");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log("constance-jobs.deep: tests passed");
