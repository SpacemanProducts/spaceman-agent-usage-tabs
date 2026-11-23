import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// The header terminal button: bin/agent-here.sh starts the default agent in the folder picked in the panel.
const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "agent-here.sh"), squad = path.join(here, "squad.sh");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-here-test-"));
const home = path.join(tmp, "home"), bin = path.join(home, ".local/bin"), proj = path.join(tmp, "proj");
fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(proj);
// A stand-in for omarchy-agent that says how it was started and where.
fs.writeFileSync(path.join(bin, "omarchy-agent"), '#!/bin/bash\necho "agent $* in $PWD"\n', { mode: 0o755 });
const gitEnv = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const env = (e) => ({ PATH: "/usr/bin:/bin", HOME: home, SQUAD_PROJECTS: proj, ...gitEnv, ...e });
const run = (e = {}) => spawnSync("bash", [script], { encoding: "utf8", input: "\n", env: env(e) });
const repos = () => spawnSync("bash", [squad, "--repos"], { encoding: "utf8", env: env({}) }).stdout.trim().split("\n").filter(Boolean);
const real = (p) => fs.realpathSync(p);
for (const n of ["alpha", "beta"]) { fs.mkdirSync(path.join(proj, n)); spawnSync("git", ["init", "-q", path.join(proj, n)]); }

// A repo picked in the panel: the agent starts inline (this terminal is its window) in that folder, and it becomes the last one used
let r = run({ AGENT_DIR: path.join(proj, "alpha") });
assert.equal(r.status, 0, r.stderr);
assert.equal(r.stdout.trim(), `agent --inline --pick in ${real(path.join(proj, "alpha"))}`);
assert.equal(repos()[0], path.join(proj, "alpha"), "the CS picker's list puts it first too (shared last-used folder)");
r = run({ AGENT_DIR: path.join(proj, "beta") });
assert.equal(repos()[0], path.join(proj, "beta"), "the most recent pick comes first");

// Create a new project: made in ~/Projects with a first commit, then the agent starts there
r = run({ AGENT_NEW: "fresh" });
assert.equal(r.stdout.trim(), `agent --inline --pick in ${real(path.join(proj, "fresh"))}`, r.stdout + r.stderr);
assert.ok(spawnSync("git", ["-C", path.join(proj, "fresh"), "log", "--oneline"], { encoding: "utf8" }).stdout.includes("Initial commit"));
assert.equal(repos()[0], path.join(proj, "fresh"));
// a name that isn't a plain folder name is refused, and nothing starts
r = run({ AGENT_NEW: "../escape" });
assert.notEqual(r.status, 0); assert.ok(!fs.existsSync(path.join(tmp, "escape"))); assert.ok(!r.stdout.includes("agent --inline"));

// Browse to a plain folder: the agent starts there, no git init, and it doesn't replace the last repo
const plain = path.join(tmp, "plain"); fs.mkdirSync(plain);
r = run({ AGENT_DIR: plain });
assert.equal(r.stdout.trim(), `agent --inline --pick in ${real(plain)}`);
assert.ok(!fs.existsSync(path.join(plain, ".git")), "a plain folder is left as it is");
assert.equal(repos()[0], path.join(proj, "fresh"), "the last repo is kept");

// The Start picker's "No project" option starts in home without changing the last repo
r = run({ AGENT_DIR: home });
assert.equal(r.stdout.trim(), `agent --inline --pick in ${real(home)}`);
assert.equal(repos()[0], path.join(proj, "fresh"), "home is not added to the recent repo list");

// a folder that doesn't exist: says so, starts nothing
r = run({ AGENT_DIR: path.join(tmp, "gone") });
assert.notEqual(r.status, 0); assert.match(r.stdout, /No such folder/);
// the panel adds a Browse pick to the list, selected, so the pick is visible
const qml = fs.readFileSync(new URL("../Panel.qml", import.meta.url), "utf8");
assert.match(qml, /squadRepos\.indexOf\(p\) < 0\) root\.squadRepos = \[p\]\.concat\(root\.squadRepos\)/, "a folder picked with Browse joins the list");
assert.match(qml, /visible: !fp\.forSquad[\s\S]*?text: \(homeChip\.on \? "\\u2713 " : ""\) \+ "No project"[\s\S]*?root\.squadRepo = root\.home/, "the Start picker offers home without changing Squad's folder choices");
assert.match(qml, /agentHereReady: squadRepo !== "" \|\| squadNewName !== "" \|\| agentHereOpen/, "Start is ready with no folder selected");
assert.match(qml, /"AGENT_DIR=" \+ \(squadRepo !== "" \? squadRepo : root\.home\)/, "no folder selection starts in home");
assert.match(qml, /squadRepos\.indexOf\(squadRepo\) >= 0 \|\| folderPickerByFolder\[squadRepo\]/, "a folder picked with Browse stays selected while the grouped list catches up");
const picks = fs.readFileSync(path.join(home, ".local/state/omarchy/agent-usage-tabs/start-picks"), "utf8").trim().split("\n");
assert.ok(picks.includes(plain), "a folder started from the picker is remembered even without git");
assert.ok(!picks.includes(home), "the home-folder entry is not remembered as a pick");
fs.rmSync(tmp, { recursive: true });
console.log("agent-here: all tests passed");
