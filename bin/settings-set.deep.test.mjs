// Deep edge-case pass for bin/settings-set.mjs on top of settings-set.test.mjs
// (which covers the happy paths, the basic rejects and one CLI round trip).
//
// settings-set.mjs is a small synchronous module: pure apply* functions plus a
// CLI main that does read-modify-write on
// $XDG_STATE_HOME/omarchy/agent-usage-tabs/settings.json (or ~/.local/state
// when XDG_STATE_HOME is unset) via a pid-named tmp file + rename. There is no
// clock or cache; the only timing surface is the multi-process
// read-modify-write race, which is pinned down commented out under "// BUG:".
//
// Tests that pin down QUIRKS assert the current behaviour and say so; nothing
// is fixed - this job is test-only.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applySetting, applyHidden, applyVolume, applyOrder, applyMaxCopies, applyMilk, applyBrain, DEFAULT_ORDER, ALLOWED, AGENT_IDS, CORE_IDS } from "./settings-set.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "settings-set-deep-"));
// Every env var that could steer a file lookup points inside tmp; the module
// itself only honours XDG_STATE_HOME and os.homedir() ($HOME), but the task
// requires all four set for anything this file spawns.
const HOME_DIR = path.join(tmp, "home");
const STATE_DIR = path.join(tmp, "xdg-state");
const CONFIG_DIR = path.join(tmp, "xdg-config");
const CACHE_DIR = path.join(tmp, "xdg-cache");
for (const d of [HOME_DIR, STATE_DIR, CONFIG_DIR, CACHE_DIR]) fs.mkdirSync(d, { recursive: true });
const savedEnv = {};
for (const [k, d] of [["HOME", HOME_DIR], ["XDG_STATE_HOME", STATE_DIR], ["XDG_CONFIG_HOME", CONFIG_DIR], ["XDG_CACHE_HOME", CACHE_DIR]]) {
  savedEnv[k] = process.env[k];
  process.env[k] = d;
}

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "settings-set.mjs");
// The settings file the CLI writes under STATE_DIR.
const SETTINGS = path.join(STATE_DIR, "omarchy", "agent-usage-tabs", "settings.json");

// Run the CLI with the sandboxed env; `extra` can override/remove vars
// (set a key to undefined to delete it).
function cliEnv(extra = {}) {
  const env = { ...process.env, HOME: HOME_DIR, XDG_STATE_HOME: STATE_DIR, XDG_CONFIG_HOME: CONFIG_DIR, XDG_CACHE_HOME: CACHE_DIR };
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k]; else env[k] = v;
  }
  return env;
}
const run = (...a) => spawnSync(process.execPath, [script, ...a], { env: cliEnv(), encoding: "utf8" });
const runAsync = (args) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [script, ...args], { env: cliEnv() });
  let out = "", err = "";
  p.stdout.on("data", (d) => out += d); p.stderr.on("data", (d) => err += d);
  p.on("error", reject); p.on("close", (code) => resolve({ code, out, err }));
});
const readSettings = () => JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
const writeSettings = (content) => { fs.mkdirSync(path.dirname(SETTINGS), { recursive: true }); fs.writeFileSync(SETTINGS, content); };
const resetState = () => fs.rmSync(path.join(STATE_DIR, "omarchy"), { recursive: true, force: true });

