import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { historyToCsv } from "./usage-csv.mjs";

// ---- historyToCsv: header, column union, sorting, nulls, percents
const hist = {
  schemaVersion: 1,
  days: {
    "2026-11-20": {
      claude: { tokens: 12345, peaks: { Session: 0.5, "Weekly Limit": 0.9 }, resets: 1 },
      devin: { tokens: null, peaks: { Session: 0.2 }, resets: 0 },
    },
    "2026-11-21": {
      claude: { tokens: 678, peaks: { Session: 0.663 }, resets: 0 },
    },
  },
};
const expected = [
  "date,agent,tokens,resets,peak_session,peak_weekly_limit",
  "2026-11-20,claude,12345,1,50,90",
  "2026-11-20,devin,,0,20,",
  "2026-11-21,claude,678,0,66,",
  "",
].join("\n");
assert.equal(historyToCsv(hist), expected);

// Rows sort by date then agent; an empty history is just the header.
assert.equal(
  historyToCsv({ days: { "2026-01-02": { b: { tokens: 1, peaks: {}, resets: 0 } }, "2026-01-01": { a: { tokens: 2, peaks: {}, resets: 3 } } } }),
  "date,agent,tokens,resets\n2026-01-01,a,2,3\n2026-01-02,b,1,0\n",
);
assert.equal(historyToCsv({}), "date,agent,tokens,resets\n");
assert.equal(historyToCsv(null), "date,agent,tokens,resets\n");

// Non-finite peak fractions are treated as missing, never written.
assert.equal(
  historyToCsv({ days: { "2026-01-01": { a: { tokens: 5, peaks: { Session: NaN, Other: 0.255 }, resets: 0 } } } }),
  "date,agent,tokens,resets,peak_other,peak_session\n2026-01-01,a,5,0,26,\n",
);

// RFC 4180 quoting: comma, quote and newline in a cell are quoted/escaped.
const quoted = historyToCsv({
  days: {
    "2026-01-01": {
      'a,"b"': { tokens: null, peaks: {}, resets: 0 },
      "x\ny": { tokens: 1, peaks: {}, resets: 0 },
    },
  },
});
assert.ok(quoted.includes('"a,""b""",,0'));
assert.ok(quoted.includes('"x\ny",1,0'));

// ---- bin/export-csv.mjs CLI, in a fake HOME + XDG_STATE_HOME (never the real one)
const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "export-csv.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "usage-csv-test-"));
const home = path.join(tmp, "home");
const state = path.join(tmp, "state");
const stateDir = path.join(state, "omarchy", "agent-usage-tabs");
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(path.join(stateDir, "history.json"), JSON.stringify(hist));
// A PATH with no xdg-user-dir in it, so the CLI must fall back to ~/Downloads.
const noXdgBin = path.join(tmp, "no-xdg-bin");
fs.mkdirSync(noXdgBin);
const env = (e = {}) => ({ PATH: "/usr/bin:/bin", HOME: home, XDG_STATE_HOME: state, ...e });
const today = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
})();

// --out <path>: writes exactly there, mode 0600, prints the path.
{
  const out = path.join(tmp, "out", "usage.csv");
  const r = spawnSync(process.execPath, [cli, "--out", out], { encoding: "utf8", env: env() });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), out);
  assert.equal(fs.readFileSync(out, "utf8"), expected);
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
}

// No --out and no xdg-user-dir on PATH: ~/Downloads/cook-meter-usage-<today>.csv.
{
  const r = spawnSync(process.execPath, [cli], { encoding: "utf8", env: env({ PATH: noXdgBin }) });
  assert.equal(r.status, 0, r.stderr);
  const want = path.join(home, "Downloads", `cook-meter-usage-${today}.csv`);
  assert.equal(r.stdout.trim(), want);
  assert.equal(fs.readFileSync(want, "utf8"), expected);
}

// No XDG_STATE_HOME: history comes from ~/.local/state under the fake HOME.
{
  const home2 = path.join(tmp, "home2");
  const dir2 = path.join(home2, ".local", "state", "omarchy", "agent-usage-tabs");
  fs.mkdirSync(dir2, { recursive: true });
  fs.writeFileSync(path.join(dir2, "history.json"), JSON.stringify(hist));
  const r = spawnSync(process.execPath, [cli, "--out", path.join(tmp, "out2.csv")], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", HOME: home2 },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(tmp, "out2.csv"), "utf8"), expected);
}

// Missing history: exit 1, one line on stderr, nothing written.
{
  const out = path.join(tmp, "never.csv");
  const r = spawnSync(process.execPath, [cli, "--out", out], {
    encoding: "utf8",
    env: env({ XDG_STATE_HOME: path.join(tmp, "empty-state") }),
  });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr.trim().split("\n").length, 1);
  assert.ok(!fs.existsSync(out));
}

console.log("usage-csv.test.mjs: ok");
