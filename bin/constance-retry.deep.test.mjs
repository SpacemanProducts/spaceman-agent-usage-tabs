// Deeper edge-case tests for bin/constance-retry.mjs: coercion quirks,
// malformed job records, boundary splits and degenerate inputs. The module is
// pure (no fs, no clock, no shared state), so the temp HOME/XDG dirs below are
// only a safety rail — nothing here should ever read the real home folder.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sameFiles, chain, secondTry, sendBackAdvice, shouldAutoRetry, retrySpec } from "./constance-retry.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "constance-retry-deep-"));
for (const [k, v] of Object.entries({ HOME: dir, XDG_STATE_HOME: path.join(dir, "state"), XDG_CONFIG_HOME: path.join(dir, "config"), XDG_CACHE_HOME: path.join(dir, "cache") })) {
  process.env[k] = v;
}

const sentBack = (id, files, againOf, extra = {}) => ({ id, status: "sent back", files, ...(againOf != null ? { againOf } : {}), ...extra });
const other = (id, status, files, againOf, extra = {}) => ({ id, status, files, ...(againOf != null ? { againOf } : {}), ...extra });
const AB = ["a.txt", "b.txt"];

// ---- sameFiles: coercion inside fileSet.
{
  // Entries are String()-coerced then trimmed: numbers and numeric strings
  // are the same path; only blank strings drop out (see below for the rest).
  assert.equal(sameFiles([5], ["5"]), true, "number 5 and string '5' are the same path");
  // Only blank strings drop out: null/undefined/false stringify to literal
  // path names "null"/"undefined"/"false" rather than being filtered.
  assert.equal(sameFiles([null], ["null"]), true, "null becomes the path 'null'");
  assert.equal(sameFiles([undefined], ["undefined"]), true);
  assert.equal(sameFiles([false], ["false"]), true);
  assert.equal(sameFiles([null, " a.txt ", ""], ["a.txt"]), false, "the 'null' entry makes the sets differ");
  // Whitespace-only strings are filtered too, so they can't fake a match.
  assert.equal(sameFiles(["   "], ["a.txt"]), false);
  assert.equal(sameFiles(["   "], []), false);
  // BUG: two unrelated corrupt records that both carry files:[null] collide
  // as 'the same work' — chain() would link them and count toward the
  // second-try limit. null entries should be dropped, not stringified.
  // assert.equal(sameFiles([null, null], [null]), false, "null entries are not a real file set");
  // Non-array inputs are a contract violation: fileSet calls .map on them.
  assert.throws(() => sameFiles("a.txt", ["a.txt"]), TypeError);
  assert.throws(() => sameFiles(5, ["5"]), TypeError);
  assert.throws(() => sameFiles({}, ["a.txt"]), TypeError, "a plain object has no .map");
  // …but falsy non-arrays degrade to 'no files' via the || [] fallback.
  assert.equal(sameFiles(null, ["a.txt"]), false);
  assert.equal(sameFiles(undefined, ["a.txt"]), false);
  assert.equal(sameFiles(null, null), false);
  // BUG: two different non-string objects both stringify to "[object Object]",
  // so sameFiles([{x:1}], [{y:2}]) is true — a corrupt record could link
  // unrelated work as 'the same files'.
  // assert.equal(sameFiles([{ x: 1 }], [{ y: 2 }]), false, "distinct objects must not collide");
}

