// Deep edge-case pass for bin/export-csv.mjs on top of usage-csv.test.mjs
// (which already covers the happy paths: --out, ~/Downloads fallback, missing
// history). export-csv.mjs is a CLI with no exports, so every check spawns it
// with HOME, XDG_STATE_HOME, XDG_CONFIG_HOME and XDG_CACHE_HOME pointed at a
// fresh mkdtemp dir — the real home folder is never touched.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "export-csv.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "export-csv-deep-"));
const home = path.join(tmp, "home");
const state = path.join(tmp, "state");
const stateDir = path.join(state, "omarchy", "agent-usage-tabs");
const xdgConfig = path.join(tmp, "xdg-config");
const xdgCache = path.join(tmp, "xdg-cache");
for (const d of [home, stateDir, xdgConfig, xdgCache]) fs.mkdirSync(d, { recursive: true });
const histPath = path.join(stateDir, "history.json");

const baseEnv = {
  PATH: "/usr/bin:/bin",
  HOME: home,
  XDG_STATE_HOME: state,
  XDG_CONFIG_HOME: xdgConfig,
  XDG_CACHE_HOME: xdgCache,
};
const run = (args = [], env = {}) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...baseEnv, ...env }, cwd: tmp });
const runAsync = (args = [], env = {}) =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, [cli, ...args], { env: { ...baseEnv, ...env }, cwd: tmp });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
const writeHist = (content) => fs.writeFileSync(histPath, content);
const headerOnly = "date,agent,tokens,resets\n";
const USAGE = "usage: export-csv.mjs [--out <path>]";

