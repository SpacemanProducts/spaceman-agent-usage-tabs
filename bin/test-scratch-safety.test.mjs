// Every bin/*.test.mjs that builds a scratch/temp base from os.homedir() must
// also check path.isAbsolute( before using it (the constance-*.test.mjs pattern:
// a candidate list like ["/var/tmp", path.join(os.homedir(), ".cache")] with
// `if (!path.isAbsolute(base)) continue;`). A homedir-derived base can be
// relative or wrong when HOME is unset/redirected; the guard keeps mkdtempSync
// honest. This test scans every test file and fails, naming the file, when the
// unsafe shape appears without the guard.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// True when `src` builds a scratch/temp base out of os.homedir() and never
// checks path.isAbsolute( anywhere.
function scratchHomedirOffense(src) {
  if (!src.includes("os.homedir()")) return false;
  if (src.includes("isAbsolute(")) return false;
  // fs.mkdtempSync(path.join(os.homedir(), ...)) / mkdirSync same shape.
  if (/(?:mkdtempSync|mkdirSync)\(\s*path\.join\([^)]*os\.homedir\(\)/.test(src)) return true;
  // A candidates array of bases, one built from os.homedir(), feeding mkdtemp.
  if (/of\s*\[[^\]]*os\.homedir\(\)[^\]]*\]/.test(src) && /mkdtempSync/.test(src)) return true;
  // A variable assigned from path.join(os.homedir(), ...) used for scratch dirs.
  if (/=\s*path\.join\(\s*os\.homedir\(\)/.test(src) && /(?:mkdtempSync|mkdirSync)/.test(src)) return true;
  return false;
}

// Self-check: the detector must flag an unguarded sample and pass a guarded one.
const unguarded = `const root = fs.mkdtempSync(path.join(os.homedir(), ".cache", "t-"));`;
const guarded = `let root = "";
for (const base of ["/var/tmp", path.join(os.homedir(), ".cache")]) {
  if (!path.isAbsolute(base)) continue;
  try { root = fs.mkdtempSync(path.join(base, "t-")); break; } catch {}
}`;
assert.equal(scratchHomedirOffense(unguarded), true, "unguarded homedir scratch base is flagged");
assert.equal(scratchHomedirOffense(guarded), false, "guarded homedir scratch base passes");
// os.homedir() in assertions or plain path joins is not a scratch base.
assert.equal(scratchHomedirOffense(`assert.equal(x, path.join(os.homedir(), ".local/state"));`), false);
assert.equal(scratchHomedirOffense(`const d = fs.mkdtempSync(path.join(os.tmpdir(), "t-"));`), false);

const dir = path.dirname(new URL(import.meta.url).pathname);
const offenders = [];
for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".test.mjs")).sort()) {
  const file = path.join(dir, name);
  const src = fs.readFileSync(file, "utf8");
  if (scratchHomedirOffense(src)) offenders.push(name);
}
assert.deepEqual(offenders, [], `test files building a scratch base from os.homedir() without a path.isAbsolute( guard: ${offenders.join(", ")}`);

console.log("test-scratch-safety: tests passed");
