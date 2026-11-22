import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "squad.sh");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "squad-test-"));
const home = path.join(tmp, "home"), bin = path.join(home, ".local/bin"), repo = path.join(tmp, "repo");
fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(path.join(home, "Work"), { recursive: true }); fs.mkdirSync(repo);
spawnSync("git", ["init", "-q", repo]);
// A stand-in for gum, driven by env vars, so the prompts can be tested without a terminal.
fs.writeFileSync(path.join(bin, "gum"), `#!/bin/bash
case "$1" in
  choose) echo "$@" > "\${GUM_LOG:-/dev/null}.args"; cat >/dev/null; echo "$GUM_CHOOSE" ;;
  input) echo "$GUM_INPUT" ;;
  file) echo "$GUM_FILE" ;;
  confirm) [[ \${GUM_CONFIRM:-yes} == yes ]] ;;
esac
`, { mode: 0o755 });
const gitEnv = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const run = (args = ["codex"], env = {}) => spawnSync("bash", [script, ...args], { encoding: "utf8", input: "\n", env: { PATH: "/usr/bin:/bin", HOME: home, ...gitEnv, SQUAD_DRIVER: "/nonexistent", ...env } });
const real = (p) => fs.realpathSync(p);

// cs missing and the install declined: stops without running anything
let r = run(["codex"], { GUM_CONFIRM: "no" });
assert.equal(r.status, 130);
assert.match(r.stdout, /Squad needs Claude Squad/);
// the one-click install mode shows the command it runs
fs.writeFileSync(path.join(bin, "curl"), "#!/bin/bash\necho '#!/bin/bash' ; echo 'printf \"#!/bin/bash\\necho cs-installed\\n\" > \"$HOME/.local/bin/cs\"; chmod +x \"$HOME/.local/bin/cs\"'\n", { mode: 0o755 });
r = run(["--install"]);
assert.match(r.stdout, /install\.sh/, "shows the install command");
assert.ok(fs.existsSync(path.join(bin, "cs")), "installed cs");

// cs present, repo given: runs `cs -p <agent>` inside it
fs.writeFileSync(path.join(bin, "cs"), '#!/bin/bash\necho "cs $* in $PWD"\n', { mode: 0o755 });
r = run(["codex"], { SQUAD_DIR: repo });
assert.match(r.stdout, /Claude Squad: codex in repo\n/, "says which repo it is about to open");
assert.ok(r.stdout.includes("\u001b]0;repo\u0007"), "the terminal title is the repo name");
assert.match(r.stdout, new RegExp(`cs -p codex in ${real(repo)}\\n$`));
// The picker now ALWAYS shows, with the last repo preselected (Enter = reuse it). SQUAD_DIR is only a script override.
const g0 = path.join(tmp, "gum0.log");
r = run(["codex"], { SQUAD_DIR: "", GUM_CHOOSE: repo, GUM_LOG: g0 });
assert.ok(fs.readFileSync(g0 + ".args", "utf8").includes(`--selected ${repo}`), "the last repo is preselected: " + fs.readFileSync(g0 + ".args", "utf8"));
assert.match(r.stdout, new RegExp(`in ${real(repo)}\\n$`), "choosing the preselected repo reuses it");
fs.rmSync(path.join(home, ".local/state"), { recursive: true });