try {
  // ---- argument parsing ----
  for (const args of [["--bogus"], ["positional"], ["--out"], ["--out", "a", "--bogus"], ["--out=a.csv"], ["-o", "x"]]) {
    const r = run(args);
    assert.equal(r.status, 1, `args ${JSON.stringify(args)} should exit 1`);
    assert.equal(r.stderr.trim(), USAGE, `args ${JSON.stringify(args)} stderr`);
    assert.equal(r.stdout, "");
  }
  // --out repeated: the last one wins, earlier paths are never created.
  {
    writeHist(JSON.stringify({ days: {} }));
    const a = path.join(tmp, "first.csv"), b = path.join(tmp, "second.csv");
    const r = run(["--out", a, "--out", b]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), b);
    assert.ok(fs.existsSync(b) && !fs.existsSync(a));
  }
  // A value that looks like a flag is still taken verbatim as the path
  // (there is no --out= form and no flag rejection after --out).
  {
    const r = run(["--out", "--weird.csv"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "--weird.csv");
    assert.ok(fs.existsSync(path.join(tmp, "--weird.csv")));
  }

  // ---- history.json: corrupt / unreadable inputs ----
  for (const bad of ["not json", "", "   \n\t  ", '{"days":{}} trailing', "﻿{}", "{\"days\":"]) {
    writeHist(bad);
    const out = path.join(tmp, `bad-${Math.random().toString(36).slice(2)}.csv`);
    const r = run(["--out", out]);
    assert.equal(r.status, 1, `history ${JSON.stringify(bad).slice(0, 30)} should exit 1`);
    assert.equal(r.stdout, "");
    assert.ok(r.stderr.startsWith(`could not read ${histPath}:`), `stderr: ${r.stderr}`);
    assert.ok(!fs.existsSync(out));
  }
  // history.json that is a directory: existsSync passes, readFileSync throws.
  fs.rmSync(histPath, { force: true });
  fs.mkdirSync(histPath);
  {
    const out = path.join(tmp, "dir-hist.csv");
    const r = run(["--out", out]);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.startsWith(`could not read ${histPath}:`), r.stderr);
    assert.ok(!fs.existsSync(out));
  }
  fs.rmSync(histPath, { recursive: true, force: true });
  // A dangling symlink fails existsSync -> "no usage history", not "could not read".
  fs.symlinkSync(path.join(tmp, "missing-target.json"), histPath);
  {
    const r = run(["--out", path.join(tmp, "sym.csv")]);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.startsWith(`no usage history at ${histPath}`), r.stderr);
  }
  // A symlink to a real file is followed and exported.
  const real = path.join(tmp, "real-history.json");
  fs.writeFileSync(real, JSON.stringify({ days: { "2026-01-01": { a: { tokens: 7, peaks: {}, resets: 2 } } } }));
  fs.rmSync(histPath, { force: true });
  fs.symlinkSync(real, histPath);
  {
    const out = path.join(tmp, "sym-ok.csv");
    const r = run(["--out", out]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(out, "utf8"), `${headerOnly}2026-01-01,a,7,2\n`);
  }
  fs.rmSync(histPath, { force: true });
  // Unreadable file (chmod 000) -> "could not read". Skipped when root.
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    writeHist("{}");
    fs.chmodSync(histPath, 0);
    const r = run(["--out", path.join(tmp, "noperm.csv")]);
    fs.chmodSync(histPath, 0o644);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.startsWith(`could not read ${histPath}:`), r.stderr);
  }

  // ---- history.json: valid JSON with wrong types never crashes the export ----
  const histCases = [
    ["null", null, headerOnly],
    ["number", 42, headerOnly],
    ["string", "hello", headerOnly],
    ["bool", true, headerOnly],
    ["empty-array", [], headerOnly],
    ["days-null", { days: null }, headerOnly],
    ["days-number", { days: 5 }, headerOnly],
    ["days-empty", { days: {} }, headerOnly],
    ["extra-keys", { schemaVersion: 1, days: {}, unrelated: { deep: [1] } }, headerOnly],
    ["agent-null", { days: { "2026-01-01": null } }, headerOnly],
    ["agent-entry-null", { days: { "2026-01-01": { a: null } } }, `${headerOnly}2026-01-01,a,,\n`],
    ["agent-entry-number", { days: { "2026-01-01": { a: 5 } } }, `${headerOnly}2026-01-01,a,,\n`],
    ["days-array", { days: [{ a: { tokens: 1, peaks: {}, resets: 0 } }] }, `${headerOnly}0,a,1,0\n`],
    ["string-fields", { days: { "2026-01-01": { a: { tokens: "lots", resets: "3", peaks: { S: "high", T: 0.5 } } } } },
      "date,agent,tokens,resets,peak_s,peak_t\n2026-01-01,a,lots,,,50\n"],
    ["peak-collision", { days: { "2026-01-01": { a: { tokens: 1, peaks: { "A-B": 0.1, "A_B": 0.9 }, resets: 0 } } } },
      "date,agent,tokens,resets,peak_a_b\n2026-01-01,a,1,0,10\n"],
    ["unicode-title", { days: { "2026-01-01": { a: { tokens: 1, peaks: { "Sessión!": 1 }, resets: -2 } } } },
      "date,agent,tokens,resets,peak_sessi_n_\n2026-01-01,a,1,-2,100\n"],
  ];
  for (const [name, hist, want] of histCases) {
    writeHist(JSON.stringify(hist));
    const out = path.join(tmp, `shape-${name}.csv`);
    const r = run(["--out", out]);
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.equal(fs.readFileSync(out, "utf8"), want, name);
    assert.equal(fs.statSync(out).mode & 0o777, 0o600, `${name} mode`);
  }

  // ---- --out filesystem edges ----
  writeHist(JSON.stringify({ days: {} }));
  // Missing parent dirs are created recursively.
  {
    const out = path.join(tmp, "deep", "nested", "dir", "x.csv");
    const r = run(["--out", out]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(out));
  }
  // A regular file blocking a path component -> mkdirSync throws, non-zero exit.
  {
    const blocker = path.join(tmp, "blocker");
    fs.writeFileSync(blocker, "x");
    const r = run(["--out", path.join(blocker, "sub", "x.csv")]);
    assert.notEqual(r.status, 0, "expected failure when a parent is a file");
    const dirOut = path.join(tmp, "out-is-dir");
    fs.mkdirSync(dirOut);
    const r2 = run(["--out", dirOut]); // --out naming an existing directory
    assert.notEqual(r2.status, 0, "expected failure when --out is a directory");
  }
  // Overwriting an existing loose-mode file still lands 0600 with fresh content.
  {
    const out = path.join(tmp, "overwrite.csv");
    fs.writeFileSync(out, "junk", { mode: 0o644 });
    fs.chmodSync(out, 0o644);
    const r = run(["--out", out]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(out, "utf8"), headerOnly);
    assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  }
  // No tilde expansion: "~/x.csv" is a literal directory named ~ under cwd.
  {
    const r = run(["--out", "~/tilde.csv"]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(tmp, "~", "tilde.csv")));
  }
  // XDG_STATE_HOME set but empty falls back to ~/.local/state under fake HOME.
  {
    const home3 = path.join(tmp, "home3");
    const dir3 = path.join(home3, ".local", "state", "omarchy", "agent-usage-tabs");
    fs.mkdirSync(dir3, { recursive: true });
    fs.writeFileSync(path.join(dir3, "history.json"), JSON.stringify({ days: {} }));
    const r = run(["--out", path.join(tmp, "empty-xdg.csv")], { HOME: home3, XDG_STATE_HOME: "" });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(tmp, "empty-xdg.csv")));
  }

  // ---- default destination: xdg-user-dir handling ----
  // PATH without xdg-user-dir -> ~/Downloads (covered by usage-csv.test.mjs;
  // here we check the script's stdout/stderr contract and the filename shape).
  const noXdgBin = path.join(tmp, "no-xdg-bin");
  fs.mkdirSync(noXdgBin);
  {
    const r = run([], { PATH: noXdgBin });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout.trim(), /cook-meter-usage-\d{4}-\d{2}-\d{2}\.csv$/);
    assert.ok(fs.existsSync(r.stdout.trim()));
    assert.equal(fs.readFileSync(r.stdout.trim(), "utf8"), headerOnly);
  }
  // A fake xdg-user-dir that exits non-zero -> fallback to ~/Downloads.
  {
    const bin = path.join(tmp, "fake-bin-fail");
    fs.mkdirSync(bin);
    const script = path.join(bin, "xdg-user-dir");
    fs.writeFileSync(script, "#!/bin/sh\nexit 3\n");
    fs.chmodSync(script, 0o755);
    const r = run([], { PATH: `${bin}:${noXdgBin}` });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(path.dirname(r.stdout.trim()), path.join(home, "Downloads"));
  }
  // A fake xdg-user-dir printing an empty/whitespace path -> fallback.
  {
    const bin = path.join(tmp, "fake-bin-empty");
    fs.mkdirSync(bin);
    const script = path.join(bin, "xdg-user-dir");
    fs.writeFileSync(script, "#!/bin/sh\necho '   '\n");
    fs.chmodSync(script, 0o755);
    const r = run([], { PATH: `${bin}:${noXdgBin}` });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(path.dirname(r.stdout.trim()), path.join(home, "Downloads"));
  }
  // A fake xdg-user-dir returning a custom dir (with messy whitespace) is used,
  // and its directories are created if missing.
  {
    const bin = path.join(tmp, "fake-bin-ok");
    const dl = path.join(tmp, "custom downloads");
    fs.mkdirSync(bin);
    const script = path.join(bin, "xdg-user-dir");
    fs.writeFileSync(script, `#!/bin/sh\nprintf '  ${dl}\\n\\n'\n`);
    fs.chmodSync(script, 0o755);
    const r = run([], { PATH: `${bin}:${noXdgBin}` });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(path.dirname(r.stdout.trim()), dl);
    assert.ok(fs.existsSync(r.stdout.trim()));
  }
  // The date stamp is the child's LOCAL date: under TZ=Pacific/Kiritimati the
  // filename must match the date node computes in that same zone, not UTC.
  {
    const stamp = spawnSync(process.execPath, ["-e",
      "const d=new Date();console.log(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`)"],
      { encoding: "utf8", env: { ...baseEnv, PATH: noXdgBin, TZ: "Pacific/Kiritimati" } }).stdout.trim();
    const r = run([], { PATH: noXdgBin, TZ: "Pacific/Kiritimati" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), path.join(home, "Downloads", `cook-meter-usage-${stamp}.csv`));
    assert.ok(fs.existsSync(r.stdout.trim()));
  }

  // ---- concurrency: parallel exports to the same destination ----
  writeHist(JSON.stringify({ days: { "2026-01-01": { a: { tokens: 9, peaks: {}, resets: 1 } } } }));
  const shared = path.join(tmp, "shared.csv");
  const wantShared = `${headerOnly}2026-01-01,a,9,1\n`;
  {
    const results = await Promise.all(Array.from({ length: 6 }, () => runAsync(["--out", shared])));
    for (const r of results) assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(shared, "utf8"), wantShared);
    assert.equal(fs.statSync(shared).mode & 0o777, 0o600);
  }
  // Parallel default-destination runs race on the same dated filename.
  {
    const results = await Promise.all(Array.from({ length: 4 }, () => runAsync([], { PATH: noXdgBin })));
    for (const r of results) assert.equal(r.status, 0, r.stderr);
    const names = new Set(results.map((r) => r.stdout.trim()));
    assert.equal(names.size, 1, "same local date -> same filename");
    assert.equal(fs.readFileSync([...names][0], "utf8"), wantShared);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log("export-csv.deep.test.mjs: ok");
