// Deeper edge-case pass on bin/dsh-usage.mjs (DeepSeek Harness token usage
// read from $DSH_HOME/sessions JSONL / .jsonl.zstd logs). Complements
// dsh-usage.test.mjs, which covers the happy path: attempt/settlement fold,
// seeded forks, model switch, retry, corrupt log skipped, DSH_HOME override.
// This file covers what it doesn't:
//
//   - dshHomeDir wrong-type env values and "~" expansion corners
//   - sessionLogFiles filesystem edge cases: missing/file roots, log-name
//     regex corners, same-version .zstd-vs-.jsonl tie-break in both orders,
//     depth cutoff, non-regular files, a directory named like a log
//   - scanZstdFrames on hand-built frame buffers: reserved bits, reserved
//     block type, window/dictionary/content-size header accounting, torn
//     checksums
//   - dshLogSamples wrong-type inputs, non-object JSON lines, seeded-fork
//     boundary corners (no end-seed, inherited:false, multiple end-seeds,
//     non-seeded header), turn/step slot-collapse quirks, model fallback
//     chain, usage coercion, non-finite ms passthrough
//   - readDshUsage integration edges: empty/header-only/garbage logs,
//     wrong-container files, 30-day and 7-day window boundaries, future
//     timestamps, no-cache re-reads, result independence
//
// Everything lives under fs.mkdtempSync dirs; HOME and the XDG vars are
// pointed there too even though every call passes its root explicitly.
// Quirks that pin down SUSPECTED BUGS assert the current behaviour and say
// so; nothing here is fixed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { dshHomeDir, dshLogSamples, readDshUsage, scanZstdFrames, sessionLogFiles } from "./dsh-usage.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-usage-deep-"));
for (const d of ["home", "state", "config", "cache"])
  fs.mkdirSync(path.join(tmp, d), { recursive: true });
process.env.HOME = path.join(tmp, "home");
process.env.XDG_STATE_HOME = path.join(tmp, "state");
process.env.XDG_CONFIG_HOME = path.join(tmp, "config");
process.env.XDG_CACHE_HOME = path.join(tmp, "cache");