try {
  // ================================================================ applySetting
  {
    // Case-sensitive key: the panel sends exact names only.
    assert.throws(() => applySetting({}, "HideUninstalledAgents", "true"), /unknown setting/);
    assert.throws(() => applySetting({}, "hideshow", "true"), /unknown setting/);
    assert.throws(() => applySetting({}, "__proto__", "true"), /unknown setting/, "dunder keys are not settings");
    // Every advertised key round-trips both ways.
    for (const key of ALLOWED) {
      assert.deepEqual(applySetting({}, key, "true"), { [key]: true }, key);
      assert.deepEqual(applySetting({}, key, "false"), { [key]: false }, key);
    }
    // Wrong value spellings, including near-misses and non-strings.
    for (const bad of ["TRUE", "False", "1", "0", "yes", "no", "", " true", "true ", null, undefined, 1, 0, {}]) {
      assert.throws(() => applySetting({}, "resetSound", bad), /true or false/, `rejects ${JSON.stringify(bad)}`);
    }
    // Non-object `current` values all collapse to a fresh object.
    for (const cur of ["str", 42, true]) {
      assert.deepEqual(applySetting(cur, "resetSound", "true"), { resetSound: true }, `current=${String(cur)}`);
    }
    // Nested objects in current survive untouched (shallow spread keeps the ref).
    const nested = { deep: { a: [1, 2] } };
    const out = applySetting(nested, "resetSound", "true");
    assert.equal(out.deep, nested.deep, "nested object kept by reference");
    assert.equal(nested.resetSound, undefined, "input not mutated");
    // Setting the same key twice just overwrites the boolean.
    assert.deepEqual(applySetting(applySetting({}, "resetSound", "true"), "resetSound", "false"), { resetSound: false });
  }

  // ================================================================ applyVolume
  {
    // Number inputs (not just argv strings) are accepted when integral.
    assert.deepEqual(applyVolume({}, 60), { resetVolume: 60 });
    assert.deepEqual(applyVolume({}, 0), { resetVolume: 0 });
    assert.deepEqual(applyVolume({}, 100), { resetVolume: 100 });
    // Leading zeros are fine (regex allows up to 3 digits).
    assert.deepEqual(applyVolume({}, "007"), { resetVolume: 7 });
    assert.deepEqual(applyVolume({}, "000"), { resetVolume: 0 });
    assert.deepEqual(applyVolume({}, "099"), { resetVolume: 99 });
    // Boundary rejects: 101, negatives, non-integers, exponent/float/space forms.
    for (const bad of ["101", "999", "-0", "-1", "1.5", "5.", ".5", "1e2", "0x10", " 5", "5 ", "+5", "５", "", null, undefined, NaN, Infinity, 60.5]) {
      assert.throws(() => applyVolume({}, bad), /integer 0-100/, `rejects ${String(bad)}`);
    }
    // QUIRK: "0100" is four digits so the regex rejects it even though it is
    // numerically 100; assert the current behaviour.
    assert.throws(() => applyVolume({}, "0100"), /integer 0-100/);
    // Non-object current collapses.
    assert.deepEqual(applyVolume([1, 2], "50"), { resetVolume: 50 });
    assert.deepEqual(applyVolume("junk", "50"), { resetVolume: 50 });
    const cur = { resetVolume: 10, other: true };
    const out = applyVolume(cur, "20");
    assert.deepEqual(out, { resetVolume: 20, other: true });
    assert.equal(cur.resetVolume, 10, "input object not mutated");
  }

  // ================================================================ applyMaxCopies
  {
    assert.deepEqual(applyMaxCopies({}, 5), { constanceMaxCopies: 5 }, "number input ok");
    assert.deepEqual(applyMaxCopies({}, "05"), { constanceMaxCopies: 5 }, "leading zero ok");
    // QUIRK: "010" is three digits, rejected by the 1-2 digit regex even though
    // it is numerically 10. Assert current behaviour.
    assert.throws(() => applyMaxCopies({}, "010"), /maxCopies must be/);
    for (const bad of ["0", "11", "99", "-1", "1.5", "1e1", " 5", "", null, undefined, NaN]) {
      assert.throws(() => applyMaxCopies({}, bad), /maxCopies must be/, `rejects ${String(bad)}`);
    }
    assert.deepEqual(applyMaxCopies(null, "3"), { constanceMaxCopies: 3 });
    const cur = { constanceMaxCopies: 2, keep: 1 };
    assert.deepEqual(applyMaxCopies(cur, "7"), { constanceMaxCopies: 7, keep: 1 });
    assert.equal(cur.constanceMaxCopies, 2, "input not mutated");
  }

  // ================================================================ applyMilk
  {
    // Unlike volume, out-of-range integers are clamped, not rejected.
    assert.deepEqual(applyMilk({}, "150"), { constanceMilk: 100 });
    assert.deepEqual(applyMilk({}, "250"), { constanceMilk: 100 });
    assert.deepEqual(applyMilk({}, "999"), { constanceMilk: 100 });
    assert.deepEqual(applyMilk({}, "-5"), { constanceMilk: 0 });
    assert.deepEqual(applyMilk({}, "-999"), { constanceMilk: 0 });
    assert.deepEqual(applyMilk({}, "-0"), { constanceMilk: 0 });
    assert.deepEqual(applyMilk({}, "0"), { constanceMilk: 0 });
    assert.deepEqual(applyMilk({}, "100"), { constanceMilk: 100 });
    assert.deepEqual(applyMilk({}, "42"), { constanceMilk: 42 });
    assert.deepEqual(applyMilk({}, 33), { constanceMilk: 33 }, "number input ok");
    assert.deepEqual(applyMilk({}, "007"), { constanceMilk: 7 });
    // Non-integers, floats-as-strings, spaces and junk still throw.
    for (const bad of ["1.5", "5.", ".5", "1e2", "0x10", " 5", "5 ", "+5", "abc", "", "1000", "-1000", null, undefined, NaN, 2.5]) {
      assert.throws(() => applyMilk({}, bad), /constanceMilk must be an integer/, `rejects ${String(bad)}`);
    }
    // QUIRK: "-1000" is five chars incl. sign -> regex \d{1,3} rejects it before
    // clamping could apply; same for "1000". Asserted above.
    assert.deepEqual(applyMilk([9], "10"), { constanceMilk: 10 }, "array current collapses");
    const cur = { constanceMilk: 10, keep: true };
    assert.deepEqual(applyMilk(cur, "20"), { constanceMilk: 20, keep: true });
    assert.equal(cur.constanceMilk, 10, "input not mutated");
  }

  // ================================================================ applyBrain
  {
    for (const good of ["claude", "antigravity", " CLAUDE ", "\tAntiGravity\n", "cLaUdE"]) {
      const want = good.trim().toLowerCase();
      assert.deepEqual(applyBrain({}, good), { constanceBrain: want }, `accepts ${JSON.stringify(good)}`);
    }
    for (const bad of ["grok", "", "  ", "claude,antigravity", "claude ", null, undefined, 0, {}]) {
      // "claude " trims to "claude" -> accepted; skip it here.
      if (bad === "claude ") continue;
      assert.throws(() => applyBrain({}, bad), /constanceBrain must be claude or antigravity/, `rejects ${String(bad)}`);
    }
    assert.deepEqual(applyBrain({}, "claude "), { constanceBrain: "claude" }, "trailing space trims");
    // Non-object base collapses, including arrays.
    assert.deepEqual(applyBrain([1], "claude"), { constanceBrain: "claude" });
    assert.deepEqual(applyBrain("junk", "antigravity"), { constanceBrain: "antigravity" });
    const cur = { constanceBrain: "claude", other: 1 };
    assert.deepEqual(applyBrain(cur, "antigravity"), { constanceBrain: "antigravity", other: 1 });
    assert.equal(cur.constanceBrain, "claude", "input not mutated");
  }

  // ================================================================ applyHidden
  {
    // Ids are case- and whitespace-sensitive.
    assert.throws(() => applyHidden({}, "AMP", "true"), /unknown agent/);
    assert.throws(() => applyHidden({}, " amp", "true"), /unknown agent/);
    assert.throws(() => applyHidden({}, "amp ", "true"), /unknown agent/);
    assert.throws(() => applyHidden({}, "", "true"), /unknown agent/);
    assert.throws(() => applyHidden({}, undefined, "true"), /unknown agent/);
    // Value must be exactly "true"/"false".
    for (const bad of ["TRUE", "1", "yes", "", undefined, null, true]) {
      assert.throws(() => applyHidden({}, "amp", bad), /true or false/, `rejects ${String(bad)}`);
    }
    // hiddenAgents that is not an array (string, object, number, null) -> [].
    for (const weird of ["amp", { 0: "amp" }, 7, null, true]) {
      assert.deepEqual(applyHidden({ hiddenAgents: weird, keep: 1 }, "kiro", "true"), { hiddenAgents: ["kiro"], keep: 1 }, `hiddenAgents=${JSON.stringify(weird)}`);
    }
    // Non-string / unknown junk inside a valid array is filtered out.
    assert.deepEqual(
      applyHidden({ hiddenAgents: ["amp", 7, null, {}, "ghost", "kiro"] }, "codex", "true"),
      { hiddenAgents: ["amp", "kiro", "codex"] },
      "junk entries dropped, known ones kept in order",
    );
    // QUIRK: unhiding keeps duplicate entries of OTHER agents (only the add
    // path dedupes via Set). Assert current behaviour.
    assert.deepEqual(applyHidden({ hiddenAgents: ["amp", "amp", "kiro"] }, "codex", "false"), { hiddenAgents: ["amp", "amp", "kiro"] });
    // The add path dedupes everything, including pre-existing dupes.
    assert.deepEqual(applyHidden({ hiddenAgents: ["amp", "amp"] }, "kiro", "true"), { hiddenAgents: ["amp", "kiro"] });
    // Every core id and every catalog id can be hidden.
    for (const id of [...CORE_IDS, "qwen", "vibe", "dsh", "mcode"]) {
      assert.deepEqual(applyHidden({}, id, "true"), { hiddenAgents: [id] }, id);
    }
    const cur = { hiddenAgents: ["amp"] };
    const out = applyHidden(cur, "kiro", "true");
    assert.deepEqual(cur.hiddenAgents, ["amp"], "stored array not mutated");
    assert.notEqual(out.hiddenAgents, cur.hiddenAgents, "new array returned");
    // Unhide-all then re-hide keeps order stable.
    let s = {};
    for (const id of ["grok", "claude", "amp"]) s = applyHidden(s, id, "true");
    assert.deepEqual(s.hiddenAgents, ["grok", "claude", "amp"]);
    s = applyHidden(s, "claude", "false");
    assert.deepEqual(s.hiddenAgents, ["grok", "amp"]);
  }

  // ================================================================ applyOrder
  {
    // Whitespace around items is trimmed; empty items dropped.
    assert.deepEqual(applyOrder({}, " claude , grok ,, ").tabOrder, ["claude", "grok"]);
    // Catalog ids are valid order entries.
    assert.deepEqual(applyOrder({}, "mcode,claude,qwen").tabOrder, ["mcode", "claude", "qwen"]);
    // "reset" is exact-match only: QUIRK - " reset" or "RESET" is parsed as an
    // id list and rejected, not treated as reset.
    for (const notReset of [" reset", "reset ", "RESET", "Reset", "reset,claude"]) {
      assert.throws(() => applyOrder({}, notReset), /distinct known agent ids/, `rejects ${JSON.stringify(notReset)}`);
    }
    // Duplicates, unknowns, empties.
    for (const bad of ["", "   ", ",", "claude,claude", "claude,grok,claude", "nope", "claude,nope", null, undefined]) {
      assert.throws(() => applyOrder({}, bad), /distinct known agent ids/, `rejects ${String(bad)}`);
    }
    // QUIRK: empty items are filtered before validation, so "claude,,grok"
    // is accepted as ["claude","grok"] rather than rejected (the existing
    // test only rejects the trailing-comma "claude,," because that leaves
    // one real id + empties -> still valid? no: it filters to ["claude"],
    // which is valid too — assert what actually happens).
    assert.deepEqual(applyOrder({}, "claude,,grok").tabOrder, ["claude", "grok"], "empty items dropped, not rejected");
    assert.deepEqual(applyOrder({}, "claude,,").tabOrder, ["claude"], "trailing comma tolerated too");
    // Non-object current collapses.
    assert.deepEqual(applyOrder([1], "claude").tabOrder, ["claude"]);
    assert.deepEqual(applyOrder("junk", "claude").tabOrder, ["claude"]);
    // Other settings survive; input not mutated.
    const cur = { tabOrder: ["grok"], keep: { x: 1 } };
    const out = applyOrder(cur, "claude,amp");
    assert.deepEqual(out, { tabOrder: ["claude", "amp"], keep: { x: 1 } });
    assert.deepEqual(cur.tabOrder, ["grok"], "input not mutated");
    // reset returns the full default order and keeps siblings.
    const r = applyOrder({ keep: 1 }, "reset");
    assert.deepEqual(r.tabOrder, DEFAULT_ORDER);
    assert.equal(r.keep, 1);
    // DEFAULT_ORDER is AGENT_IDS itself: every known id present exactly once.
    assert.equal(DEFAULT_ORDER.length, AGENT_IDS.length);
    assert.deepEqual([...DEFAULT_ORDER].sort(), [...AGENT_IDS].sort());
    // The returned tabOrder from "reset" IS the DEFAULT_ORDER array (same ref);
    // pin the quirk that a caller mutating it would corrupt the export.
    assert.equal(applyOrder({}, "reset").tabOrder, DEFAULT_ORDER, "reset aliases DEFAULT_ORDER (quirk: shared ref)");
  }

  // ================================================================ CLI: corrupt / odd settings.json
  // Each case writes a fresh settings.json then runs one valid command; the
  // read failure must collapse to {} and the write must still succeed.
  {
    const cases = [
      ["empty", ""],
      ["whitespace", "   \n\t  "],
      ["truncated", '{"resetSound": tru'],
      ["badjson", "{not json"],
      ["bom", "﻿{}"],
      ["null", "null"],
      ["number", "42"],
      ["string", '"hello"'],
      ["array", "[1,2,3]"],
      ["bool", "true"],
    ];
    for (const [name, content] of cases) {
      resetState();
      writeSettings(content);
      const res = run("resetSound", "false");
      assert.equal(res.status, 0, `${name}: exit ${res.status} stderr=${res.stderr}`);
      assert.deepEqual(readSettings(), { resetSound: false }, `${name}: corrupt file replaced by fresh object`);
    }
  }

  // ================================================================ CLI: valid-but-weird existing content
  {
    resetState();
    writeSettings(JSON.stringify({ hiddenAgents: "amp", tabOrder: "nope", resetVolume: "loud", nested: { a: 1 } }));
    assert.equal(run("hidden", "kiro", "true").status, 0);
    const s = readSettings();
    assert.deepEqual(s.hiddenAgents, ["kiro"], "non-array hiddenAgents replaced");
    assert.equal(s.tabOrder, "nope", "unrelated keys kept verbatim even if weird");
    assert.equal(s.resetVolume, "loud", "unrelated keys kept verbatim");
    assert.deepEqual(s.nested, { a: 1 });
  }

  // ================================================================ CLI: arg edge cases
  {
    resetState();
    // No args at all -> unknown setting, exit 1, no file written.
    let res = run();
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /unknown setting/);
    assert.equal(fs.existsSync(SETTINGS), false, "failed run writes nothing");
    // Missing value args.
    assert.notEqual(run("hidden", "amp").status, 0, "hidden without value");
    assert.notEqual(run("volume").status, 0, "volume without value");
    assert.notEqual(run("order").status, 0, "order without value");
    assert.notEqual(run("constanceBrain").status, 0, "brain without value");
    // Extra args are ignored (only argv[2..4] are read).
    assert.equal(run("volume", "55", "extra", "args").status, 0);
    assert.equal(readSettings().resetVolume, 55);
    // Unknown subcommand falls through to applySetting.
    assert.notEqual(run("frobnicate", "true").status, 0);
    // Aliases.
    assert.equal(run("milk", "30").status, 0);
    assert.equal(readSettings().constanceMilk, 30);
    assert.equal(run("brain", "claude").status, 0);
    assert.equal(readSettings().constanceBrain, "claude");
    // milk clamps just like the function.
    assert.equal(run("constanceMilk", "500").status, 0);
    assert.equal(readSettings().constanceMilk, 100);
    assert.equal(run("milk", "-20").status, 0);
    assert.equal(readSettings().constanceMilk, 0);
  }

  // ================================================================ CLI: order command end to end
  {
    resetState();
    assert.equal(run("order", "grok,claude").status, 0);
    assert.deepEqual(readSettings().tabOrder, ["grok", "claude"]);
    assert.equal(run("order", "reset").status, 0);
    assert.deepEqual(readSettings().tabOrder, DEFAULT_ORDER);
    assert.notEqual(run("order", "claude,claude").status, 0, "dupes rejected");
    assert.notEqual(run("order", " reset").status, 0, "reset must be exact");
    assert.deepEqual(readSettings().tabOrder, DEFAULT_ORDER, "failed order leaves file untouched");
  }

  // ================================================================ CLI: filesystem edges
  {
    // settings.json that is a DIRECTORY: read fails -> {}, but rename onto a
    // directory fails -> exit 1 and the directory is untouched.
    resetState();
    fs.mkdirSync(SETTINGS, { recursive: true });
    fs.writeFileSync(path.join(SETTINGS, "inner.txt"), "x");
    const res = run("resetSound", "true");
    assert.notEqual(res.status, 0, "rename over a directory must fail");
    assert.ok(fs.statSync(SETTINGS).isDirectory(), "directory not clobbered");
    assert.equal(fs.readFileSync(path.join(SETTINGS, "inner.txt"), "utf8"), "x");

    // A leftover pid-tmp from a crashed run is ignored and overwritten.
    resetState();
    writeSettings(JSON.stringify({ keep: 1 }));
    fs.writeFileSync(`${SETTINGS}.999999.tmp`, "stale");
    assert.equal(run("resetSound", "true").status, 0);
    assert.deepEqual(readSettings(), { keep: 1, resetSound: true });
    // No tmp litter after a successful run: only the stale file we planted.
    assert.deepEqual(fs.readdirSync(path.dirname(SETTINGS)).filter((f) => f.endsWith(".tmp")), ["settings.json.999999.tmp"]);

    // settings.json mode is owner-only.
    const mode = fs.statSync(SETTINGS).mode & 0o777;
    assert.equal(mode & 0o077, 0, `settings.json must not be group/other readable (mode ${mode.toString(8)})`);

    // File ends with a newline (matches the writer's "\n" suffix).
    const raw = fs.readFileSync(SETTINGS, "utf8");
    assert.ok(raw.endsWith("\n"), "trailing newline");
    assert.deepEqual(JSON.parse(raw), { keep: 1, resetSound: true });
  }

  // ================================================================ CLI: env resolution
  {
    // XDG_STATE_HOME unset -> falls back to $HOME/.local/state.
    resetState();
    fs.rmSync(SETTINGS, { force: true });
    const res = spawnSync(process.execPath, [script, "resetSound", "true"], {
      env: cliEnv({ XDG_STATE_HOME: undefined }), encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr);
    const homeFile = path.join(HOME_DIR, ".local", "state", "omarchy", "agent-usage-tabs", "settings.json");
    assert.deepEqual(JSON.parse(fs.readFileSync(homeFile, "utf8")), { resetSound: true });
    assert.equal(fs.existsSync(SETTINGS), false, "XDG path not used when unset");

    // XDG_STATE_HOME empty string -> falsy -> same HOME fallback.
    const res2 = spawnSync(process.execPath, [script, "resetSound", "false"], {
      env: cliEnv({ XDG_STATE_HOME: "" }), encoding: "utf8",
    });
    assert.equal(res2.status, 0, res2.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(homeFile, "utf8")), { resetSound: false });

    // XDG_STATE_HOME pointing at a regular file -> mkdirSync fails -> exit 1.
    const blocker = path.join(tmp, "blocker");
    fs.writeFileSync(blocker, "x");
    const res3 = spawnSync(process.execPath, [script, "resetSound", "true"], {
      env: cliEnv({ XDG_STATE_HOME: blocker }), encoding: "utf8",
    });
    assert.notEqual(res3.status, 0, "unusable state dir must fail cleanly");
    assert.equal(fs.readFileSync(blocker, "utf8"), "x", "blocker file untouched");
  }

  // ================================================================ CLI: sequential consistency
  {
    // Rapid sequential writes accumulate (each run re-reads the file).
    resetState();
    assert.equal(run("hideUninstalledAgents", "false").status, 0);
    assert.equal(run("showUnusedModels", "true").status, 0);
    assert.equal(run("hidden", "amp", "true").status, 0);
    assert.equal(run("volume", "10").status, 0);
    assert.equal(run("constanceMilk", "50").status, 0);
    assert.equal(run("order", "claude,grok").status, 0);
    assert.deepEqual(readSettings(), {
      hideUninstalledAgents: false, showUnusedModels: true,
      hiddenAgents: ["amp"], resetVolume: 10, constanceMilk: 50,
      tabOrder: ["claude", "grok"],
    });
    // And a failing command in the middle changes nothing.
    assert.notEqual(run("volume", "999").status, 0);
    assert.notEqual(run("hidden", "ghost", "true").status, 0);
    assert.deepEqual(readSettings(), {
      hideUninstalledAgents: false, showUnusedModels: true,
      hiddenAgents: ["amp"], resetVolume: 10, constanceMilk: 50,
      tabOrder: ["claude", "grok"],
    });
  }

  // BUG (not fixed, test-only job): the CLI does an unprotected
  // read-modify-write. Two concurrent invocations can both read the same
  // settings.json and the second rename silently drops the first one's key -
  // a lost update with no error. Reproducing it needs both processes to read
  // before either writes, which is timing-dependent, so this stays commented
  // out; run it a few times to see the flake.
  //
  // {
  //   resetState();
  //   const results = await Promise.all([
  //     runAsync(["resetSound", "true"]),
  //     runAsync(["autoOpenOnReset", "true"]),
  //   ]);
  //   assert.ok(results.every((r) => r.code === 0));
  //   assert.deepEqual(readSettings(), { resetSound: true, autoOpenOnReset: true },
  //     "both concurrent writes must survive - currently one is lost");
  // }
  console.log("settings-set.deep: all tests passed");
} finally {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
