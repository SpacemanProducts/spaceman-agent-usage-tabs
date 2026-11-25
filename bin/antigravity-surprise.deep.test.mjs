// Deep edge-case pass for bin/antigravity-surprise.mjs on top of
// antigravity-surprise.test.mjs (which covers the happy paths: state
// transitions, the notify arg flags, the CLI notify click and two racing
// acknowledgements). This file exercises everything around them: argument
// coercion and malformed state shapes, corrupt/mistyped state files, the
// lock-file timeout and wait paths, multi-process races, and the CLI error
// paths (bad args, missing notify-send, HOME fallback).
//
// Everything runs against fs.mkdtempSync dirs; HOME and the XDG_* variables
// point there for spawned children. No real notification is sent: notify-send
// is a stub on PATH that records its argv.
//
// Quirks are pinned with comments. The three bugs this pass originally
// found under "// BUG:" lines (corrupt state file, unreclaimed stale lock,
// notify without title/body) are now fixed and pinned here as regression
// tests.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { immediateResetKind, surpriseNotifyArgs, surpriseStateFile, updateSurpriseState, writeSurpriseState } from "./antigravity-surprise.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "antigravity-surprise.mjs");
const scriptUrl = pathToFileURL(script).href;
const ts = 1_800_000_000_000;
const work = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-surprise-deep-"));