const homes = [];
const mkhome = () => { const h = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-deep-home-")); homes.push(h); return h; };
const keyOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const NOW = (() => { const d = new Date(); d.setHours(12, 0, 0, 0); return d.getTime(); })();
const at = (daysAgo, hour = 10) => { const d = new Date(NOW); d.setDate(d.getDate() - daysAgo); d.setHours(hour, 0, 0, 0); return d.getTime(); };

const header = (id, extra = {}) => JSON.stringify({ type: "session", version: 4, id, createdAt: at(3), delegationDepth: 0, cwd: "/tmp/p", ...extra });
const ev = (type, time, data) => JSON.stringify({ type, seq: 1, time, data });
const msg = (time, data) => ev("assistant/message", time, { turn: 1, step: 1, stream: [], ...data });
const usageMsg = (time, usage, extra = {}) => msg(time, { usage, ...extra });
const reqHeader = (time, config) => ev("request/header", time, { header: { config }, reason: "initial" });

// ------------------------------------------------------------- dshHomeDir
assert.equal(dshHomeDir("/h", null), path.join("/h", ".dsh"), "null env falls back to ~/.dsh");
assert.equal(dshHomeDir("/h", { DSH_HOME: 42 }), path.join("/h", ".dsh"), "non-string DSH_HOME is blank");
assert.equal(dshHomeDir("/h", { DSH_HOME: "~" }), "/h", "bare ~ is the home itself");
assert.equal(dshHomeDir("/h", { DSH_HOME: "~/" }), "/h", "~/ also resolves to the home itself");
assert.equal(dshHomeDir("/h", { DSH_HOME: "~\\win\\style" }), path.join("/h", "win\\style"), "~\\ expands like ~/ even on posix (backslash stays literal)");
assert.equal(dshHomeDir("/h", { DSH_HOME: "  ~/x  " }), "/h/x", "outer whitespace is trimmed before expansion");
assert.equal(dshHomeDir("/h", { DSH_HOME: "~/.." }), "/", "~ can escape upward via ..");
assert.equal(dshHomeDir("/h", { DSH_HOME: "~other/x" }), path.resolve("~other/x"), "~user is NOT expanded, stays literal");
assert.equal(dshHomeDir("/h", { DSH_HOME: "relative/dir" }), path.resolve("relative/dir"), "relative DSH_HOME resolves against cwd");

// -------------------------------------------------------- sessionLogFiles
const sroot = path.join(tmp, "sessions-root");
// Missing root and a root that is a plain file both yield [].
assert.deepEqual(sessionLogFiles(path.join(tmp, "does-not-exist")), []);
const rootFile = path.join(tmp, "root-is-file");
fs.writeFileSync(rootFile, "x");
assert.deepEqual(sessionLogFiles(rootFile), []);

// Name-regex corners: all of these must be ignored.
const namesDir = path.join(sroot, "proj", "sess-names");
fs.mkdirSync(namesDir, { recursive: true });
for (const n of ["session.v01.jsonl", "session.v0.jsonl", "session.v-1.jsonl", "session.vx.jsonl",
                 "session.v4.jsonl.bak", "session.v4.jsonl.tmp", "session.v4.jsonl.zst",
                 "session.v4.jsonl.ZSTD", "mysession.v4.jsonl", "session.v4.jsonl "])
  fs.writeFileSync(path.join(namesDir, n), "x");
// A directory named like a log is not a file; but the walk still descends
// into it, so a real log inside counts with that directory as its "session".
const fakeDir = path.join(sroot, "proj", "sess-fake", "session.v9.jsonl");
fs.mkdirSync(fakeDir, { recursive: true });
fs.writeFileSync(path.join(fakeDir, "session.v2.jsonl"), "x");
// Depth cutoff: layout is <root>/<project>/<session>/file (depth 2 for the
// file's parent listing). A file five directories down is never reached.
const deepOk = path.join(sroot, "a", "b", "c", "d");
fs.mkdirSync(deepOk, { recursive: true });
fs.writeFileSync(path.join(deepOk, "session.jsonl"), "x"); // parent listed at depth 4: found
const deepNo = path.join(sroot, "a", "b", "c", "d", "e");
fs.mkdirSync(deepNo, { recursive: true });
fs.writeFileSync(path.join(deepNo, "session.jsonl"), "x"); // depth 5: never listed
// A symlink is neither isFile nor isDirectory for Dirent purposes: skipped.
const linkTarget = path.join(sroot, "proj", "sess-link-target", "session.jsonl");
fs.mkdirSync(path.dirname(linkTarget), { recursive: true });
fs.writeFileSync(linkTarget, "x");
fs.mkdirSync(path.join(sroot, "proj", "sess-link"), { recursive: true });
fs.symlinkSync(linkTarget, path.join(sroot, "proj", "sess-link", "session.jsonl"));
// Unreadable directory: readdirSync throws, the whole subtree is skipped.
const noRead = path.join(sroot, "proj", "sess-noperm");
fs.mkdirSync(noRead, { recursive: true });
fs.writeFileSync(path.join(noRead, "session.jsonl"), "x");
fs.chmodSync(noRead, 0o000);
const found = sessionLogFiles(sroot);
fs.chmodSync(noRead, 0o755);
assert.ok(found.includes(path.join(fakeDir, "session.v2.jsonl")), "log inside a dir named like a log still counts");
assert.ok(found.includes(path.join(deepOk, "session.jsonl")), "file at max walk depth is found");
assert.ok(!found.some((p) => p.endsWith(path.join("e", "session.jsonl"))), "file past max walk depth is missed");
assert.ok(!found.some((p) => p.includes("sess-names")), "regex-rejected names are skipped");
assert.ok(!found.some((p) => p.includes(`${path.sep}sess-link${path.sep}`)), "symlinked log is skipped");
assert.ok(!found.some((p) => p.includes("sess-noperm")), "unreadable dir is skipped");

// Same-version tie-break: .zstd beats .jsonl regardless of directory order.
for (const [tag, first] of [["zfirst", "session.v4.jsonl.zstd"], ["jfirst", "session.v4.jsonl"]]) {
  const d = path.join(sroot, "proj", `sess-tie-${tag}`);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, first), "x");
  fs.writeFileSync(path.join(d, first === "session.v4.jsonl" ? "session.v4.jsonl.zstd" : "session.v4.jsonl"), "x");
  const pick = sessionLogFiles(path.join(sroot, "proj", `sess-tie-${tag}`));
  assert.deepEqual(pick, [path.join(d, "session.v4.jsonl.zstd")], `${tag}: .zstd twin always wins the tie`);
}
// Higher version wins over lower regardless of extension.
{
  const d = path.join(sroot, "proj", "sess-ver");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "session.v9.jsonl.zstd"), "x");
  fs.writeFileSync(path.join(d, "session.v10.jsonl"), "x");
  assert.deepEqual(sessionLogFiles(path.join(sroot, "proj", "sess-ver")), [path.join(d, "session.v10.jsonl")]);
}
// Pinned tradeoff: when both twins exist only the .zstd is read, so a corrupt
// .zstd shadows a perfectly valid .jsonl of the same version. Real dsh layouts
// should never hold both; flagged in the report, not changed.
{
  const d = path.join(sroot, "proj", "sess-shadow");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "session.v4.jsonl"), [header("s"), usageMsg(at(0), { inputTokens: 5 })].join("\n") + "\n");
  fs.writeFileSync(path.join(d, "session.v4.jsonl.zstd"), Buffer.from("corrupt"));
  const home = mkhome();
  fs.mkdirSync(path.join(home, ".dsh", "sessions", "proj"), { recursive: true });
  fs.renameSync(path.join(sroot, "proj", "sess-shadow"), path.join(home, ".dsh", "sessions", "proj", "sess-shadow"));
  assert.equal(readDshUsage({ home, env: {}, now: NOW }), null, "corrupt .zstd shadows the valid .jsonl twin");
}

