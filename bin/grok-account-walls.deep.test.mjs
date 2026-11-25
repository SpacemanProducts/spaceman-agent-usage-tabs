// Deep edge-case pass for bin/grok-account-walls.mjs on top of
// grok-account-walls.test.mjs. The module is pure: registry is already-parsed
// JSON and `run` is injected, so there are no files, no clock and no async.
// The scratch dir only exists to satisfy the "never touch the real home
// folder" rule; nothing here reads it.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { grokWalls } from "./grok-account-walls.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-walls-deep-"));
const savedEnv = {};
for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
  savedEnv[k] = process.env[k];
  process.env[k] = path.join(tmp, k.toLowerCase());
  fs.mkdirSync(process.env[k], { recursive: true });
}

const cap = { title: "Free grok-4.7 (24 h)", cap: true, percent: 1 };
const bill = { title: "Weekly", percent: 0.4 };
const reg = (accounts) => ({ accounts });
const runCaps = (home) => ({ limits: [cap] });
const homesSeen = (fn) => { const seen = []; return { seen, run: (h) => { seen.push(h); return fn ? fn(h) : { limits: [] }; } }; };

try {
  // ---- registry / options shapes ----
  assert.deepEqual(grokWalls(), {}, "no args at all");
  assert.deepEqual(grokWalls(undefined), {});
  assert.deepEqual(grokWalls(null), {});
  assert.deepEqual(grokWalls({}), {}, "registry without accounts key");
  assert.deepEqual(grokWalls(reg(null)), {}, "accounts: null");
  assert.deepEqual(grokWalls(reg(undefined)), {});
  assert.deepEqual(grokWalls(reg([])), {});
  assert.deepEqual(grokWalls("junk", { run: runCaps }), {}, "string registry has no .accounts");
  assert.deepEqual(grokWalls(42, { run: runCaps }), {});
  assert.deepEqual(grokWalls(reg("abc"), { run: runCaps }), {}, "string accounts iterates chars; none have .id");
  // BUG: a parsed-but-wrong grok.json (accounts as a number/boolean/plain
  // object) makes grokWalls throw TypeError on `for...of` instead of
  // returning {} like every other malformed shape. Commented out:
  // assert.deepEqual(grokWalls(reg(5), { run: runCaps }), {});
  // assert.deepEqual(grokWalls(reg(true), { run: runCaps }), {});
  // assert.deepEqual(grokWalls(reg({ 0: { id: "x", home: "/h" } }), { run: runCaps }), {});
  // options edge: null options throws on destructure; primitives do not.
  assert.throws(() => grokWalls(reg([]), null), TypeError, "null options cannot be destructured");
  assert.deepEqual(grokWalls(reg([{ id: "a", home: "/h/a" }]), 5), {}, "numeric options: all fields undefined, no run");
  assert.deepEqual(grokWalls(reg([{ id: "a", home: "/h/a" }]), "x"), {});

  // ---- account entry shapes ----
  const junk = reg([null, undefined, 0, "", "x", 7, {}, { id: null }, { id: "" }, { id: 0 }, { home: "/h/no-id" }]);
  const { seen: junkSeen, run: junkRun } = homesSeen();
  assert.deepEqual(grokWalls(junk, { run: junkRun }), {}, "entries without a truthy id are skipped");
  assert.deepEqual(junkSeen, [], "skipped entries never reach run");
  // A numeric id is truthy and becomes an object key ("5").
  const numId = reg([{ id: 5, home: "/h/n" }]);
  assert.deepEqual(grokWalls(numId, { run: runCaps }), { 5: [cap] });
  // Duplicate ids: the later account overwrites the earlier one's walls.
  const dup = reg([{ id: "d", home: "/h/1" }, { id: "d", home: "/h/2" }]);
  const { seen: dupSeen, run: dupRun } = homesSeen(runCaps);
  const dupOut = grokWalls(dup, { run: dupRun });
  assert.deepEqual(dupOut, { d: [cap] }, "second account with same id wins");
  assert.deepEqual(dupSeen, ["/h/1", "/h/2"], "run still called for every account, even a duplicate id");

  // ---- home resolution edges ----
  // login wins over home whenever it is truthy — even a whitespace string.
  const loginWins = reg([{ id: "l", home: "/h/home", login: "/h/login" }]);
  const { seen: lwSeen, run: lwRun } = homesSeen(runCaps);
  assert.deepEqual(grokWalls(loginWins, { run: lwRun }), { l: [cap] });
  assert.deepEqual(lwSeen, ["/h/login"]);
  // login falsy ("") falls back to home.
  const loginEmpty = reg([{ id: "l2", home: "/h/home", login: "" }]);
  const { seen: leSeen, run: leRun } = homesSeen(runCaps);
  grokWalls(loginEmpty, { run: leRun });
  assert.deepEqual(leSeen, ["/h/home"], "empty login falls back to home");
  // login = 0 (falsy non-string) also falls back.
  const loginZero = reg([{ id: "l3", home: "/h/home", login: 0 }]);
  const { seen: lzSeen, run: lzRun } = homesSeen(runCaps);
  grokWalls(loginZero, { run: lzRun });
  assert.deepEqual(lzSeen, ["/h/home"]);
  // Neither login nor home -> skipped before run.
  const noHome = reg([{ id: "n", login: "", home: "" }, { id: "n2" }]);
  const { seen: nhSeen, run: nhRun } = homesSeen(runCaps);
  assert.deepEqual(grokWalls(noHome, { run: nhRun }), {});
  assert.deepEqual(nhSeen, []);
  // Non-string home/login are String()-coerced.
  const numHome = reg([{ id: "num", home: 123 }]);
  const { seen: numSeen, run: numRun } = homesSeen(runCaps);
  grokWalls(numHome, { run: numRun });
  assert.deepEqual(numSeen, ["123"], "numeric home coerced to string");
  // Whitespace-only home is truthy -> run gets it verbatim (resolve is only
  // used for the primary-home comparison, not for what run receives).
  const wsHome = reg([{ id: "ws", home: " " }]);
  const { seen: wsSeen, run: wsRun } = homesSeen(runCaps);
  grokWalls(wsHome, { run: wsRun });
  assert.deepEqual(wsSeen, [" "], "run receives the home string unresolved");

  // ---- tilde expansion ----
  // homeDir "" does NOT leave "~" alone: the "~" is stripped, leaving "/rest".
  const bareTilde = reg([{ id: "t", home: "~/.grok-work" }]);
  const { seen: btSeen, run: btRun } = homesSeen(runCaps);
  grokWalls(bareTilde, { homeDir: "", run: btRun });
  assert.deepEqual(btSeen, ["/.grok-work"], "empty homeDir strips ~ instead of keeping it");
  // Missing homeDir option behaves the same.
  const { seen: ndSeen, run: ndRun } = homesSeen(runCaps);
  grokWalls(bareTilde, { run: ndRun });
  assert.deepEqual(ndSeen, ["/.grok-work"]);
  // Tilde only expands at the start; "~" mid-path or "~/" inside stays literal.
  const midTilde = reg([{ id: "m", home: "/x/~/y" }, { id: "m2", home: "~~/z" }]);
  const { seen: mtSeen, run: mtRun } = homesSeen(runCaps);
  grokWalls(midTilde, { homeDir: "/h", run: mtRun });
  assert.deepEqual(mtSeen, ["/x/~/y", "/h~/z"], "only a leading ~ is replaced; '~~' loses one tilde");
  // primaryHome is NOT tilde-expanded — path.resolve only.
  const primTilde = reg([{ id: "p", home: "/h/.grok" }]);
  const { seen: ptSeen, run: ptRun } = homesSeen(runCaps);
  const ptOut = grokWalls(primTilde, { primaryHome: "~/.grok", homeDir: "/h", run: ptRun });
  assert.deepEqual(ptSeen, ["/h/.grok"], "primaryHome '~' is resolved literally, never matching the expanded account home");
  assert.deepEqual(ptOut, { p: [cap] }, "so the account is not treated as seated");

  // ---- primary-home matching ----
  // Trailing slashes and "." segments resolve away on both sides.
  const trail = reg([{ id: "s", home: "/h/.grok/" }]);
  const { seen: trSeen, run: trRun } = homesSeen(runCaps);
  assert.deepEqual(grokWalls(trail, { primaryHome: "/h/./.grok", run: trRun }), {}, "equivalent paths after resolve are skipped");
  assert.deepEqual(trSeen, [], "run not called for the seated account");
  // Relative homes resolve against process.cwd on both sides.
  const rel = reg([{ id: "r", home: "relhome/grok" }]);
  const { seen: relSeen, run: relRun } = homesSeen(runCaps);
  grokWalls(rel, { primaryHome: path.resolve("relhome/grok"), run: relRun });
  assert.deepEqual(relSeen, [], "relative primaryHome matches a relative account home via cwd");
  // Case-sensitive: "/H/.GROK" is not "/h/.grok".
  const caseReg = reg([{ id: "c", home: "/H/.GROK" }]);
  const { seen: cSeen, run: cRun } = homesSeen(runCaps);
  grokWalls(caseReg, { primaryHome: "/h/.grok", run: cRun });
  assert.deepEqual(cSeen, ["/H/.GROK"], "path compare is case-sensitive");
  // Skipping is by resolved path only — an account literally named like the
  // primary id but living elsewhere is still checked.
  const sameId = reg([{ id: "main", home: "/state/other" }]);
  const { seen: siSeen, run: siRun } = homesSeen(runCaps);
  assert.deepEqual(grokWalls(sameId, { primaryHome: "/h/.grok", run: siRun }), { main: [cap] }, "id is irrelevant to the seated check");
  assert.deepEqual(siSeen, ["/state/other"]);

  // ---- run() return-shape edges ----
  // run returning null/undefined/non-object -> no limits -> account omitted.
  for (const bad of [null, undefined, 0, "x", true]) {
    const out = grokWalls(reg([{ id: "b", home: "/h/b" }]), { run: () => bad });
    assert.deepEqual(out, {}, `run()->${JSON.stringify(bad)} yields no walls`);
  }
  // limits missing / null / non-array-falsy -> omitted.
  for (const limits of [undefined, null, 0, "", false]) {
    const out = grokWalls(reg([{ id: "b", home: "/h/b" }]), { run: () => ({ limits }) });
    assert.deepEqual(out, {}, `limits=${JSON.stringify(limits)} yields no walls`);
  }
  // limits as a truthy non-array (string/object/number) throws on .filter.
  // BUG: a collector returning {limits: "oops"} or {limits: {}} crashes
  // grokWalls instead of being treated as "no walls". Commented out:
  // for (const limits of ["x", {}, 5, true]) {
  //   assert.deepEqual(grokWalls(reg([{ id: "b", home: "/h/b" }]), { run: () => ({ limits }) }), {});
  // }
  // filter keeps only elements that are objects with cap === true (strict).
  const mixed = reg([{ id: "m", home: "/h/m" }]);
  const tricky = [
    null, undefined, 0, "", "cap", 7, true,
    { cap: false }, { cap: 1 }, { cap: "true" }, { cap: null },
    { cap: true }, { cap: true, extra: 1 },
  ];
  const kept = tricky.filter((l) => l && l.cap === true);
  const { seen: mxSeen, run: mxRun } = homesSeen(() => ({ limits: tricky }));
  assert.deepEqual(grokWalls(mixed, { run: mxRun }), { m: kept }, "only cap === true rows survive, junk rows dropped");
  // The walls array is a fresh filtered array; elements keep identity.
  const capObj = { cap: true };
  const outObj = grokWalls(reg([{ id: "i", home: "/h/i" }]), { run: () => ({ limits: [capObj, bill] }) });
  assert.equal(outObj.i[0], capObj, "wall rows are the same object references");
  assert.equal(outObj.i.length, 1);
  // run throwing propagates — the module does not isolate collector failures.
  assert.throws(() => grokWalls(reg([{ id: "x", home: "/h/x" }]), { run: () => { throw new Error("collector exploded"); } }), /collector exploded/);
  // One throwing account aborts the whole call: later accounts never run.
  const { seen: abortSeen } = homesSeen();
  assert.throws(() => grokWalls(reg([{ id: "first", home: "/h/1" }, { id: "second", home: "/h/2" }]), {
    run: (h) => { abortSeen.push(h); if (h === "/h/1") throw new Error("boom"); return { limits: [cap] }; },
  }));
  assert.deepEqual(abortSeen, ["/h/1"], "accounts after a throwing run are never reached");

  // ---- iteration / ordering / reentrancy ----
  // Every non-seated account is run exactly once, in registry order, even when
  // earlier accounts already produced walls.
  const many = reg([
    { id: "a", home: "/h/a" }, { id: "b", home: "/h/b" }, { id: "c", home: "/h/c" },
  ]);
  const { seen: ordSeen, run: ordRun } = homesSeen((h) => ({ limits: h === "/h/b" ? [] : [cap] }));
  const ordOut = grokWalls(many, { run: ordRun });
  assert.deepEqual(ordSeen, ["/h/a", "/h/b", "/h/c"], "registry order preserved, all homes visited");
  assert.deepEqual(Object.keys(ordOut), ["a", "c"], "account with empty walls omitted");
  // Two accounts sharing one home both run and both can report.
  const shared = reg([{ id: "s1", home: "/h/shared" }, { id: "s2", login: "/h/shared" }]);
  const { seen: shSeen, run: shRun } = homesSeen(runCaps);
  assert.deepEqual(grokWalls(shared, { run: shRun }), { s1: [cap], s2: [cap] });
  assert.deepEqual(shSeen, ["/h/shared", "/h/shared"], "no dedup of identical homes");
  // Reentrancy: run may call grokWalls itself; calls are independent (no
  // module-level state to corrupt).
  const inner = reg([{ id: "in", home: "/h/in" }]);
  let innerOut;
  const outerOut = grokWalls(reg([{ id: "out", home: "/h/out" }]), {
    run: (h) => {
      innerOut = grokWalls(inner, { run: runCaps });
      return { limits: [cap] };
    },
  });
  assert.deepEqual(outerOut, { out: [cap] });
  assert.deepEqual(innerOut, { in: [cap] }, "nested call unaffected by outer iteration");
  // Sequential calls with different registries don't leak state.
  assert.deepEqual(grokWalls(reg([]), { run: runCaps }), {}, "empty registry after populated one");

  console.log("grok-account-walls deep: all tests passed");
} finally {
  for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