// ---- chain: id typing, duplicate ids, status exactness, sort order.
{
  // Ids are matched strictly: againOf "7" (string) does not reach job 7.
  const linkedOnly = [sentBack(4, ["x.txt"]), sentBack(7, ["y.txt"], 4)];
  assert.deepEqual(chain(linkedOnly, { files: ["z.txt"], againOf: 7 }), [4, 7], "numeric againOf walks the link chain");
  assert.deepEqual(chain(linkedOnly, { files: ["z.txt"], againOf: "7" }), [], "a string againOf finds nothing — ids are not coerced");
  // againOf 0 / "" / false are kept by ?? and looked up literally.
  const zero = [sentBack(0, AB, null), sentBack(1, ["q.txt"], 0)];
  assert.deepEqual(chain(zero, { files: ["q.txt"], againOf: 1 }), [0, 1], "againOf: 0 reaches job id 0");
  // A dangling againOf stops the walk without error: 7 links to 99, which is
  // absent, so only 7 itself is found — 4 is not reachable and files don't match.
  const dangling = [sentBack(4, AB), sentBack(7, AB, 99)];
  assert.deepEqual(chain(dangling, { files: ["z.txt"], againOf: 7 }), [7]);
  // Status must be exactly 'sent back': case and spelling variants don't count.
  const variants = [other(1, "Sent back", AB), other(2, "sent-back", AB), other(3, "sent Back", AB), sentBack(4, AB)];
  assert.deepEqual(chain(variants, { files: AB }), [4], "only the exact status string is sent back");
  // Numeric (not lexicographic) sort: 2 before 10.
  const wide = [sentBack(10, AB), sentBack(2, AB)];
  assert.deepEqual(chain(wide, { files: AB }), [2, 10]);
  // Duplicate ids: the Map keeps the LAST entry, and the sent-back filter
  // reads through it — an accepted twin hides a sent-back original.
  const dup = [sentBack(1, AB), other(1, "accepted", AB)];
  assert.deepEqual(chain(dup, { files: AB }), [], "last record wins for duplicate ids");
  const dupRev = [other(1, "accepted", AB), sentBack(1, AB)];
  assert.deepEqual(chain(dupRev, { files: AB }), [1], "…and the reverse order reports it");
  // A sent-back job with empty files never matches by file set.
  const emptyFiles = [sentBack(5, []), sentBack(6, ["  "])];
  assert.deepEqual(chain(emptyFiles, { files: AB }), []);
  // A three-job againOf loop terminates and reports all sent-back members.
  const tri = [sentBack(1, AB, 3), sentBack(2, AB, 1), sentBack(3, AB, 2)];
  assert.deepEqual(chain(tri, { files: ["nope"], againOf: 2 }), [1, 2, 3]);
  // Non-array jobs / null entries are contract violations and throw.
  assert.throws(() => chain(null, {}), TypeError);
  assert.throws(() => chain(undefined, {}), TypeError);
  assert.throws(() => chain([null], {}), TypeError, "a null job record crashes the id map");
  assert.throws(() => chain([{ id: 1, status: "sent back", files: "a.txt" }], { files: ["a.txt"] }), TypeError,
    "a corrupt record whose files is a string crashes sameFiles");
}

// ---- secondTry: split must be a strict subset of EVERY chain job.
{
  // Chain jobs with different file sets: the split has to shrink below all of
  // them, not just the againOf target.
  const mixed = [sentBack(4, AB), sentBack(7, [...AB, "c.txt"], 4)];
  const prop = { files: AB, againOf: 7 };
  const blocked = secondTry(mixed, prop);
  assert.deepEqual(blocked.ids, [4, 7]);
  assert.equal(blocked.reason, "Jobs 4 and 7 were already sent back for this work. Don't resend it: split it into smaller jobs (fewer files each) or do it yourself.");
  // ["a.txt"] is a strict subset of both {a,b} and {a,b,c}: allowed.
  assert.equal(secondTry(mixed, { files: ["a.txt"], againOf: 7 }), null);
  // ["a.txt","b.txt"] equals job 4's set — not strict — so still blocked.
  assert.equal(secondTry(mixed, prop).ids.join(), "4,7");
  // Disjoint files still get blocked when againOf pulls the whole chain in:
  // the walk finds both sent-back jobs regardless of the proposal's file set.
  const disjoint = secondTry(mixed, { files: ["c.txt"], againOf: 7 });
  assert.deepEqual(disjoint.ids, [4, 7], "againOf links the chain even when files match nothing");
  // Without againOf, disjoint files find no chain at all.
  assert.equal(secondTry(mixed, { files: ["c.txt"] }), null);
  // Whitespace-only proposal files count as read-only: never blocked.
  assert.equal(secondTry(mixed, { files: ["   ", ""], againOf: 7 }), null);
  // Exactly two sent-backs is the block threshold; the boundary ids list uses 'and'.
  const two = [sentBack(4, AB), sentBack(7, AB, 4)];
  assert.equal(secondTry(two, { files: AB, againOf: 7 }).ids.length, 2);
  // Non-object / null proposals are contract violations.
  assert.throws(() => secondTry(two, null), TypeError, "null proposal has no .files");
  // A string proposal degrades quietly: .files is undefined -> read-only -> null.
  assert.equal(secondTry(two, "a.txt"), null);
  assert.throws(() => secondTry(null, { files: AB }), TypeError, "null jobs array");
}

