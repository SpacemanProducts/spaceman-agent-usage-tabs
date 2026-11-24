import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { dshHomeDir, dshLogSamples, readDshUsage, scanZstdFrames, sessionLogFiles } from "./dsh-usage.mjs";

// Local-day helpers matching the collector's own formatting.
const keyOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const now = (() => { const d = new Date(); d.setHours(12, 0, 0, 0); return d.getTime(); })();
const at = (daysAgo, hour = 10) => { const d = new Date(now); d.setDate(d.getDate() - daysAgo); d.setHours(hour, 0, 0, 0); return d.getTime(); };

const header = (id, seeded = false) => JSON.stringify({ type: "session", version: 4, id, createdAt: at(3), isSeeded: seeded, delegationDepth: 0, cwd: "/tmp/project" });
const ev = (seq, type, time, data) => JSON.stringify({ type, seq, time, data });
const reqHeader = (seq, time, provider, model) => ev(seq, "request/header", time, { header: { config: { provider, model } }, reason: "initial" });
const attempt = (seq, time, turn, step, usage, viaStream = false) => ev(seq, "assistant/attempt", time, {
  turn, step,
  stream: viaStream ? [{ type: "chunk", chunk: { type: "usage", usage } }] : [],
});
const message = (seq, time, turn, step, usage) => ev(seq, "assistant/message", time, { turn, step, message: { role: "assistant" }, stream: [], ...(usage ? { usage } : {}) });

// ---- fixture store -------------------------------------------------------
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-usage-home-"));
const sessions = path.join(home, ".dsh", "sessions");
const project = path.join(sessions, "--tmp-dsh-usage-project--");

// Session A: plain session.v4.jsonl exercising the attempt/settlement fold,
// a model switch, a retry, and out-of-window events.
const dirA = path.join(project, "sess-a");
fs.mkdirSync(dirA, { recursive: true });
const logA = [
  header("sess-a"),
  reqHeader(0, at(0), "deepseek-official", "deepseek-chat"),
  ev(1, "user/message", at(0), { source: { kind: "user" } }),
  attempt(2, at(0), 1, 1, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0 }, true), // streaming sample
  message(3, at(0), 1, 1, { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 100 }), // settlement replaces it -> 1600
  reqHeader(4, at(0), "deepseek-official", "deepseek-reasoner"),
  attempt(5, at(0), 2, 1, { inputTokens: 50, outputTokens: 5 }, true),
  ev(6, "llm/retry-started", at(0), { turn: 2, step: 1 }),
  message(7, at(0), 2, 1, { inputTokens: 500, outputTokens: 50 }), // retried attempt adds -> +550
  message(8, at(0), 3, 1),                                       // no usage anywhere: ignored
  message(9, at(0), 4, 1, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), // all zero: ignored
  "this line is not json",
  message(10, at(40), 5, 1, { inputTokens: 7, outputTokens: 3 }),  // outside the 30-day window
  message(11, at(1), 6, 1, { inputTokens: 10, outputTokens: 5 }),  // yesterday -> reasoner
].join("\n") + "\n{\"type\":\"assistant/message\",\"seq\":12,\"time\":" + at(0) + ",\"data\":{\"turn\":"; // torn tail: never parses
fs.writeFileSync(path.join(dirA, "session.v4.jsonl"), logA);

// Session B: Zstandard log (two checksummed frames like dsh writes), a seeded
// fork whose inherited history must not count.
const dirB = path.join(project, "sess-b");
fs.mkdirSync(dirB, { recursive: true });
const opts = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
const frame1 = zlib.zstdCompressSync(header("sess-b", true) + "\n" + ev(0, "assistant/message", at(0), { turn: 1, step: 1, stream: [], usage: { inputTokens: 9999, outputTokens: 1 } }) + "\n", opts);
const frame2 = zlib.zstdCompressSync([
  ev(1, "session/end-seed", at(0), { inherited: true }),
  reqHeader(2, at(0), "deepseek-account", "deepseek-chat"),
  message(3, at(0), 9, 1, { inputTokens: 100, outputTokens: 50 }),
].join("\n") + "\n", opts);
fs.writeFileSync(path.join(dirB, "session.v4.jsonl.zstd"), Buffer.concat([frame1, frame2]));

// Session C: older generation kept as migration history — must be ignored.
const dirC = path.join(project, "sess-c");
fs.mkdirSync(dirC, { recursive: true });
fs.writeFileSync(path.join(dirC, "session.v3.jsonl"), [header("sess-c"), message(0, at(0), 1, 1, { inputTokens: 7777, outputTokens: 1 })].join("\n") + "\n");
fs.writeFileSync(path.join(dirC, "session.v4.jsonl"), [header("sess-c"), reqHeader(0, at(0), "deepseek-official", "deepseek-chat"), message(1, at(0), 1, 1, { inputTokens: 42, outputTokens: 8 })].join("\n") + "\n");

