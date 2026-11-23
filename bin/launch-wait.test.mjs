import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "launch-wait-"));
const bin = path.join(tmp, "bin"); fs.mkdirSync(bin);
// a stand-in hyprctl whose window list is a file: "N" lines of windows with the app-id
fs.writeFileSync(path.join(bin, "hyprctl"), `#!/bin/bash\nn=$(cat "${tmp}/n"); printf '['; for ((i=0;i<n;i++)); do ((i)) && printf ','; printf '{"class": "org.omarchy.agent"}'; done; printf ']\\n'\n`, { mode: 0o755 });
const run = (cmd, secs = 3) => spawnSync("bash", [path.join(here, "launch-wait.sh"), "org.omarchy.agent", String(secs), "bash", "-c", cmd], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, timeout: 20000 });
const set = (n) => fs.writeFileSync(path.join(tmp, "n"), String(n));

set(0);
let r = run(`echo 1 > "${tmp}/n"; sleep 5`);                                  // the launcher maps a window and keeps running
assert.equal(r.status, 0, "a window appeared: success; " + r.stderr);
set(1);
r = run(`echo 2 > "${tmp}/n"`);                                                // an extra window (one was already open) and the launcher exits
assert.equal(r.status, 0, "counts NEW windows only: " + r.stderr);
set(1);
r = run(`echo "uwsm-app: no session" >&2; exit 3`);                            // the launcher dies and nothing opens
assert.equal(r.status, 1); assert.match(r.stderr, /The terminal didn't open \(launcher exit 3\)\. uwsm-app: no session/, r.stderr);
set(1);
r = run(`exit 0`);                                                             // exits 0 but no new window: still a failure, never silent
assert.equal(r.status, 1); assert.match(r.stderr, /didn't open/);
set(0);
r = run(`sleep 10`, 1);                                                        // hangs with no window
assert.equal(r.status, 1); assert.match(r.stderr, /didn't open within 1s/);

// the panel runs Start through this script and shows what it says
const qml = fs.readFileSync(path.join(here, "..", "Panel.qml"), "utf8");
assert.match(qml, /launch-wait\.sh", "org\.omarchy\.agent"/, "Start goes through launch-wait.sh");
assert.match(qml, /root\.agentHereError = String\(agentLauncherErr\.text\)/, "a failed start shows its error in the panel");
assert.match(qml, /if \(code === 0\) root\.close\(\)/, "the panel closes only after the window appeared");
assert.match(qml, /launch-wait\.sh", "org\.omarchy\.squad"/, "Run goes through launch-wait.sh too");
assert.match(qml, /root\.squadError = String\(squadLauncherErr\.text\)/, "a failed Run shows its error in the panel");
fs.rmSync(tmp, { recursive: true, force: true });
console.log("launch-wait: all tests passed");
