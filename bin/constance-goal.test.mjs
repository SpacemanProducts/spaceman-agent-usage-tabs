// A long pasted goal (20 lines) reaches Constance whole: `start --goal` keeps every line and her
// first message (the fake claude's last argument) carries all of it. Scratch state, fake HOME and
// fake claude/busctl on PATH, so nothing real is read or touched.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const CLI = new URL("./constance.mjs", import.meta.url).pathname;
const root = fs.mkdtempSync(path.join(fs.existsSync("/var/tmp") ? "/var/tmp" : os.tmpdir(), "constance-goal-"));
const state = path.join(root, "state"), bin = path.join(root, "bin"), home = path.join(root, "home"), repo = path.join(home, "Projects", "repo");
const tabs = path.join(state, "omarchy/agent-usage-tabs");
for (const d of [tabs, bin, repo]) fs.mkdirSync(d, { recursive: true });
execFileSync("git", ["-C", repo, "init", "-q"]);
const soon = (h) => new Date(Date.now() + h * 3600e3).toISOString();
fs.writeFileSync(path.join(tabs, "data.json"), JSON.stringify({ generatedAt: Date.now(), agents: [
  { id: "claude", installed: true, signedIn: true, limits: [{ title: "Session", percent: 0.1, resetsAt: soon(4) }, { title: "Weekly", percent: 0.1, resetsAt: soon(150) }] }] }));
const got = path.join(root, "prompt.txt");
fs.writeFileSync(path.join(bin, "claude"), `#!/bin/bash\nprintf '%s' "\${@: -1}" > "${got}"\necho done\n`, { mode: 0o755 });
fs.writeFileSync(path.join(bin, "busctl"), "#!/bin/bash\nsleep 30\n", { mode: 0o755 });
const env = { ...process.env, HOME: home, SQUAD_PROJECTS: path.join(home, "Projects"), XDG_STATE_HOME: state, PATH: `${bin}:${process.env.PATH}` };
const run = (...a) => spawnSync("node", [CLI, ...a], { env, encoding: "utf8" });

const lines = Array.from({ length: 20 }, (_, i) => `${i + 1}. step ${i + 1}: do thing number ${i + 1}, with "quotes", $dollars and 'ticks'`);
const goal = lines.join("\n");
const r = run("start", "--dir", repo, "--goal", goal);
assert.equal(r.status, 0, r.stderr);
assert.equal(JSON.parse(run("status").stdout).goal.text, goal, "the stored goal is the whole 20 lines");
const end = Date.now() + 15000;
while (!fs.existsSync(got) && Date.now() < end) await new Promise((res) => setTimeout(res, 100));
const prompt = fs.readFileSync(got, "utf8");
assert.ok(prompt.includes(goal), "her first message carries the whole goal");
for (const l of lines) assert.ok(prompt.includes(l), "line kept: " + l);
run("stop");
fs.rmSync(root, { recursive: true, force: true });
console.log("constance-goal: ok");
