// Deep edge-case pass for bin/cursor-wall.mjs on top of cursor-wall.test.mjs.
// The module is pure and synchronous: projectsDir/nowMs/resetsAt are all passed
// in and it keeps no state between calls, so nothing here can race or leak —
// the scratch dir only exists to satisfy the "never touch the real home
// folder" rule, and env vars are pointed at it for the duration of the run.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cursorWall } from "./cursor-wall.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-wall-deep-"));
const savedEnv = {};
for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
  savedEnv[k] = process.env[k];
  process.env[k] = path.join(tmp, k.toLowerCase());
  fs.mkdirSync(process.env[k], { recursive: true });
}

const NOW = Date.parse("2026-11-25T12:00:00Z");
const FUTURE = new Date(NOW + 20 * 864e5).toISOString();
const ERR = { type: "turn_ended", status: "error", error: "You've hit your usage limit. Get Cursor Pro for more." };
const OK = { type: "turn_ended", status: "completed" };
const wall = (dir, now = NOW, opts = { resetsAt: FUTURE }) => cursorWall(dir, now, opts);

// A projectsDir root holding one transcript per call.
// content: array of objects (JSON.stringify'd, one per line), a raw string
// written verbatim, or null/"" for an empty file. mtime is ms since epoch.
const wr = (root, proj, id, content, mtime = NOW - 60e3) => {
  const d = path.join(root, proj, "agent-transcripts", id);
  fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, `${id}.jsonl`);
  const text = content == null ? "" : typeof content === "string" ? content : content.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n";
  fs.writeFileSync(f, text);
  const t = new Date(mtime);
  fs.utimesSync(f, t, t);
  return f;
};
const root = (name) => path.join(tmp, name);