// --------------------------------------------------------- scanZstdFrames
const ZMAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]); // 0xfd2fb528 little-endian
const u24 = (v) => Buffer.from([v & 255, (v >> 8) & 255, (v >> 16) & 255]);
// lastBlock | (blockType << 1) | (blockSize << 3); raw block type is 0.
const blockHdr = (last, type, size) => u24((last ? 1 : 0) | (type << 1) | (size << 3));
const rawRun = (...chunks) => Buffer.concat(chunks.flatMap(([last, payload]) => [blockHdr(last, 0, payload.length), Buffer.from(payload)]));
const frameBuf = (descriptor, headerRest, blocks) =>
  Buffer.concat([ZMAGIC, Buffer.from([descriptor]), Buffer.from(headerRest), Buffer.concat(blocks)]);

assert.deepEqual(scanZstdFrames(Buffer.alloc(0)).frames, []);
assert.deepEqual(scanZstdFrames(Buffer.from([1, 2, 3])).frames, []);
assert.deepEqual(scanZstdFrames(ZMAGIC).frames, [], "magic alone is not a frame");
assert.deepEqual(scanZstdFrames(Buffer.concat([ZMAGIC, Buffer.from([0x20])])).frames, [], "descriptor without content-size byte");
// Reserved descriptor bits (0x18) reject the frame before anything else.
{
  const good = zlib.zstdCompressSync("x");
  const bad = Buffer.from(good);
  bad[4] |= 0x18;
  assert.deepEqual(scanZstdFrames(bad).frames, [], "reserved frame-header bits -> corrupt");
}
// Hand-built frames: window byte, dictionary sizes, content-size sizes.
{
  // Non-single-segment: one window-descriptor byte, no content size, raw block.
  const buf = frameBuf(0x00, [0x00], [rawRun([1, "hi"])]);
  assert.deepEqual(scanZstdFrames(buf).frames, [{ start: 0, end: buf.length }]);
  // Single-segment + 1 content-size byte + two raw blocks in one frame.
  const buf2 = frameBuf(0x20, [2], [blockHdr(0, 0, 1), Buffer.from("a"), blockHdr(1, 0, 1), Buffer.from("b")]);
  assert.deepEqual(scanZstdFrames(buf2).frames, [{ start: 0, end: buf2.length }], "multi-block frame is one range");
  // DictID flag 1 -> 1 dict byte; flag 3 -> 4 dict bytes (header accounting).
  const d1 = frameBuf(0x20 | 0x01, [0x00, 1], [rawRun([1, "x"])]);
  assert.equal(scanZstdFrames(d1).frames.length, 1, "1-byte dictionary id accounted");
  const d3 = frameBuf(0x20 | 0x03, [0, 0, 0, 0, 1], [rawRun([1, "x"])]);
  assert.equal(scanZstdFrames(d3).frames.length, 1, "4-byte dictionary id accounted");
  // Content-size flag 3 wants 8 bytes; truncated header -> no frames.
  const big = frameBuf(0xC0 | 0x20, [1, 2, 3], [rawRun([1, "x"])]);
  assert.deepEqual(scanZstdFrames(big).frames, [], "8-byte content size truncated -> corrupt");
  // Reserved block type 3 ends the scan; a valid earlier frame is kept.
  const res = frameBuf(0x20, [1], [blockHdr(1, 3, 0)]);
  assert.deepEqual(scanZstdFrames(res).frames, [], "reserved block type -> corrupt");
  const goodFrame = frameBuf(0x20, [2], [rawRun([1, "ok"])]);
  const badFrame = frameBuf(0x20, [1], [blockHdr(1, 3, 0)]);
  const both = Buffer.concat([goodFrame, badFrame]);
  assert.deepEqual(scanZstdFrames(both).frames, [{ start: 0, end: goodFrame.length }],
    "corrupt second frame keeps the first");
}
// Checksum flag: 4 trailing bytes required after the last block.
{
  const noCrc = frameBuf(0x20 | 0x04, [1], [rawRun([1, "x"])]);
  assert.deepEqual(scanZstdFrames(noCrc).frames, [], "checksum flag without checksum bytes");
  const withCrc = Buffer.concat([noCrc, Buffer.from([1, 2, 3, 4])]);
  assert.deepEqual(scanZstdFrames(withCrc).frames, [{ start: 0, end: withCrc.length }]);
  const shortCrc = Buffer.concat([noCrc, Buffer.from([1, 2])]);
  assert.deepEqual(scanZstdFrames(shortCrc).frames, [], "truncated checksum -> frame dropped");
}
// A real checksummed frame loses its last byte -> the whole (only) frame drops.
{
  const opts = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
  const cf = zlib.zstdCompressSync("payload", opts);
  assert.equal(scanZstdFrames(cf).frames.length, 1);
  assert.deepEqual(scanZstdFrames(cf.subarray(0, cf.length - 1)).frames, []);
}