// ---- sendBackAdvice: dedup, escalation text, degenerate job fields.
{
  const jobs = [sentBack(4, AB), sentBack(7, AB, 4)];
  // The job being sent back is already inside the chain: Set dedups its id,
  // so the count stays honest.
  assert.equal(sendBackAdvice(jobs, { id: 7, files: AB, againOf: 4 }),
    "This work has now been sent back twice (jobs 4 and 7): split it into smaller jobs or do it yourself. A new handoff with the same files will be refused.");
  // A third send-back gets the same wording — there is no escalation.
  assert.equal(sendBackAdvice(jobs, { id: 9, files: AB, againOf: 7 }),
    "This work has now been sent back twice (jobs 4, 7 and 9): split it into smaller jobs or do it yourself. A new handoff with the same files will be refused.");
  // againOf through a non-sent-back intermediate still reaches the chain.
  const throughAccepted = [sentBack(4, AB), other(5, "accepted", AB, 4), sentBack(8, AB, 5)];
  assert.equal(sendBackAdvice(throughAccepted, { id: 10, files: AB, againOf: 8 }),
    "This work has now been sent back twice (jobs 4, 8 and 10): split it into smaller jobs or do it yourself. A new handoff with the same files will be refused.");
  // A job with no id still produces advice — with a dangling 'and'.
  const noId = sendBackAdvice([sentBack(4, AB)], { files: AB });
  // BUG: a missing job.id yields "(jobs 4 and )" — undefined is dropped by
  // join, leaving broken user-facing text. Every real caller passes an id, but
  // nothing guards it.
  // assert.ok(!noId.includes("and )"), "advice should not contain an empty id slot");
  assert.equal(noId, "This work has now been sent back twice (jobs 4 and ): split it into smaller jobs or do it yourself. A new handoff with the same files will be refused.");
  // Empty/null job degrades to the empty-history path.
  assert.equal(sendBackAdvice(jobs, {}), "", "no files means no chain, so no advice");
  assert.equal(sendBackAdvice(jobs), "", "default job argument is quiet");
}

// ---- shouldAutoRetry: history coercion, failure-signal boundaries.
{
  const crash = { id: 30, agent: "agy", files: AB, status: "finished", summary: "(the agent exited without writing its done file)" };
  // history that isn't an array falls back to [job] — no crash.
  assert.equal(shouldAutoRetry(crash, "junk"), true, "string history is ignored");
  assert.equal(shouldAutoRetry(crash, {}), true, "object history is ignored");
  assert.equal(shouldAutoRetry(crash, null), true, "null history is ignored");
  assert.equal(shouldAutoRetry(crash, 0), true, "falsy non-array history is ignored");
  // history entries that aren't objects still reach chain() and crash there —
  // covered under the failure-signal section below.
}

// ---- retrySpec: output slicing, coercion, surrogate boundary.
{
  const job = { id: 40, agent: "devin", files: AB, task: "Do the thing." };
  // Exactly 1500 chars survives whole; 1501 loses exactly the first char.
  const exact = retrySpec(job, { errorOutput: "e".repeat(1500) });
  assert.ok(exact.task.endsWith("e".repeat(1500)));
  assert.ok(exact.task.includes("e".repeat(1500)));
  const over = retrySpec(job, { errorOutput: "HEAD" + "e".repeat(1500) });
  assert.ok(!over.task.includes("HEAD"), "the 1501st char and beyond are cut");
  assert.ok(over.task.endsWith("e".repeat(1500)));
  // Non-string errorOutput is String()-coerced; null/undefined become "".
  assert.ok(retrySpec(job, { errorOutput: 42 }).task.endsWith("42"));
  assert.ok(retrySpec(job, { errorOutput: null }).task.endsWith("failed with:\n"));
  assert.ok(retrySpec(job, { errorOutput: { toString: () => "OBJ" } }).task.endsWith("OBJ"));
  // task is trimmed before the failure section is appended.
  assert.ok(retrySpec({ ...job, task: "  padded task \n\n" }, { errorOutput: "x" }).task.startsWith("padded task\n\nLast try failed with:"));
  // retrySpec(null) degrades quietly; a null options object throws.
  assert.deepEqual(retrySpec(null, {}), { agent: undefined, files: [], task: "\n\nLast try failed with:\n", again: undefined });
  assert.throws(() => retrySpec(job, null), TypeError);
  // A string `files` spreads into characters.
  const spread = retrySpec({ id: 1, files: "ab.txt", task: "t" });
  // BUG: files: "ab.txt" becomes ['a','b','.','t','x','t'] — a corrupt record
  // hands delegate a list of single-character 'paths'.
  // assert.deepEqual(spread.files, ["ab.txt"], "a string files field should not explode into chars");
  assert.deepEqual(spread.files, ["a", "b", ".", "t", "x", "t"]);
  // Slicing can split a surrogate pair: the tail then carries a lone low
  // surrogate into the prompt.
  const split = retrySpec(job, { errorOutput: "y" + "😀" + "x".repeat(1499) });
  const tail = split.task.split("failed with:\n")[1];
  assert.equal(tail.length, 1500);
  assert.equal(tail.charCodeAt(0), 0xde00, "first kept unit is the emoji's lone low surrogate");
  // BUG: the 1500-char tail can begin mid-emoji, emitting an unpaired
  // surrogate into the worker prompt. Cosmetic, but real.
  // assert.ok(!/[\uD800-\uDFFF]/.test(tail.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "")), "no lone surrogates in the error tail");
}

