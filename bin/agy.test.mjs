import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// agy.mjs is a script (it exits on run), exercised as a subprocess against a
// scratch AGY_DIR. PATH points nowhere so `secret-tool` and `agy` cannot be
// found: the keyring lookup fails, the token file is the only login source,
// and every fixture stops before the network fetch.
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "agy.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-test-"));
const agyDir = path.join(tmp, "agy-home");
const xdg = path.join(tmp, "xdg");
fs.mkdirSync(agyDir, { recursive: true });
const run = () => spawnSync(process.execPath, [script], {
  encoding: "utf8", timeout: 30000,
  env: { ...process.env, HOME: path.join(tmp, "nohome"), AGY_DIR: agyDir, XDG_STATE_HOME: xdg, PATH: "/nonexistent" },
});
const out = (r) => { assert.equal(r.status, 0, `agy.mjs failed: ${r.stderr}`); return JSON.parse(r.stdout); };

// 1. No keyring entry, no token file: the signed-out line.
let j = out(run());
assert.equal(j.status, "Not signed in — run `agy` to log in.");
assert.deepEqual(j.limits, []);

// 2. An expired token file kicks `agy models` once; with no agy on PATH the
//    kick fails and the status says so. A second run inside the cooldown must
//    not kick again: the kick file stays byte-identical.
fs.writeFileSync(path.join(agyDir, "antigravity-oauth-token"),
  JSON.stringify({ token: { access_token: "tok", expiry: "2020-01-01T00:00:00Z" } }));
j = out(run());
assert.equal(j.status, "Sign-in expired and agy couldn't refresh it — run `agy` and sign in again.");
const kickFile = path.join(xdg, "omarchy", "agent-usage-tabs", "agy-kick.json");
assert.ok(fs.existsSync(kickFile), "the kick attempt is remembered");
const kickBytes = fs.readFileSync(kickFile, "utf8");
j = out(run());
assert.equal(j.status, "Sign-in expired and agy couldn't refresh it — run `agy` and sign in again.");
assert.equal(fs.readFileSync(kickFile, "utf8"), kickBytes, "cooled down: no second kick");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("agy: all tests passed");
