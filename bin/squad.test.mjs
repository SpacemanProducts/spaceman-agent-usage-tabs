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
  choose) echo "$GUM_CHOOSE" ;;
  input) echo "$GUM_INPUT" ;;
  file) echo "$GUM_FILE" ;;
  confirm) [[ \${GUM_CONFIRM:-yes} == yes ]] ;;
esac
`, { mode: 0o755 });
const gitEnv = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const run = (args = ["codex"], env = {}) => spawnSync("bash", [script, ...args], { encoding: "utf8", input: "\n", env: { PATH: "/usr/bin:/bin", HOME: home, ...gitEnv, ...env } });
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
assert.equal(r.stdout.trim(), `cs -p codex in ${real(repo)}`);
r = run();
assert.match(r.stdout, new RegExp(`in ${real(repo)}\\n$`), "remembers the last repo");
fs.rmSync(path.join(home, ".local/state"), { recursive: true });

// no repo anywhere: create a new project, git-initialized with a first commit
r = run(["claude"], { GUM_CHOOSE: "Create a new project", GUM_INPUT: "squad-demo" });
const made = path.join(home, "Work/squad-demo");
assert.equal(r.stdout.trim(), `cs -p claude in ${real(made)}`);
assert.ok(spawnSync("git", ["-C", made, "log", "--oneline"], { encoding: "utf8" }).stdout.includes("Initial commit"), "has a first commit");
fs.rmSync(path.join(home, ".local/state"), { recursive: true }); fs.rmSync(made, { recursive: true });

// no repo: pick a plain folder -> git init it
const plain = path.join(tmp, "plain"); fs.mkdirSync(plain);
r = run(["claude"], { GUM_CHOOSE: "Pick a folder", GUM_FILE: plain });
assert.equal(r.stdout.trim(), `cs -p claude in ${real(plain)}`);
assert.ok(fs.existsSync(path.join(plain, ".git")), "folder was git-initialized");
// ...and a name that isn't a plain folder name is refused
fs.rmSync(path.join(home, ".local/state"), { recursive: true });
r = run(["claude"], { GUM_CHOOSE: "Create a new project", GUM_INPUT: "../escape" });
assert.notEqual(r.status, 0); assert.ok(!fs.existsSync(path.join(home, "escape")));
// several agents: the first runs here, each other gets its own terminal in the same folder
fs.writeFileSync(path.join(bin, "omarchy-launch-tui"), '#!/bin/bash\necho "terminal: $* (SQUAD_DIR=$SQUAD_DIR)"\n', { mode: 0o755 });
fs.rmSync(path.join(home, ".local/state"), { recursive: true, force: true });
r = run(["codex", "grok", "amp"], { SQUAD_DIR: repo });
assert.match(r.stdout, /terminal: bash .*squad\.sh grok \(SQUAD_DIR=.*repo\)/);
assert.match(r.stdout, /terminal: bash .*squad\.sh amp /);
assert.match(r.stdout, /cs -p codex in /, "the first agent runs in this terminal");
fs.rmSync(tmp, { recursive: true });
console.log("squad: all tests passed");