// no remembered repo: a picker starts in Projects and lists only git repos, hiding backups and desktop files
const proj = path.join(home, "Projects");
const mk = (name, git = true) => { const d = path.join(proj, name); fs.mkdirSync(d, { recursive: true }); if (git) spawnSync("git", ["init", "-q", d]); };
mk("my-app"); mk("nested/tool"); mk("plain-folder", false);
for (const hidden of ["my-app-backup", "old.bak-20261121", "thing-2026-11-21", "app-before-merge", "app-prepublish", ".hidden", "Liftoff.desktop"]) mk(hidden);
fs.writeFileSync(path.join(bin, "gum"), `#!/bin/bash
case "$1" in
  choose) echo "$@" > "\${GUM_LOG}.args"; cat > "$GUM_LOG"; echo "$GUM_CHOOSE" ;;
  input) echo "$GUM_INPUT" ;;
  file) echo "$GUM_FILE" ;;
  confirm) [[ \${GUM_CONFIRM:-yes} == yes ]] ;;
esac
`, { mode: 0o755 });
const log = path.join(tmp, "gum.log");
fs.rmSync(path.join(home, ".local/state"), { recursive: true, force: true });
r = run(["claude"], { GUM_CHOOSE: "my-app", GUM_LOG: log });
const offered = fs.readFileSync(log, "utf8").trim().split("\n").sort();
assert.deepEqual(offered, ["+ Create a new project", "Browse...", "my-app", "nested/tool"].sort(), "recent repos, Create, Browse: nothing else");
const lines = fs.readFileSync(log, "utf8").trim().split("\n"); assert.deepEqual(lines.slice(-2), ["+ Create a new project", "Browse..."], "the two actions come after the repos");
assert.ok(r.stdout.trim().endsWith(`cs -p claude in ${real(path.join(proj, "my-app"))}`), r.stdout);
// Browse: pick a plain folder anywhere -> git init, and it shows up as a recent repo next time
const elsewhere = path.join(tmp, "elsewhere"); fs.mkdirSync(elsewhere);
fs.rmSync(path.join(home, ".local/state/omarchy/agent-usage-tabs/squad-dir"));
r = run(["claude"], { GUM_CHOOSE: "Browse...", GUM_FILE: elsewhere, GUM_LOG: log });
assert.ok(r.stdout.trim().endsWith(`cs -p claude in ${real(elsewhere)}`), r.stdout);
assert.ok(fs.existsSync(path.join(elsewhere, ".git")), "browsed folder was git-initialized");
fs.rmSync(path.join(home, ".local/state/omarchy/agent-usage-tabs/squad-dir"));
run(["claude"], { GUM_CHOOSE: "my-app", GUM_LOG: log });
assert.ok(fs.readFileSync(log, "utf8").includes(elsewhere.replace(os.homedir(), "~")) || fs.readFileSync(log, "utf8").includes(elsewhere), "a browsed repo is listed as recent");
// create a new project: lands in Projects, git-initialized with a first commit
fs.rmSync(path.join(home, ".local/state"), { recursive: true });
r = run(["claude"], { GUM_CHOOSE: "+ Create a new project", GUM_INPUT: "squad-demo", GUM_LOG: log });
const made = path.join(proj, "squad-demo");
assert.ok(r.stdout.trim().endsWith(`cs -p claude in ${real(made)}`), r.stdout);
assert.ok(spawnSync("git", ["-C", made, "log", "--oneline"], { encoding: "utf8" }).stdout.includes("Initial commit"), "has a first commit");
// a name that isn't a plain folder name is refused
fs.rmSync(path.join(home, ".local/state"), { recursive: true });
r = run(["claude"], { GUM_CHOOSE: "+ Create a new project", GUM_INPUT: "../escape", GUM_LOG: log });
assert.notEqual(r.status, 0); assert.ok(!fs.existsSync(path.join(home, "escape")));

// several agents: ONE window; the driver gets the folder and every agent, and the profiles are written as the fallback
// Any terminal launcher call here would be an extra window: this one records its calls so the test can prove there are none.
const launchLog = path.join(tmp, "launch.log");
fs.writeFileSync(path.join(bin, "omarchy-launch-tui"), `#!/bin/bash\necho "$*" >> "${launchLog}"\n`, { mode: 0o755 });
const stub = path.join(tmp, "driver.py");
fs.writeFileSync(stub, "import sys\nprint('driver', *sys.argv[1:])\n");
fs.rmSync(path.join(home, ".local/state"), { recursive: true, force: true });
r = spawnSync("bash", [script, "codex", "grok", "amp"], { encoding: "utf8", input: "\n", env: { PATH: "/usr/bin:/bin", HOME: home, ...gitEnv, SQUAD_DIR: repo, SQUAD_DRIVER: stub } });
assert.match(r.stdout, new RegExp(`driver ${real(repo)} codex grok amp\\n$`), "one driver run with the folder and all agents");
assert.match(r.stdout, /Claude Squad: codex,grok,amp in repo/);
const prof = JSON.parse(fs.readFileSync(path.join(home, ".claude-squad/config.json"), "utf8")).profiles;
assert.deepEqual(prof.map((p) => p.program), ["codex", "grok", "amp"], "profiles written as the fallback");
await new Promise((res) => setTimeout(res, 800));
assert.ok(!fs.existsSync(launchLog), "no extra terminal windows were opened: " + (fs.existsSync(launchLog) ? fs.readFileSync(launchLog, "utf8") : ""));
fs.rmSync(tmp, { recursive: true });
console.log("squad: all tests passed");