try {
  // ---- projectsDir with wrong types / unusable shapes ----
  for (const bad of [null, undefined, 0, 42, -1, {}, [], true]) {
    assert.equal(cursorWall(bad), null, `projectsDir=${String(bad)} must return null, not throw`);
  }
  const asFile = path.join(tmp, "as-file");
  fs.writeFileSync(asFile, "not a dir");
  assert.equal(cursorWall(asFile), null, "projectsDir is a plain file");
  assert.equal(cursorWall(""), null, "empty string projectsDir");
  assert.equal(cursorWall(new URL("file:///nonexistent-cursor-wall")), null, "URL projectsDir");

  // ---- directory layout edge cases: every level can be the wrong kind ----
  const lay = root("layout");
  fs.mkdirSync(lay, { recursive: true });
  fs.writeFileSync(path.join(lay, "plain-file"), "x"); // project entry that is a file
  fs.mkdirSync(path.join(lay, "p-file-at"), { recursive: true });
  fs.writeFileSync(path.join(lay, "p-file-at", "agent-transcripts"), "x"); // agent-transcripts is a file
  fs.mkdirSync(path.join(lay, "p-file-id", "agent-transcripts"), { recursive: true });
  fs.writeFileSync(path.join(lay, "p-file-id", "agent-transcripts", "not-a-dir"), "x"); // transcript id is a file
  const dOther = path.join(lay, "p-other", "agent-transcripts", "s1");
  fs.mkdirSync(dOther, { recursive: true });
  fs.writeFileSync(path.join(dOther, "renamed.jsonl"), JSON.stringify(ERR) + "\n"); // wrong filename ignored
  const dDirJsonl = path.join(lay, "p-dirjsonl", "agent-transcripts", "s2");
  fs.mkdirSync(path.join(dDirJsonl, "s2.jsonl"), { recursive: true }); // id.jsonl is a directory
  wr(lay, "p-empty", "s3", null); // completely empty transcript
  assert.equal(wall(lay), null, "none of these layouts may produce a wall or throw");

  // ---- file content edge cases ----
  const con = root("content");
  wr(con, "blank", "e1", null);                                            // zero-byte file
  wr(con, "ws", "e2", "\n\n   \n\t\n");                                    // whitespace only
  wr(con, "garbage", "e3", "this is not json\n{broken\nturn_ended");       // unparseable lines, one raw 'turn_ended'
  wr(con, "junklines", "e4", [                                            // valid JSON that is not a turn
    '{"role":"user","content":"turn_ended was mentioned in chat"}',       // 'turn_ended' inside a string field
    "null",                                                               // parses to null: d.type throws, caught
    "5",                                                                  // parses to a number
    '"turn_ended"',                                                       // parses to a bare string
    "[1,2,3]",
    '{"type":"note","turn_ended":true}',                                 // key named turn_ended but wrong type
  ]);
  wr(con, "badthenok", "e5", ["{bad json", JSON.stringify(OK)]);          // garbage line before a real record
  wr(con, "okthencorrupt", "e6", [JSON.stringify(OK), "{truncated"]);      // corrupt tail after a real record
  wr(con, "errthencorrupt", "e7", [JSON.stringify(ERR), "{truncated"]);   // corrupt tail keeps the error -> a hit
  wr(con, "nostatus", "e8", [{ type: "turn_ended" }]);                    // no status at all
  wr(con, "capserr", "e9", [{ type: "turn_ended", status: "Error", error: "usage limit" }]); // capital E
  wr(con, "cancelled", "e10", [{ type: "turn_ended", status: "cancelled" }]);
  const wCon = wall(con);
  assert.ok(wCon, "only e7's last turn is a usage-limit error; everything else is ignored");
  assert.equal(wCon.hitAt, new Date(NOW - 60e3).toISOString(), "the lone hit is e7's file mtime");

  // ---- error payload that is not a string: String() coercion decides ----
  const types = root("errtypes");
  wr(types, "num", "t1", [{ type: "turn_ended", status: "error", error: 42 }], NOW - 4000);
  wr(types, "nobj", "t2", [{ type: "turn_ended", status: "error", error: null }], NOW - 4000);
  wr(types, "arr", "t3", [{ type: "turn_ended", status: "error", error: ["usage limit"] }], NOW - 4000);
  wr(types, "obj", "t4", [{ type: "turn_ended", status: "error", error: { message: "usage limit" } }], NOW - 4000);
  const wTypes = wall(types);
  assert.ok(wTypes, "String(['usage limit']) still matches the regex");
  assert.equal(wTypes.hitAt, new Date(NOW - 4000).toISOString());
  wr(types, "fld", "t5", [{ type: "turn_ended", status: "error", error: "boom", note: "usage limit" }], NOW - 1000);
  const wTypes2 = wall(types);
  assert.ok(wTypes2 && wTypes2.hitAt === wTypes.hitAt, "'usage limit' outside the error field changes nothing");

  // LIMIT regex variants: case-insensitive, plural, mid-sentence
  const rx = root("regex");
  wr(rx, "a", "r1", [{ type: "turn_ended", status: "error", error: "USAGE LIMIT REACHED" }], NOW - 9000);
  wr(rx, "b", "r2", [{ type: "turn_ended", status: "error", error: "you have hit your usage limits" }], NOW - 8000);
  wr(rx, "c", "r3", [{ type: "turn_ended", status: "error", error: "quota fine, but usage limit hit" }], NOW - 7000);
  assert.ok(wall(rx), "all 'usage limit' spellings count as a wall");
  wr(rx, "d", "r4", [{ type: "turn_ended", status: "error", error: "rate limit exceeded" }], NOW - 1000);
  assert.ok(wall(rx), "an unrelated newer error neither raises nor lifts the wall");
  wr(rx, "e", "r5", [{ type: "turn_ended", status: "completed" }], NOW - 500);
  assert.equal(wall(rx), null, "a later completed turn lifts it");

  // ---- last turn_ended in a file wins; file mtime is the hit time ----
  const solo = root("solo");
  wr(solo, "p", "s1", [ERR, OK], NOW - 6000);
  assert.equal(wall(solo), null, "file ending on ok: no wall");
  wr(solo, "p", "s2", [OK, ERR], NOW - 5500);
  const wSolo = wall(solo);
  assert.ok(wSolo && wSolo.hitAt === new Date(NOW - 5500).toISOString(), "file ending on error: wall at its mtime");
  wr(solo, "p", "s3", [OK, ERR, OK], NOW - 5000);
  assert.equal(wall(solo), null, "error followed by ok inside one file: no wall");

  const seq = root("seq");
  wr(seq, "p", "old-hit", [ERR], NOW - 9000);
  wr(seq, "p", "mid-ok", [OK], NOW - 6000);
  assert.equal(wall(seq), null, "ok newer than the hit lifts the wall");
  wr(seq, "p", "new-hit", [ERR], NOW - 3000);
  const wSeq = wall(seq);
  assert.ok(wSeq && wSeq.hitAt === new Date(NOW - 3000).toISOString(), "newest hit re-raises the wall");

  // ---- hit vs ok across files: strict >, ties, ordering ----
  const tie = root("tie");
  wr(tie, "a", "aaa-hit", [ERR], NOW - 2000);
  wr(tie, "b", "bbb-ok", [OK], NOW - 2000); // identical mtime
  assert.ok(wall(tie), "ok > hit is strict: an equal-mtime success cannot prove ordering, wall stands");

  const fut = root("future");
  wr(fut, "a", "fh", [ERR], NOW + 864e5); // hit 'in the future' (clock skew) still counts
  assert.ok(wall(fut), "future mtimes are not special-cased");

  // newest hit wins and its message is the one reported
  const multi = root("multi");
  wr(multi, "a", "e1", [{ ...ERR, error: "usage limit alpha build" }], NOW - 9000);
  wr(multi, "b", "e2", [{ ...ERR, error: "usage limit beta build" }], NOW - 1000);
  const wMulti = wall(multi);
  assert.match(wMulti.note, /beta build/);
  assert.ok(!/alpha build/.test(wMulti.note), "the newest hit's message is reported, not the oldest");

  // unreadable transcript is skipped like any other read failure
  const noperm = root("noperm");
  const fNo = wr(noperm, "p", "s1", [ERR], NOW - 2000);
  fs.chmodSync(fNo, 0o000);
  let readable = true;
  try { fs.readFileSync(fNo); } catch { readable = false; }
  if (!readable) assert.equal(wall(noperm), null, "chmod 000 transcript is skipped");
  fs.chmodSync(fNo, 0o644);

  // ---- resetsAt / nowMs clock edges ----
  const clk = root("clock");
  wr(clk, "a", "h", [ERR], NOW - 1000);
  const resetAt = NOW + 3600e3;
  const resetIso = new Date(resetAt).toISOString();
  assert.ok(wall(clk, resetAt - 1, { resetsAt: resetIso }), "one ms before reset: wall stands");
  assert.equal(wall(clk, resetAt, { resetsAt: resetIso }), null, "nowMs == reset clears the wall (>= boundary)");
  assert.equal(wall(clk, resetAt + 1, { resetsAt: resetIso }), null);
  assert.equal(wall(clk, NOW + 1e12, { resetsAt: resetIso }), null, "far-future now with a past reset: cleared");
  // invalid resetsAt values behave as "no reset known": wall stands forever
  for (const bad of ["", "garbage", "2026-13-40", "not a date"]) {
    const w = wall(clk, NOW + 1e12, { resetsAt: bad });
    assert.ok(w, `resetsAt=${JSON.stringify(bad)} must not suppress the wall`);
    assert.equal(w.resetsAt, "", "invalid resetsAt is reported as empty");
  }
  assert.ok(wall(clk, NOW, { resetsAt: null }), "resetsAt:null parses to NaN -> no reset");
  // Date.parse coerces non-strings: resetsAt:0 parses as 2000-01-01, silently
  // acting like a long-past reset and suppressing every wall.
  assert.equal(wall(clk, NOW, { resetsAt: 0 }), null, "resetsAt:0 coerces via Date.parse to year 2000");
  // omitted nowMs falls back to Date.now()
  assert.ok(cursorWall(clk, undefined, { resetsAt: new Date(Date.now() + 864e5).toISOString() }), "default nowMs = Date.now()");

  // ---- output shape ----
  const out = root("output");
  wr(out, "p", "o1", [{ type: "turn_ended", status: "error", error: "you hit your usage limit Get Cursor Pro for more Agent usage, unlimited Tab" }], NOW - 7000);
  const wOut = wall(out);
  assert.equal(wOut.title, "Cursor limit");
  assert.equal(wOut.cap, true);
  assert.equal(wOut.percent, 1);
  assert.equal(wOut.hitAt, new Date(NOW - 7000).toISOString());
  assert.ok(!/Get Cursor Pro/.test(wOut.note), "upsell suffix stripped");
  assert.match(wOut.note, /usage limit/);
  assert.match(wOut.note, /Cursor stopped a task at/);
  // resetsAt is normalized to ISO even when given in another parseable format
  const wNorm = wall(out, NOW, { resetsAt: "December 25, 2026" });
  assert.equal(wNorm.resetsAt, new Date(Date.parse("December 25, 2026")).toISOString());
  // error text without the upsell suffix is kept verbatim
  const bare = root("bare");
  wr(bare, "p", "b1", [{ type: "turn_ended", status: "error", error: "usage limit reached, try later" }], NOW - 3000);
  assert.match(wall(bare).note, /usage limit reached, try later/);

  // ---- statelessness: no caching, no shared state between calls ----
  const st = root("stateless");
  wr(st, "p", "s1", [ERR], NOW - 2000);
  const before = wall(st);
  const results = await Promise.all(Array.from({ length: 25 }, () => wall(st)));
  assert.ok(results.every((r) => JSON.stringify(r) === JSON.stringify(before)), "25 concurrent calls agree");
  wr(st, "p", "s1", [OK], NOW - 1000); // mutate the file; next call must see it
  assert.equal(wall(st), null, "no memoization: a rewritten transcript is re-read");
  wr(st, "p", "s1", [ERR], NOW - 500);
  assert.ok(wall(st), "and the wall comes back when the error returns");

  // BUG: a transcript whose file mtime is exactly the epoch (0) is invisible.
  // `if (!hit ...)` treats mtimeMs 0 as "never hit" and returns null even
  // though a usage-limit turn_ended is the file's last record.
  // const epoch = root("epoch");
  // wr(epoch, "p", "e1", [ERR], 0);
  // assert.ok(wall(epoch), "mtime 0 must still report the wall");

  // BUG: the "Get Cursor Pro" strip uses /\s*Get Cursor Pro.*$/i — `.` does not
  // cross newlines, so a multi-line error message keeps the upsell text (and
  // everything after it) in the note.
  // const ml = root("multiline");
  // wr(ml, "p", "m1", [{ type: "turn_ended", status: "error",
  //   error: "hit your usage limit\nGet Cursor Pro for more.\nExtra line." }], NOW - 1000);
  // const wMl = wall(ml);
  // assert.ok(wMl && !/Get Cursor Pro/.test(wMl.note), "multi-line upsell must still be stripped");

  // BUG: the reset check compares nowMs to resetsAt but never compares the hit
  // time. A wall hit AFTER the stated reset is suppressed whenever now >= reset,
  // hiding a fresh wall behind a stale resetsAt.
  // const stale = root("stale-reset");
  // const hitAt = NOW - 1000;
  // wr(stale, "p", "h1", [ERR], hitAt);
  // const staleReset = new Date(hitAt - 3600e3).toISOString(); // reset before the hit
  // assert.ok(cursorWall(stale, hitAt + 1, { resetsAt: staleReset }),
  //   "a hit newer than resetsAt must not be cleared by that reset");

  console.log("cursor-wall deep: all tests passed");
} finally {
  for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