// ---- failure-signal boundaries inside shouldAutoRetry/jobFailed.
{
  const base = { id: 50, agent: "grok", files: ["a.txt"], status: "finished", summary: "done" };
  // tests field: exact anchored words only.
  for (const t of ["fail", "FAILED", "failing", "no", "none", "No"]) {
    assert.equal(shouldAutoRetry({ ...base, tests: t }, []), true, `tests: ${JSON.stringify(t)} counts as failure`);
  }
  for (const t of [" fail", "fail ", "failed: 2", "no tests", "nope", "passed", "ok", 0, 1, true, null, ""]) {
    assert.equal(shouldAutoRetry({ ...base, tests: t }, []), false, `tests: ${JSON.stringify(t)} is not a failure`);
  }
  assert.equal(shouldAutoRetry({ ...base, tests: false }, []), true, "tests: false is an explicit failure");
  // guardViolation must be a non-empty array; other shapes fall through.
  assert.equal(shouldAutoRetry({ ...base, guardViolation: [] }, []), false, "empty guardViolation array is clean");
  assert.equal(shouldAutoRetry({ ...base, guardViolation: ["x"] }, []), true);
  assert.equal(shouldAutoRetry({ ...base, guardViolation: "changed x" }, []), false, "a string guardViolation is ignored");
  assert.equal(shouldAutoRetry({ ...base, guardViolation: { 0: "x", length: 1 } }, []), false, "array-like non-array is ignored");
  // Crash-summary regex is anchored and case-sensitive.
  for (const s of ["(the agent exited)", "(the agent exited with code 1)", "(done file was not valid JSON)", "(not launched: sandbox)", "(not launched", "(no worktree)", "(no worktrees for job)"]) {
    assert.equal(shouldAutoRetry({ ...base, summary: s }, []), true, `summary ${JSON.stringify(s)} is a crash`);
  }
  for (const s of ["prefix (the agent exited)", "(The agent exited)", "(the Agent exited)", "(agent exited)", "the agent exited without done file", 42, null]) {
    assert.equal(shouldAutoRetry({ ...base, summary: s }, []), false, `summary ${JSON.stringify(s)} is not a crash signal`);
  }
  // autoRetry is a truthiness check: any truthy value blocks.
  const failed = { ...base, tests: false };
  for (const flag of [true, 1, "yes", {}]) {
    assert.equal(shouldAutoRetry({ ...failed, autoRetry: flag }, []), false, `autoRetry ${JSON.stringify(flag)} blocks`);
  }
  assert.equal(shouldAutoRetry({ ...failed, autoRetry: false }, []), true, "autoRetry: false does not block");
  // The 'already retried' history check is strict === on againOf: a numeric
  // match blocks the retry, a string twin of the id does not.
  const crashed = { ...base, id: 50, summary: "(the agent exited)" };
  const retried = { id: 51, agent: "agy", files: ["b.txt"], againOf: 50, autoRetry: true, summary: "(the agent exited)" };
  assert.equal(shouldAutoRetry(crashed, [crashed, retried]), false, "againOf: 50 matches job id 50 — already retried");
  const retriedStr = { ...retried, againOf: "50" };
  assert.equal(shouldAutoRetry(crashed, [crashed, retriedStr]), true,
    "string '50' !== number 50: the auto-retry is not recognised");
  // history entries that are null crash the chain walk.
  // BUG: shouldAutoRetry(job, [null]) throws inside chain()'s jobs.map — a
  // single corrupt record in the jobs array takes down the whole sweep.
  // assert.equal(shouldAutoRetry({ ...base, summary: "(the agent exited)" }, [null]), true);
  assert.throws(() => shouldAutoRetry({ ...base, summary: "(the agent exited)" }, [null]), TypeError);
  // A failed job with NO files at all is still retried: secondTry treats an
  // empty file set as read-only and never blocks.
  const noFiles = { id: 52, agent: "devin", status: "finished", summary: "(the agent exited)", tests: false };
  assert.equal(shouldAutoRetry(noFiles, [noFiles]), true, "file-less failures are auto-retried");
  // A failed job whose files field is a non-array crashes the same way.
  // BUG: files: "a.txt" in a stored record makes shouldAutoRetry throw.
  // assert.equal(shouldAutoRetry({ ...noFiles, files: "a.txt" }, []), true);
  assert.throws(() => shouldAutoRetry({ ...noFiles, files: "a.txt" }, []), TypeError);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log("constance-retry.deep: tests passed");