// Session D: corrupt compressed log — skipped without throwing.
const dirD = path.join(project, "sess-d");
fs.mkdirSync(dirD, { recursive: true });
fs.writeFileSync(path.join(dirD, "session.v4.jsonl.zstd"), Buffer.from("not a zstandard frame at all"));

// Session E: unversioned plaintext name (v0 layout).
const dirE = path.join(project, "sess-e");
fs.mkdirSync(dirE, { recursive: true });
fs.writeFileSync(path.join(dirE, "session.jsonl"), [header("sess-e"), reqHeader(0, at(0), "deepseek", "deepseek-chat"), message(1, at(0), 1, 1, { inputTokens: 20, outputTokens: 4 })].join("\n") + "\n");

// ---- pure parser checks ---------------------------------------------------
assert.equal(dshLogSamples('{"type":"not-a-session"}\n'), null);
assert.equal(dshLogSamples(""), null);
assert.deepEqual(dshLogSamples([
  header("x"),
  reqHeader(0, at(0), "p", "m1"),
  attempt(1, at(0), 1, 1, { inputTokens: 3, outputTokens: 2 }, true),
  message(2, at(0), 1, 1, { inputTokens: 30, outputTokens: 20 }),
].join("\n")), [{ ms: at(0), model: "m1", tokens: [30, 20, 0, 0] }]);

// scanZstdFrames: concatenated frames, torn tail dropped.
const two = Buffer.concat([zlib.zstdCompressSync("aa"), zlib.zstdCompressSync("bb")]);
assert.deepEqual(scanZstdFrames(two).frames.length, 2);
assert.equal(scanZstdFrames(Buffer.concat([two, zlib.zstdCompressSync("cc").subarray(0, 6)])).frames.length, 2);
assert.equal(scanZstdFrames(Buffer.from("garbage")).frames.length, 0);

// ---- home resolution ------------------------------------------------------
assert.equal(dshHomeDir("/h", {}), path.join("/h", ".dsh"));
assert.equal(dshHomeDir("/h", { DSH_HOME: "  " }), path.join("/h", ".dsh"));
assert.equal(dshHomeDir("/h", { DSH_HOME: "~/xdsh" }), path.join("/h", "xdsh"));
assert.equal(dshHomeDir("/h", { DSH_HOME: "/abs/xdsh" }), "/abs/xdsh");

// ---- collector ------------------------------------------------------------
assert.deepEqual(sessionLogFiles(sessions).length, 5);
const result = readDshUsage({ home, env: {}, now });
assert.ok(result, "expected usage from the fixture store");
assert.equal(result.days.length, 30);
assert.equal(result.limits.length, 0);

const todayKey = keyOf(now);
const byDate = Object.fromEntries(result.days.map((d) => [d.date, d.tokens]));
// today: A settlement 1600 + retry pair 55+550 + B own 150 + C v4 50 + E 24 = 2429
assert.equal(byDate[todayKey], 2429);
// yesterday: A's reasoner message 15
assert.equal(byDate[keyOf(at(1))], 15);
// a quiet day inside the window reports an honest 0
assert.equal(byDate[keyOf(at(10))], 0);
// the 40-day-old event is outside the window entirely
assert.equal(result.days.some((d) => d.date === keyOf(at(40))), false);

// models over the last 7 days: chat = 1600 + 150 + 50 + 24 = 1824, reasoner = 55 + 550 + 15 = 620
assert.deepEqual(result.models, { "deepseek-chat": 1824, "deepseek-reasoner": 620 });

// missing store -> null; store with only a corrupt log -> null
const empty = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-usage-empty-"));
assert.equal(readDshUsage({ home: empty, env: {}, now }), null);
const corruptHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-usage-corrupt-"));
const corruptDir = path.join(corruptHome, ".dsh", "sessions", "--p--", "s1");
fs.mkdirSync(corruptDir, { recursive: true });
fs.writeFileSync(path.join(corruptDir, "session.v4.jsonl.zstd"), Buffer.from("junk"));
assert.equal(readDshUsage({ home: corruptHome, env: {}, now }), null);

// DSH_HOME override is honored
const alt = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-usage-alt-"));
const altDir = path.join(alt, "logs", "sessions", "--p--", "s9");
fs.mkdirSync(altDir, { recursive: true });
fs.writeFileSync(path.join(altDir, "session.jsonl"), [header("s9"), reqHeader(0, at(0), "deepseek", "m"), message(1, at(0), 1, 1, { inputTokens: 5, outputTokens: 5 })].join("\n") + "\n");
const altResult = readDshUsage({ home: empty, env: { DSH_HOME: path.join(alt, "logs") }, now });
assert.equal(altResult.days[29].tokens, 10);
assert.deepEqual(altResult.models, { m: 10 });

fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(empty, { recursive: true, force: true });
fs.rmSync(corruptHome, { recursive: true, force: true });
fs.rmSync(alt, { recursive: true, force: true });
console.log("dsh-usage ok");