try {
  // ------------------------------------------------------- notify args shape
  {
    const img = "/plugins/x/notify/surprise-burst.svg";
    const a = surpriseNotifyArgs({ title: "T", body: "B" }, img);
    assert.equal(a.length, 18);
    assert.deepEqual(a.slice(0, 16), [
      "-a", "Cook Meter", "-t", "-1", "-u", "critical", "-i", "emblem-ok-symbolic",
      "-h", "boolean:suppress-sound:true", "-h", "string:category:presence",
      "-h", `string:image-path:${img}`, "--wait", "--action=default=Celebrate",
    ]);
    assert.deepEqual(a.slice(-2), ["T", "B"], "title and body are always the last two args");

    const empty = surpriseNotifyArgs({ title: "", body: "" }, img);
    assert.equal(empty.length, 18);
    assert.deepEqual(empty.slice(-2), ["", ""], "empty title/body are still passed as args");

    const weird = 'say "hi"\nsecond line ✓';
    const w = surpriseNotifyArgs({ title: weird, body: "b" }, "/img with spaces/x.svg");
    assert.equal(w[16], weird, "title is passed verbatim, never shell-split");
    assert.equal(w[13], "string:image-path:/img with spaces/x.svg", "an image path with spaces stays one arg");

    const first = surpriseNotifyArgs({ title: "a", body: "b" }, img);
    first.push("mutated");
    assert.equal(surpriseNotifyArgs({ title: "a", body: "b" }, img).length, 18, "each call returns a fresh array");
  }

  // ------------------------------------------------------- immediateResetKind
  {
    const R = (id, kind) => ({ a: id === undefined ? undefined : { id }, info: kind === undefined ? undefined : { kind } });
    assert.equal(immediateResetKind(null), null);
    assert.equal(immediateResetKind(undefined), null);
    assert.equal(immediateResetKind([]), null);
    assert.equal(immediateResetKind([R("antigravity", "scheduled")]), "scheduled");
    assert.equal(immediateResetKind([R("antigravity", "surprise"), R("antigravity", "scheduled")]), "scheduled",
      "only the surprise-kind Antigravity entry is filtered out");
    assert.equal(immediateResetKind([R("antigravity", "Surprise")]), "scheduled",
      "kind matching is case-sensitive: 'Surprise' is not filtered and not a surprise");
    assert.equal(immediateResetKind([R("antigravity", "surprise"), R("agy", "surprise")]), "surprise",
      "only the exact agent id 'antigravity' is filtered; a lookalike id still counts");
    assert.equal(immediateResetKind([R("antigravity", "surprise"), R("codex")]), "scheduled",
      "a missing kind counts as scheduled, not surprise");
    assert.equal(immediateResetKind([{ info: { kind: "surprise" } }]), "surprise",
      "an entry with no agent still counts as a surprise");
    // Quirk: malformed entries crash instead of being skipped — the collector
    // always builds well-formed { a, info } records, so this is unreachable
    // in practice, but the function does not defend itself.
    assert.throws(() => immediateResetKind([null]), TypeError, "a null entry cannot be destructured");
    assert.equal(immediateResetKind([{}]), "scheduled", "an empty entry has no kind, so it is scheduled");
    assert.throws(() => immediateResetKind({}), TypeError, "a non-array truthy has no .filter");
    assert.throws(() => immediateResetKind("nope"), TypeError, "a string has no .filter");
  }

  // ------------------------------------------------------- updateSurpriseState
  {
    for (const bad of ["abc", NaN, Infinity, -Infinity, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, undefined, {}, []]) {
      assert.throws(() => updateSurpriseState(null, "record", bad), /positive integer/, `at=${String(bad)}`);
    }
    // Quirk: `at` goes through Number(), so numeric strings and booleans are
    // silently coerced ([] coerces to 0 and is rejected above).
    assert.deepEqual(updateSurpriseState(null, "record", String(ts)), { at: ts, clickedAt: 0, playedAt: 0 });
    assert.equal(updateSurpriseState(null, "record", true).at, 1, "true coerces to timestamp 1");
    assert.equal(updateSurpriseState(null, "record", Number.MAX_SAFE_INTEGER).at, Number.MAX_SAFE_INTEGER);

    // Anything that is not an object with a safe-integer `at` is "no state".
    for (const cur of ["x", 42, [], {}, { at: "x" }, { at: 1.5 }, { at: null }, { at: NaN }, null, undefined]) {
      const label = JSON.stringify(cur) ?? String(cur);
      assert.deepEqual(updateSurpriseState(cur, "record", ts), { at: ts, clickedAt: 0, playedAt: 0 }, `record over ${label}`);
      assert.equal(updateSurpriseState(cur, "click", ts), null, `click over ${label} has nothing to acknowledge`);
      assert.equal(updateSurpriseState(cur, "played", ts), null, `played over ${label} has nothing to acknowledge`);
    }

    // Quirk: a stored `at` only needs to be a safe integer — a negative one is
    // a valid state — while the `at` argument must be positive, so the state
    // can never be acknowledged again (every matching timestamp is rejected).
    assert.deepEqual(updateSurpriseState({ at: -2 }, "click", ts), { at: -2, clickedAt: 0, playedAt: 0 },
      "a stale click leaves the odd state untouched");
    assert.throws(() => updateSurpriseState({ at: -2 }, "click", -2), /positive integer/,
      "the acknowledgement timestamp itself must be positive");

    // Stored fields are trusted as-is: junk clickedAt becomes 0, but negative
    // and fractional playedAt survive, and unknown fields are dropped.
    const weird = { at: ts, clickedAt: "junk", playedAt: -3, extra: "drop" };
    const clicked = updateSurpriseState(weird, "click", ts);
    assert.deepEqual(clicked, { at: ts, clickedAt: ts, playedAt: -3 });
    assert.equal(weird.clickedAt, "junk", "the input object is not mutated");
    assert.ok(!("extra" in clicked), "unknown fields are dropped from the rebuilt state");
    assert.equal(updateSurpriseState({ at: ts, playedAt: 2.5 }, "record", ts).playedAt, 2.5,
      "a same-timestamp record preserves even a fractional playedAt");

    // A stale acknowledgement returns the rebuilt state unchanged — stored
    // fields like clickedAt survive the round-trip.
    assert.deepEqual(updateSurpriseState({ at: ts + 1, clickedAt: 7 }, "played", ts),
      { at: ts + 1, clickedAt: 7, playedAt: 0 }, "stale played on newer state changes nothing");

    assert.throws(() => updateSurpriseState(null, "explode", ts), /unknown surprise state action: explode/);
    assert.throws(() => updateSurpriseState(null, "explode", "bad"), /positive integer/,
      "the timestamp is validated before the action name");
  }

  // ------------------------------------------------------- surpriseStateFile
  assert.equal(surpriseStateFile("/x/y"), path.join("/x/y", "antigravity-surprise.json"));
  assert.equal(surpriseStateFile("rel/dir/"), path.join("rel/dir", "antigravity-surprise.json"),
    "a trailing slash does not leak into the file name");

  // ------------------------------------------------------- writeSurpriseState
  {
    // Missing parent directories are created recursively.
    const nested = path.join(work, "deep", "deeper", "state.json");
    assert.deepEqual(writeSurpriseState(nested, "record", ts), { at: ts, clickedAt: 0, playedAt: 0 });
    assert.deepEqual(JSON.parse(fs.readFileSync(nested, "utf8")), { at: ts, clickedAt: 0, playedAt: 0 });
    assert.equal(fs.readdirSync(path.dirname(nested)).filter((f) => f.endsWith(".tmp") || f.endsWith(".lock")).length, 0,
      "no tmp or lock files are left behind");

    // Corrupt JSON is treated as empty state and rewritten on the next save,
    // so a damaged state file self-heals instead of throwing forever.
    const corrupt = path.join(work, "corrupt.json");
    fs.writeFileSync(corrupt, "{ this is not json");
    assert.deepEqual(writeSurpriseState(corrupt, "record", ts), { at: ts, clickedAt: 0, playedAt: 0 },
      "a corrupt state file does not throw");
    assert.deepEqual(JSON.parse(fs.readFileSync(corrupt, "utf8")), { at: ts, clickedAt: 0, playedAt: 0 },
      "the corrupt file is rewritten by the next save");
    assert.equal(fs.existsSync(`${corrupt}.lock`), false, "the lock is released even on a healed write");

    // Even a no-op acknowledgement rewrites a corrupt file (there is no
    // "unchanged" state to compare against).
    fs.writeFileSync(corrupt, "not json at all");
    assert.equal(writeSurpriseState(corrupt, "click", ts), null, "clicking with no recorded reset is still a no-op");
    assert.equal(JSON.parse(fs.readFileSync(corrupt, "utf8")), null, "the corrupt file is replaced, not left in place");

    // Valid JSON of the wrong shape is treated as "no state" and overwritten.
    for (const [i, content] of ["null", '"just a string"', "42", "true", "[1,2,3]", '{"at":"bogus"}', '{"at":1.5}'].entries()) {
      const f = path.join(work, `wrongtype-${i}.json`);
      fs.writeFileSync(f, content);
      writeSurpriseState(f, "record", ts);
      assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { at: ts, clickedAt: 0, playedAt: 0 }, `content=${content}`);
    }

    // Unknown fields in a well-formed state are dropped on the next write.
    const extra = path.join(work, "extra.json");
    fs.writeFileSync(extra, JSON.stringify({ at: ts, clickedAt: 0, playedAt: 0, extra: 1 }));
    writeSurpriseState(extra, "played", ts);
    assert.deepEqual(JSON.parse(fs.readFileSync(extra, "utf8")), { at: ts, clickedAt: 0, playedAt: ts });

    // Writing identical state is a no-op: same inode proves no tmp+rename.
    const noop = path.join(work, "noop.json");
    writeSurpriseState(noop, "record", ts);
    const ino1 = fs.statSync(noop).ino;
    writeSurpriseState(noop, "record", ts);
    assert.equal(fs.statSync(noop).ino, ino1, "an identical write does not rename over the file");
    writeSurpriseState(noop, "click", ts);
    assert.notEqual(fs.statSync(noop).ino, ino1, "a real change goes through tmp+rename");

    // A lock left by a dead process is broken and reclaimed immediately —
    // the lock file records its holder's pid, and a dead pid means the
    // critical section can never finish.
    const locked = path.join(work, "locked.json");
    const deadPid = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" }).pid;
    fs.writeFileSync(`${locked}.lock`, String(deadPid));
    const lockStart = Date.now();
    assert.deepEqual(writeSurpriseState(locked, "record", ts), { at: ts, clickedAt: 0, playedAt: 0 },
      "a lock whose holder pid is dead is taken over");
    assert.ok(Date.now() - lockStart < 4500, "a dead holder's lock does not burn the 5 s deadline");
    assert.equal(fs.existsSync(`${locked}.lock`), false, "the reclaimed lock is released after the write");
    assert.deepEqual(JSON.parse(fs.readFileSync(locked, "utf8")), { at: ts, clickedAt: 0, playedAt: 0 });

    // A lock with no readable pid is stale once it is older than a short
    // limit; a fresh one is still treated as held and waited out (the `held`
    // case below).
    const oldLock = path.join(work, "oldlock.json");
    fs.writeFileSync(`${oldLock}.lock`, "held");
    const longAgo = new Date(Date.now() - 60000);
    fs.utimesSync(`${oldLock}.lock`, longAgo, longAgo);
    assert.deepEqual(writeSurpriseState(oldLock, "record", ts), { at: ts, clickedAt: 0, playedAt: 0 },
      "an old pid-less lock is taken over");
    assert.equal(fs.existsSync(`${oldLock}.lock`), false);

    // A lock held by a live pid is never broken, no matter how long it is
    // held: the call still spins out the 5 s deadline and throws EEXIST.
    const liveLock = path.join(work, "livelock.json");
    fs.writeFileSync(`${liveLock}.lock`, String(process.pid));
    const liveStart = Date.now();
    assert.throws(() => writeSurpriseState(liveLock, "record", ts), { code: "EEXIST" });
    assert.ok(Date.now() - liveStart >= 4500, "a live holder's lock is honoured to the deadline");
    fs.unlinkSync(`${liveLock}.lock`);
    assert.deepEqual(writeSurpriseState(liveLock, "record", ts), { at: ts, clickedAt: 0, playedAt: 0 },
      "the write recovers once the live lock is removed");

    // A lock that is released while we wait is simply waited out.
    const held = path.join(work, "held.json");
    const heldLock = `${held}.lock`;
    fs.writeFileSync(heldLock, "held");
    const delayed = spawn(process.execPath,
      ["-e", `setTimeout(() => require("node:fs").unlinkSync(${JSON.stringify(heldLock)}), 300)`],
      { stdio: "ignore" });
    const holdStart = Date.now();
    const heldState = writeSurpriseState(held, "record", ts);
    const holdElapsed = Date.now() - holdStart;
    await new Promise((resolve) => delayed.once("close", resolve));
    assert.deepEqual(heldState, { at: ts, clickedAt: 0, playedAt: 0 });
    assert.ok(holdElapsed >= 250 && holdElapsed < 5000,
      `a released lock is waited out, not failed (${holdElapsed} ms)`);

    // A state path that is a directory fails on read and still frees the lock.
    const asDir = path.join(work, "asdir.json");
    fs.mkdirSync(asDir);
    assert.throws(() => writeSurpriseState(asDir, "record", ts));
    assert.equal(fs.existsSync(`${asDir}.lock`), false, "the lock is released on read failure");

    // ------------------------------------------------- concurrent processes
    const childWrite = (file, action, at) => new Promise((resolve, reject) => {
      const src = `import { writeSurpriseState } from ${JSON.stringify(scriptUrl)};\n` +
        `writeSurpriseState(${JSON.stringify(file)}, ${JSON.stringify(action)}, ${at});`;
      const c = spawn(process.execPath, ["--input-type=module", "-e", src], { stdio: "ignore" });
      c.once("error", reject);
      c.once("close", (code) => code === 0 ? resolve() : reject(new Error(`child ${action} ${at} exited ${code}`)));
    });

    // Six children acknowledging the same reset: every write applies, so the
    // final state is deterministic regardless of interleaving.
    const race1 = path.join(work, "race1.json");
    writeSurpriseState(race1, "record", ts);
    await Promise.all([
      ...Array.from({ length: 3 }, () => childWrite(race1, "click", ts)),
      ...Array.from({ length: 3 }, () => childWrite(race1, "played", ts)),
    ]);
    assert.deepEqual(JSON.parse(fs.readFileSync(race1, "utf8")), { at: ts, clickedAt: ts, playedAt: ts },
      "parallel acknowledgements of one reset all land");
    assert.equal(fs.existsSync(`${race1}.lock`), false);

    // Mixed timestamps: whichever interleaving wins, the file must stay a
    // valid state and stale writes must never resurrect old timestamps.
    const race2 = path.join(work, "race2.json");
    writeSurpriseState(race2, "record", ts);
    const tsNew = ts + 1;
    await Promise.all([
      childWrite(race2, "click", ts), childWrite(race2, "played", ts),
      childWrite(race2, "record", tsNew), childWrite(race2, "click", tsNew),
      childWrite(race2, "played", ts), childWrite(race2, "record", ts),
    ]);
    const fin = JSON.parse(fs.readFileSync(race2, "utf8"));
    assert.ok(fin.at === ts || fin.at === tsNew, `final reset time is one of the writers' (${fin.at})`);
    if (fin.at === tsNew) {
      assert.equal(fin.playedAt, 0, "no played write ever targeted the new reset");
      assert.ok(fin.clickedAt === 0 || fin.clickedAt === tsNew, "only the new reset's own click can stick");
    } else {
      assert.ok(fin.clickedAt === 0 || fin.clickedAt === ts, "a stale click cannot stamp the new timestamp");
      assert.ok(fin.playedAt === 0 || fin.playedAt === ts, "a stale played cannot stamp the new timestamp");
    }
    assert.equal(fs.existsSync(`${race2}.lock`), false, "no lock is leaked by the race");
    assert.equal(fs.readdirSync(work).filter((f) => f.endsWith(".tmp")).length, 0, "no tmp files are leaked");
  }

  // ------------------------------------------------------- CLI subprocesses
  const cliEnv = (dir, extra = {}) => {
    const env = {
      ...process.env,
      HOME: path.join(dir, "home"),
      XDG_STATE_HOME: path.join(dir, "state"),
      XDG_CONFIG_HOME: path.join(dir, "config"),
      XDG_CACHE_HOME: path.join(dir, "cache"),
      ...extra,
    };
    for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) fs.mkdirSync(env[k], { recursive: true });
    return env;
  };
  const cliStateFile = (dir) => surpriseStateFile(path.join(dir, "state", "omarchy", "agent-usage-tabs"));
  const cliLogFile = (dir) => path.join(dir, "state", "omarchy", "agent-usage-tabs", "collector.log");
  const runCli = (dir, args, extraEnv = {}) =>
    spawnSync(process.execPath, [script, ...args], { env: cliEnv(dir, extraEnv), encoding: "utf8" });
  const freshDir = (name) => {
    const d = path.join(work, name);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };

  {
    // record via CLI writes the state file and exits 0.
    const d = freshDir("cli-record");
    const r = runCli(d, ["record", String(ts)]);
    assert.equal(r.status, 0, `record exited ${r.status}: ${r.stderr}`);
    assert.deepEqual(JSON.parse(fs.readFileSync(cliStateFile(d), "utf8")), { at: ts, clickedAt: 0, playedAt: 0 });
  }
  {
    // A non-numeric timestamp is an error: exit 1 and a collector.log line.
    const d = freshDir("cli-bad-at");
    const r = runCli(d, ["record", "abc"]);
    assert.equal(r.status, 1);
    assert.match(fs.readFileSync(cliLogFile(d), "utf8"), /antigravity surprise notification.*positive integer/s);
    assert.equal(fs.existsSync(cliStateFile(d)), false, "a failed write creates no state file");
  }
  {
    // No arguments at all: action and timestamp are undefined -> same failure.
    const d = freshDir("cli-noargs");
    const r = runCli(d, []);
    assert.equal(r.status, 1);
    assert.match(fs.readFileSync(cliLogFile(d), "utf8"), /antigravity surprise notification/);
  }
  {
    // An unknown action name fails the same way, case-sensitively.
    const d = freshDir("cli-bad-action");
    const r = runCli(d, ["RECORD", String(ts)]);
    assert.equal(r.status, 1);
    assert.match(fs.readFileSync(cliLogFile(d), "utf8"), /unknown surprise state action: RECORD/);
  }
  {
    // played/click with no recorded reset is a silent no-op: exit 0 and no
    // file is created (updateSurpriseState returns null == null, so the
    // "unchanged" check skips the write entirely).
    const d = freshDir("cli-noop");
    assert.equal(runCli(d, ["played", String(ts)]).status, 0);
    assert.equal(runCli(d, ["click", String(ts)]).status, 0);
    assert.equal(fs.existsSync(cliStateFile(d)), false, "acknowledging nothing writes nothing");
  }
  {
    // Without XDG_STATE_HOME the module falls back to ~/.local/state.
    const d = freshDir("cli-home-fallback");
    const env = { ...process.env, HOME: path.join(d, "home") };
    delete env.XDG_STATE_HOME;
    fs.mkdirSync(env.HOME, { recursive: true });
    const r = spawnSync(process.execPath, [script, "record", String(ts)], { env, encoding: "utf8" });
    assert.equal(r.status, 0, `record exited ${r.status}: ${r.stderr}`);
    const fallback = path.join(d, "home", ".local", "state", "omarchy", "agent-usage-tabs", "antigravity-surprise.json");
    assert.deepEqual(JSON.parse(fs.readFileSync(fallback, "utf8")), { at: ts, clickedAt: 0, playedAt: 0 });
  }

  // notify-send stub: records argv, prints canned stdout/stderr, exits canned.
  const stubBin = path.join(work, "stub-bin");
  fs.mkdirSync(stubBin, { recursive: true });
  const argvFile = path.join(work, "notify-argv.txt");
  fs.writeFileSync(path.join(stubBin, "notify-send"),
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\n` +
    `printf '%s' "$STUB_NOTIFY_STDOUT"\nprintf '%s' "$STUB_NOTIFY_STDERR" >&2\n` +
    `exit "\${STUB_NOTIFY_EXIT:-0}"\n`, { mode: 0o755 });
  const notifyEnv = (d, extra = {}) => ({
    PATH: `${stubBin}:${process.env.PATH}`,
    STUB_NOTIFY_STDOUT: "", STUB_NOTIFY_STDERR: "", STUB_NOTIFY_EXIT: "0",
    ...extra,
  });
  const expectedImage = path.join(path.dirname(script), "..", "notify", "surprise-burst.svg");

  {
    // The full argv vector reaches notify-send verbatim, and a "default"
    // answer records the click for that reset.
    const d = freshDir("cli-notify-ok");
    writeSurpriseState(cliStateFile(d), "record", ts);
    const title = "Antigravity reset early", body = "It reset before the window ended.";
    const r = runCli(d, ["notify", String(ts), title, body], notifyEnv(d, { STUB_NOTIFY_STDOUT: "default" }));
    assert.equal(r.status, 0, `notify exited ${r.status}: ${r.stderr}`);
    const sent = fs.readFileSync(argvFile, "utf8").split("\n");
    sent.pop(); // trailing newline
    assert.deepEqual(sent, surpriseNotifyArgs({ title, body }, expectedImage),
      "spawn passes the exact arg vector through to notify-send");
    assert.deepEqual(JSON.parse(fs.readFileSync(cliStateFile(d), "utf8")), { at: ts, clickedAt: ts, playedAt: 0 });
  }
  {
    // The click match is exact: 'DEFAULT' or extra output is not a click.
    for (const [i, out] of ["DEFAULT", "default\nextra"].entries()) {
      const d = freshDir(`cli-notify-out-${i}`);
      writeSurpriseState(cliStateFile(d), "record", ts);
      const r = runCli(d, ["notify", String(ts), "t", "b"], notifyEnv(d, { STUB_NOTIFY_STDOUT: out }));
      assert.equal(r.status, 0);
      assert.equal(JSON.parse(fs.readFileSync(cliStateFile(d), "utf8")).clickedAt, 0,
        `stdout ${JSON.stringify(out)} is not the default action`);
    }
  }
  {
    // A stale notification's click cannot touch a newer recorded reset.
    const d = freshDir("cli-notify-stale");
    writeSurpriseState(cliStateFile(d), "record", ts + 5);
    const r = runCli(d, ["notify", String(ts), "t", "b"], notifyEnv(d, { STUB_NOTIFY_STDOUT: "default" }));
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(cliStateFile(d), "utf8")), { at: ts + 5, clickedAt: 0, playedAt: 0 });
  }
  {
    // notify-send failing exits 1 and its stderr lands in collector.log.
    const d = freshDir("cli-notify-fail");
    const r = runCli(d, ["notify", String(ts), "t", "b"],
      notifyEnv(d, { STUB_NOTIFY_EXIT: "3", STUB_NOTIFY_STDERR: "notify-send exploded\n" }));
    assert.equal(r.status, 1);
    assert.match(fs.readFileSync(cliLogFile(d), "utf8"), /notify-send exploded/);
  }
  {
    // notify-send missing from PATH: spawn 'error' -> exit 1, logged.
    const d = freshDir("cli-notify-missing");
    const r = runCli(d, ["notify", String(ts), "t", "b"], { PATH: "/nonexistent-dir-xyz" });
    assert.equal(r.status, 1);
    assert.match(fs.readFileSync(cliLogFile(d), "utf8"), /notify-send|ENOENT/);
  }
  {
    // `notify <at>` without title/body is a usage error: exit 1 with a plain
    // message and notify-send is never spawned (previously the undefined
    // args were stringified to the literal text "undefined" and a real
    // critical notification titled "undefined" was shown).
    const d = freshDir("cli-notify-notitle");
    fs.rmSync(argvFile, { force: true });
    for (const args of [["notify", String(ts)], ["notify", String(ts), "only a title"]]) {
      const r = runCli(d, args, notifyEnv(d));
      assert.equal(r.status, 1, `notify ${args.slice(1).join(" ")} exited ${r.status}`);
      assert.match(r.stderr, /usage: antigravity-surprise\.mjs notify <at> <title> <body>/);
    }
    assert.equal(fs.existsSync(argvFile), false, "notify-send was not spawned for a malformed notify");
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
console.log("antigravity-surprise deep: all tests passed");