// ----------------------------------------------------------- dshLogSamples
// Wrong-type inputs all return null, never throw.
for (const v of [null, undefined, 42, true, NaN, {}, []])
  assert.equal(dshLogSamples(v), null, `dshLogSamples(${String(v)})`);
assert.equal(dshLogSamples("  \n\t\n"), null, "whitespace-only text");
assert.equal(dshLogSamples("\n" + header("x")), null, "leading blank line breaks the header parse");
for (const h of ["null", "[1,2]", "42", "\"str\"", "true"])
  assert.equal(dshLogSamples(h + "\n"), null, `header ${h}`);
// Valid header + non-object / corrupt lines -> empty sample list, NOT null:
// the file parsed as a session log, it just billed nothing.
assert.deepEqual(dshLogSamples([header("x"), "null", "42", "\"s\"", "true", "{bad", ""].join("\n")), []);
assert.deepEqual(dshLogSamples(header("x") + "\n"), [], "header-only log parses to zero samples");

// Seeded-fork boundary corners.
{
  const own = usageMsg(at(0), { inputTokens: 5 }, { turn: 2 });
  const inherited = usageMsg(at(0), { inputTokens: 999 });
  const endSeed = (inh) => ev("session/end-seed", at(0), inh === undefined ? {} : { inherited: inh });
  // isSeeded but NO end-seed at all: everything counts (fallback, pinned).
  assert.equal(dshLogSamples([header("f1", { isSeeded: true }), inherited, own].join("\n")).length, 2,
    "seeded log without end-seed counts all events");
  // end-seed present but inherited !== true: not a boundary, all counts.
  assert.equal(dshLogSamples([header("f2", { isSeeded: true }), inherited, endSeed(false), own].join("\n")).length, 2,
    "inherited:false end-seed is not a boundary");
  assert.equal(dshLogSamples([header("f2b", { isSeeded: true }), inherited, endSeed(), own].join("\n")).length, 2,
    "end-seed without inherited field is not a boundary");
  // Real boundary: only events after the LAST inherited end-seed count.
  const bounded = dshLogSamples([header("f3", { isSeeded: true }), inherited, endSeed(true), own].join("\n"));
  assert.deepEqual(bounded, [{ ms: at(0), model: "unknown", tokens: [5, 0, 0, 0] }]);
  // Two boundaries: the scan takes the last one, so a sample between them drops.
  const mid = usageMsg(at(0), { inputTokens: 77 });
  const two = dshLogSamples([header("f4", { isSeeded: true }), endSeed(true), mid, endSeed(true), own].join("\n"));
  assert.deepEqual(two, [{ ms: at(0), model: "unknown", tokens: [5, 0, 0, 0] }], "last end-seed wins");
  // isSeeded absent/false: end-seed is ignored entirely, all counts.
  const unseeded = dshLogSamples([header("f5"), inherited, endSeed(true), own].join("\n"));
  assert.equal(unseeded.length, 2, "end-seed only matters when header.isSeeded === true");
}

