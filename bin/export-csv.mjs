#!/usr/bin/env node
// export-csv.mjs — write the shared usage history to a CSV file.
// Reads <stateDir>/history.json where stateDir is
// $XDG_STATE_HOME/omarchy/agent-usage-tabs (default ~/.local/state/...).
// --out <path> picks the destination; otherwise the file lands in
// `xdg-user-dir DOWNLOAD` (fallback ~/Downloads) as
// cook-meter-usage-YYYY-MM-DD.csv, mode 0600. Prints the path on stdout;
// exits 1 with a one-line stderr message when there is no history.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { historyToCsv } from "./usage-csv.mjs";

const fail = (msg) => { process.stderr.write(`${msg}\n`); process.exit(1); };

const args = process.argv.slice(2);
let out = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out" && i + 1 < args.length) out = args[++i];
  else fail("usage: export-csv.mjs [--out <path>]");
}

const stateDir = path.join(
  process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state"),
  "omarchy", "agent-usage-tabs",
);
const histPath = path.join(stateDir, "history.json");
if (!fs.existsSync(histPath)) fail(`no usage history at ${histPath}`);

let history;
try {
  history = JSON.parse(fs.readFileSync(histPath, "utf8"));
} catch (e) {
  fail(`could not read ${histPath}: ${e.message}`);
}

let dest = out;
if (!dest) {
  let dir = "";
  const r = spawnSync("xdg-user-dir", ["DOWNLOAD"], { encoding: "utf8" });
  if (r.status === 0) dir = (r.stdout || "").trim();
  if (!dir) dir = path.join(os.homedir(), "Downloads");
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  dest = path.join(dir, `cook-meter-usage-${stamp}.csv`);
}

fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, historyToCsv(history), { mode: 0o600 });
fs.chmodSync(dest, 0o600);
process.stdout.write(`${dest}\n`);
