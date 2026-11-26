// Deep tests for bin/refresh-targets.mjs: real-filesystem behavior, edge
// inputs, corrupt/odd registry files, wrong argument types and path shapes.
// The existing refresh-targets.test.mjs covers the injected `exists` fn with
// fake paths; everything here goes through the real fs in a temp HOME.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { refreshTargets } from "./refresh-targets.mjs";

// Never touch the real home folder: point every XDG/HOME var at a temp dir.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-targets-deep-"));
process.env.HOME = ROOT;
process.env.XDG_STATE_HOME = path.join(ROOT, "state");
process.env.XDG_CONFIG_HOME = path.join(ROOT, "config");
process.env.XDG_CACHE_HOME = path.join(ROOT, "cache");

const accountsDir = (...parts) => path.join(ROOT, "state", "omarchy", "agents", "accounts", ...parts);
const writeRegistry = (name, contents) => {
  const dir = accountsDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), contents);
};
const cleanup = () => fs.rmSync(ROOT, { recursive: true, force: true });

try {
  // --- default exists = fs.existsSync against the real filesystem ---------

  fs.rmSync(accountsDir(), { recursive: true, force: true });
  assert.deepEqual(refreshTargets(["codex", "grok"], accountsDir()), ["codex", "grok"], "missing accounts dir: builtins only");

  writeRegistry("claude.json", "{}");
  assert.deepEqual(refreshTargets(["codex", "grok"], accountsDir()), ["codex", "grok", "claude"], "real claude.json adds claude");

  fs.rmSync(path.join(accountsDir(), "claude.json"));
  writeRegistry("codex.json", "{}");
  writeRegistry("grok.json", "{}");
  assert.deepEqual(refreshTargets(["codex", "grok"], accountsDir()), ["codex", "grok"], "other registries add nothing: they are builtins already");

  // --- corrupt / odd registry contents ------------------------------------
  // The module only checks existence; it never parses the file. Every one of
  // these must still count as "a registry exists".
  for (const [label, contents] of [
    ["empty file", ""],
    ["not json", "this is not json {"],
    ["valid json array", "[]"],
    ["null", "null"],
    ["binary garbage", Buffer.from([0, 1, 2, 255, 254, 253])],
  ]) {
    fs.rmSync(path.join(accountsDir(), "claude.json"), { force: true });
    writeRegistry("claude.json", contents);
    assert.deepEqual(
      refreshTargets(["codex"], accountsDir()),
      ["codex", "claude"],
      `${label}: existence alone adds claude`,
    );
  }

  // A directory named claude.json also satisfies existsSync. Whether that
  // should count as a registry is the collector's call, not this function's;
  // document the current behavior.
  fs.rmSync(path.join(accountsDir(), "claude.json"), { force: true });
  fs.mkdirSync(path.join(accountsDir(), "claude.json"));
  assert.deepEqual(
    refreshTargets(["codex"], accountsDir()),
    ["codex", "claude"],
    "a directory named claude.json counts as existing (existsSync semantics)",
  );
  fs.rmSync(path.join(accountsDir(), "claude.json"), { recursive: true, force: true });

  // --- path shape edges ----------------------------------------------------

  // Trailing slash on accountsDir must not change the joined path.
  writeRegistry("claude.json", "{}");
  assert.deepEqual(
    refreshTargets(["codex"], accountsDir() + path.sep),
    ["codex", "claude"],
    "trailing separator on accountsDir still finds claude.json",
  );

  // A relative accountsDir that does not exist resolves against cwd; builtins
  // pass through untouched either way.
  assert.deepEqual(
    refreshTargets(["codex"], "definitely-not-a-real-dir-xyz"),
    ["codex"],
    "relative missing dir: builtins only",
  );

  // accountsDir that is itself a file: join still produces a child path that
  // cannot exist, so builtins only.
  const fileDir = path.join(ROOT, "a-file-not-a-dir");
  fs.writeFileSync(fileDir, "x");
  assert.deepEqual(
    refreshTargets(["codex"], fileDir),
    ["codex"],
    "accountsDir pointing at a file finds no registry",
  );

  // --- builtinIds edge cases ----------------------------------------------

  assert.deepEqual(refreshTargets([], accountsDir()), ["claude"], "empty builtins still get claude when registry exists");
  assert.deepEqual(refreshTargets(["claude"], accountsDir()), ["claude"], "claude already present: no duplicate, order kept");
  assert.deepEqual(refreshTargets(["grok", "codex"], accountsDir()), ["grok", "codex", "claude"], "order of builtins preserved, claude appended last");

  // Wrong types: the function spreads builtinIds, so a string fans out into
  // characters and null/undefined throw. Assert the actual contract rather
  // than an ideal one.
  assert.deepEqual(
    refreshTargets("codex", accountsDir()),
    [..."codex", "claude"],
    "a string builtinIds spreads into characters (documented, not guarded)",
  );
  assert.throws(() => refreshTargets(null, accountsDir()), TypeError, "null builtinIds throws");
  assert.throws(() => refreshTargets(undefined, accountsDir()), TypeError, "undefined builtinIds throws");
  assert.throws(() => refreshTargets(42, accountsDir()), TypeError, "number builtinIds throws");

  // --- injected `exists` edge cases ----------------------------------------

  // exists that throws propagates rather than being swallowed.
  assert.throws(
    () => refreshTargets(["codex"], accountsDir(), () => { throw new Error("boom"); }),
    /boom/,
    "a throwing exists fn propagates",
  );

  // exists returning a truthy non-boolean still counts.
  assert.deepEqual(
    refreshTargets(["codex"], accountsDir(), () => "yes"),
    ["codex", "claude"],
    "truthy non-boolean exists result counts",
  );
  assert.deepEqual(
    refreshTargets(["codex"], accountsDir(), () => 0),
    ["codex"],
    "falsy exists result does not",
  );

  // The injected fn is called with exactly the joined claude.json path.
  const seen = [];
  refreshTargets(["codex"], accountsDir(), (p) => { seen.push(p); return false; });
  assert.deepEqual(seen, [path.join(accountsDir(), "claude.json")], "exists is probed with the joined claude.json path only");

  // Input array is not mutated.
  const input = ["codex", "grok"];
  refreshTargets(input, accountsDir(), () => true);
  assert.deepEqual(input, ["codex", "grok"], "builtinIds argument is not mutated");

  console.log("refresh-targets deep tests: all passed");
} finally {
  cleanup();
}