// Turn/step slot collapse quirks.
{
  // Missing turn/step: every such event shares the {undefined,undefined}
  // slot, so consecutive usage events collapse into the last one.
  const noIds = [
    header("q1"),
    ev("assistant/message", at(0), { stream: [], usage: { inputTokens: 10 } }),
    ev("assistant/message", at(0), { stream: [], usage: { inputTokens: 20 } }),
    ev("assistant/message", at(0), { stream: [], usage: { inputTokens: 30 } }),
  ].join("\n");
  const collapsed = dshLogSamples(noIds);
  assert.equal(collapsed.length, 1, "missing turn/step collapses consecutive samples");
  assert.equal(collapsed[0].tokens[0], 30, "the LAST same-slot sample survives");
  // Replacement only touches the immediately-preceding slot: an earlier
  // turn/step recurring later is pushed as a new sample, not merged.
  const recur = [
    header("q2"), reqHeader(at(0), { provider: "p", model: "m" }),
    msg(at(0), { turn: 1, step: 1, usage: { inputTokens: 1 } }),
    msg(at(0), { turn: 2, step: 1, usage: { inputTokens: 2 } }),
    msg(at(0), { turn: 1, step: 1, usage: { inputTokens: 3 } }),
  ].join("\n");
  const rec = dshLogSamples(recur);
  assert.deepEqual(rec.map((s) => s.tokens[0]), [1, 2, 3], "non-consecutive same turn/step does not merge");
}

// Model label fallback chain.
{
  assert.equal(dshLogSamples([header("m1"), usageMsg(at(0), { inputTokens: 1 })].join("\n"))[0].model, "unknown",
    "no request/header -> 'unknown'");
  // provider with no model: the provider name becomes the model label.
  assert.equal(dshLogSamples([header("m2"), reqHeader(at(0), { provider: "prov-only" }), usageMsg(at(0), { inputTokens: 1 })].join("\n"))[0].model,
    "prov-only", "model falls back to provider when config.model is empty");
  // A request/header without a usable config leaves the previous route in place.
  const sticky = dshLogSamples([
    header("m3"), reqHeader(at(0), { provider: "p", model: "m1" }),
    ev("request/header", at(0), { reason: "retry" }),
    usageMsg(at(0), { inputTokens: 1 }),
  ].join("\n"));
  assert.equal(sticky[0].model, "m1", "config-less request/header keeps the previous model");
  // Non-string provider/model coerce to "" -> 'unknown'.
  assert.equal(dshLogSamples([header("m4"), reqHeader(at(0), { provider: 7, model: {} }), usageMsg(at(0), { inputTokens: 1 })].join("\n"))[0].model,
    "unknown");
}

// Usage coercion and shape edges.
{
  const s = dshLogSamples([
    header("u1"), reqHeader(at(0), { provider: "p", model: "m" }),
    usageMsg(at(0), { inputTokens: "50", outputTokens: -3, cacheReadTokens: 7, cacheWriteTokens: "x" }),
  ].join("\n"));
  assert.deepEqual(s[0].tokens, [50, 0, 7, 0], "strings coerce, negatives/NaN clamp to 0");
  // usage present but a non-object -> falls through to the stream, finds none.
  assert.deepEqual(dshLogSamples([header("u2"), msg(at(0), { usage: "lots" })].join("\n")), []);
  assert.deepEqual(dshLogSamples([header("u3"), msg(at(0), { usage: [1, 2] })].join("\n")), []);
  // assistant/attempt only reads stream chunks; a top-level data.usage is ignored.
  const attemptOnly = ev("assistant/attempt", at(0), { turn: 1, step: 1, usage: { inputTokens: 9 }, stream: [] });
  assert.deepEqual(dshLogSamples([header("u4"), attemptOnly].join("\n")), [], "attempt ignores top-level usage");
  // assistant/message prefers data.usage over a stream usage chunk.
  const both = ev("assistant/message", at(0), {
    turn: 1, step: 1, usage: { inputTokens: 1 },
    stream: [{ type: "chunk", chunk: { type: "usage", usage: { inputTokens: 999 } } }],
  });
  assert.equal(dshLogSamples([header("u5"), both].join("\n"))[0].tokens[0], 1, "message usage wins over stream");
  // Non-finite / missing timestamps pass through the parser untouched;
  // readDshUsage filters them later.
  const weird = dshLogSamples([header("u6"),
    ev("assistant/message", "not-a-number", { turn: 1, step: 1, stream: [], usage: { inputTokens: 1 } }),
    ev("assistant/message", undefined, { turn: 2, step: 1, stream: [], usage: { inputTokens: 2 } }),
  ].join("\n"));
  assert.equal(weird[0].ms, "not-a-number");
  assert.equal(weird[1].ms, undefined);
}

// ------------------------------------------------------------ readDshUsage
const sessDir = (home, proj, sess) => {
  const d = path.join(home, ".dsh", "sessions", proj, sess);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const writeLines = (dir, name, lines) => fs.writeFileSync(path.join(dir, name), lines.join("\n") + "\n");
const dayTotals = (r) => Object.fromEntries(r.days.map((d) => [d.date, d.tokens]));

// sessions root that is a plain file -> no logs -> null.
{
  const home = mkhome();
  fs.mkdirSync(path.join(home, ".dsh"), { recursive: true });
  fs.writeFileSync(path.join(home, ".dsh", "sessions"), "not a dir");
  assert.equal(readDshUsage({ home, env: {}, now: NOW }), null);
}
// A directory named like a log file is not read as one.
{
  const home = mkhome();
  fs.mkdirSync(path.join(home, ".dsh", "sessions", "p", "s", "session.v4.jsonl"), { recursive: true });
  assert.equal(readDshUsage({ home, env: {}, now: NOW }), null);
}
// Empty file, garbage-only file -> null. Header + garbage lines -> parses,
// returns an all-zero result (NOT null) because the log itself was readable.
{
  for (const [tag, lines] of [
    ["empty", []],
    ["garbage", ["\u0000\u0001 binary-ish", "{not json"]],
  ]) {
    const h = mkhome();
    writeLines(sessDir(h, "p", "s"), "session.jsonl", lines);
    assert.equal(readDshUsage({ home: h, env: {}, now: NOW }), null, `${tag} log -> null`);
  }
  const hg = mkhome();
  writeLines(sessDir(hg, "p", "s"), "session.jsonl", [header("hg"), "garbage", "{bad"]);
  const r = readDshUsage({ home: hg, env: {}, now: NOW });
  assert.ok(r, "header + garbage still counts as a parsed log");
  assert.ok(r.days.every((d) => d.tokens === 0), "all days honest zero");
  assert.deepEqual(r.models, {});
  assert.deepEqual(r.limits, []);
}
// Wrong-container files: .jsonl holding zstd bytes, .zstd holding plain text,
// .zstd holding valid zstd of non-log text — all unreadable as session logs.
{
  const zbytes = zlib.zstdCompressSync("whatever\n");
  for (const [tag, name, content] of [
    ["zstd-in-jsonl", "session.jsonl", zbytes],
    ["plain-in-zstd", "session.jsonl.zstd", Buffer.from([header("x"), usageMsg(at(0), { inputTokens: 5 })].join("\n") + "\n")],
    ["garbage-in-zstd", "session.jsonl.zstd", zbytes],
  ]) {
    const h = mkhome();
    const d = sessDir(h, "p", "s");
    fs.writeFileSync(path.join(d, name), content);
    assert.equal(readDshUsage({ home: h, env: {}, now: NOW }), null, `${tag} -> null`);
  }
}
// Window boundaries with a fixed clock: 30-day days window vs 7-day models
// window vs future timestamps (which land in models but no day — pinned quirk).
{
  const h = mkhome();
  const d = sessDir(h, "p", "s");
  const m = (daysAgo, tokens, turn, hour = 10) => usageMsg(at(daysAgo, hour), { inputTokens: tokens }, { turn, step: 1 });
  writeLines(d, "session.jsonl", [
    header("win"), reqHeader(at(0), { provider: "p", model: "m" }),
    m(29, 10, 1),   // oldest day still inside the 30-day window
    m(30, 20, 2),   // one day too old for days
    m(31, 40, 3),   // also too old
    m(6, 60, 4),    // oldest day inside the 7-day models window
    m(7, 70, 5),    // outside models but inside days
    usageMsg(NOW + 2 * 86400000, { inputTokens: 80 }, { turn: 6 }), // future: models only
  ]);
  const r = readDshUsage({ home: h, env: {}, now: NOW });
  const days = dayTotals(r);
  assert.equal(days[keyOf(at(29))], 10, "day -29 included");
  assert.equal(days[keyOf(at(30))], undefined, "day -30 excluded from days");
  assert.equal(days[keyOf(at(31))], undefined, "day -31 excluded from days");
  assert.equal(days[keyOf(at(6))], 60);
  assert.equal(days[keyOf(at(7))], 70, "day -7 still inside the 30-day days window");
  assert.equal(days[keyOf(NOW + 2 * 86400000)], undefined, "future timestamp lands on no day");
  assert.equal(days[keyOf(NOW)], 0, "today itself stays an honest zero");
  assert.equal(r.days[0].date, keyOf(at(29)), "days[0] is 29 days ago");
  assert.equal(r.days[29].date, keyOf(NOW), "days[29] is today");
  // Pinned quirk: a future-dated sample counts toward the 7-day models total
  // (key >= weekStart string compare) even though it belongs to no day.
  assert.deepEqual(r.models, { m: 60 + 80 }, "models = last 7 days + future sample");
}
// No caching / stale state: rewriting the same log path changes the answer;
// deleting the only log flips the result back to null.
{
  const h = mkhome();
  const d = sessDir(h, "p", "s");
  const file = path.join(d, "session.jsonl");
  writeLines(d, "session.jsonl", [header("nc"), usageMsg(at(0), { inputTokens: 10 })]);
  assert.equal(dayTotals(readDshUsage({ home: h, env: {}, now: NOW }))[keyOf(NOW)], 10);
  writeLines(d, "session.jsonl", [header("nc"), usageMsg(at(0), { inputTokens: 33 })]);
  assert.equal(dayTotals(readDshUsage({ home: h, env: {}, now: NOW }))[keyOf(NOW)], 33, "second read sees the rewrite");
  fs.rmSync(file);
  assert.equal(readDshUsage({ home: h, env: {}, now: NOW }), null, "no logs left -> null");
}
// Every call returns fresh objects; mutating one result cannot leak.
{
  const h = mkhome();
  writeLines(sessDir(h, "p", "s"), "session.jsonl", [header("fresh"), usageMsg(at(0), { inputTokens: 4 })]);
  const r1 = readDshUsage({ home: h, env: {}, now: NOW });
  r1.days[29].tokens = 99999;
  r1.models.unknown = -1;
  const r2 = readDshUsage({ home: h, env: {}, now: NOW });
  assert.equal(dayTotals(r2)[keyOf(NOW)], 4);
  assert.deepEqual(r2.models, { unknown: 4 });
}
// Events whose timestamps are unusable are dropped per-sample, not per-file:
// the log still parses, so the result is an all-zero object rather than null.
{
  const h = mkhome();
  writeLines(sessDir(h, "p", "s"), "session.jsonl", [
    header("badtime"), reqHeader(at(0), { provider: "p", model: "m" }),
    ev("assistant/message", "garbage", { turn: 1, step: 1, stream: [], usage: { inputTokens: 9 } }),
  ]);
  const r = readDshUsage({ home: h, env: {}, now: NOW });
  assert.ok(r, "log with only bad timestamps still parses");
  assert.ok(r.days.every((d) => d.tokens === 0));
  assert.deepEqual(r.models, {});
}
// Repeated/concurrent calls agree (the module is synchronous, no shared state).
{
  const h = mkhome();
  writeLines(sessDir(h, "p", "s"), "session.jsonl", [header("cc"), usageMsg(at(0), { inputTokens: 6 })]);
  const [a, b] = [readDshUsage({ home: h, env: {}, now: NOW }), readDshUsage({ home: h, env: {}, now: NOW })];
  assert.deepEqual(a, b);
}

// ------------------------------------------------------------- cleanup
for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
fs.rmSync(tmp, { recursive: true, force: true });
console.log("dsh-usage.deep: all tests passed");
