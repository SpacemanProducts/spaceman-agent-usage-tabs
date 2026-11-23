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

// several agents: ONE window; the driver gets the folder and every agent
// Any terminal launcher call here would be an extra window: this one records its calls so the test can prove there are none.
const launchLog = path.join(tmp, "launch.log");
fs.writeFileSync(path.join(bin, "omarchy-launch-tui"), `#!/bin/bash\necho "$*" >> "${launchLog}"\n`, { mode: 0o755 });
const stub = path.join(tmp, "driver.py");
fs.writeFileSync(stub, "import sys\nprint('driver', *sys.argv[1:])\n");
fs.rmSync(path.join(home, ".local/state"), { recursive: true, force: true });
r = spawnSync("bash", [script, "codex", "grok", "amp"], { encoding: "utf8", input: "\n", env: { PATH: "/usr/bin:/bin", HOME: home, ...gitEnv, SQUAD_DIR: repo, SQUAD_DRIVER: stub } });
assert.match(r.stdout, new RegExp(`driver ${real(repo)} codex grok amp\\n$`), "one driver run with the folder and all agents");
assert.match(r.stdout, /Claude Squad: codex,grok,amp in repo/);
assert.ok(!fs.existsSync(path.join(home, ".claude-squad")), "cs's own config is never touched");
await new Promise((res) => setTimeout(res, 800));
assert.ok(!fs.existsSync(launchLog), "no extra terminal windows were opened: " + (fs.existsSync(launchLog) ? fs.readFileSync(launchLog, "utf8") : ""));
// ---- what the panel's Claude Squad view uses: --repos lists recent repos (last used first, no backups), SQUAD_NEW makes a project
{
  const projR = path.join(tmp, "proj-panel");            // its own Projects folder, so earlier test repos do not show up
  fs.rmSync(path.join(home, ".local/state"), { recursive: true, force: true });
  const P = { SQUAD_PROJECTS: projR };
  for (const n of ["alpha", "beta", "alpha-backup", "gamma-2026-11-21"]) { fs.mkdirSync(path.join(projR, n), { recursive: true }); spawnSync("git", ["init", "-q", path.join(projR, n)]); }
  fs.mkdirSync(path.join(home, ".local/state/omarchy/agent-usage-tabs"), { recursive: true });
  fs.writeFileSync(path.join(home, ".local/state/omarchy/agent-usage-tabs/squad-dir"), path.join(projR, "beta") + "\n");
  const listed = run(["--repos"], P).stdout.trim().split("\n");
  assert.equal(listed[0], path.join(projR, "beta"), "the last repo used comes first");
  assert.deepEqual(listed.slice().sort(), [path.join(projR, "alpha"), path.join(projR, "beta")], "recent repos only: no backups or date-stamped copies");
  // a repo outside Projects under a dot-folder (this plugin lives in ~/.config), once opened, is listed; backups in Projects still are not
  const dotRepo = path.join(home, ".config", "omarchy", "plugins", "my.plugin"); fs.mkdirSync(dotRepo, { recursive: true }); spawnSync("git", ["init", "-q", dotRepo]);
  fs.writeFileSync(path.join(home, ".local/state/omarchy/agent-usage-tabs/squad-recent"), dotRepo + "\n" + path.join(projR, "alpha-backup") + "\n");
  const listed2 = run(["--repos"], P).stdout.trim().split("\n");
  assert.ok(listed2.includes(dotRepo), "a repo picked with Browse, under a dot-folder, is listed: " + listed2.join(","));
  assert.ok(!listed2.includes(path.join(projR, "alpha-backup")), "backups inside Projects stay hidden even if remembered");
  const made2 = run(["codex"], { ...P, SQUAD_NEW: "panel-made", GUM_CHOOSE: "x" });
  assert.ok(made2.stdout.trim().endsWith(`cs -p codex in ${real(path.join(projR, "panel-made"))}`), made2.stdout);
  assert.ok(spawnSync("git", ["-C", path.join(projR, "panel-made"), "log", "--oneline"], { encoding: "utf8" }).stdout.includes("Initial commit"), "a first commit, so Squad can branch");
  const bad = run(["codex"], { ...P, SQUAD_NEW: "../escape" });
  assert.notEqual(bad.status, 0); assert.ok(!fs.existsSync(path.join(home, "escape")));
  fs.rmSync(path.join(home, ".local/state"), { recursive: true, force: true });
}

// a plain folder chosen in the panel (SQUAD_DIR, not a repo yet): asks, then git-inits it with a first commit
{
  const plain2 = path.join(tmp, "plain-from-panel"); fs.mkdirSync(plain2);
  const declined = run(["codex"], { SQUAD_DIR: plain2, GUM_CONFIRM: "no" });
  assert.equal(declined.status, 130); assert.ok(!fs.existsSync(path.join(plain2, ".git")), "declined: left alone");
  const okd = run(["codex"], { SQUAD_DIR: plain2, GUM_CONFIRM: "yes" });
  assert.ok(okd.stdout.trim().endsWith(`cs -p codex in ${real(plain2)}`), okd.stdout);
  assert.ok(spawnSync("git", ["-C", plain2, "log", "--oneline"], { encoding: "utf8" }).stdout.includes("Initial commit"));
  fs.rmSync(path.join(home, ".local/state"), { recursive: true, force: true });
}

// ---- one Claude Squad window at a time: while another window holds the lock, a launch refuses and says so
{
  const driver = path.join(path.dirname(script), "squad-drive.py");
  const env2 = { ...process.env, HOME: home, XDG_STATE_HOME: "" };
  const { spawn } = await import("node:child_process");
  const holder = spawn("python3", [driver, "--hold", "6"], { env: env2, stdio: "ignore" });
  await new Promise((res) => setTimeout(res, 800));
  const t1 = Date.now();
  const second = spawnSync("bash", [script, "claude"], { encoding: "utf8", input: "\n", env: { PATH: "/usr/bin:/bin", HOME: home, ...gitEnv, SQUAD_DIR: repo, SQUAD_DRIVER: "/nonexistent" } });
  assert.notEqual(second.status, 0, "a second launch does not go ahead");
  assert.match(second.stdout, /already open in another window/);
  assert.ok(!/Claude Squad: claude in/.test(second.stdout), "it never got as far as running cs");
  assert.ok(Date.now() - t1 < 5000, "it refused at once, without waiting");
  // the driver itself refuses too (the race where two launches pass the early check together)
  const drv = spawnSync("python3", [driver, repo, "bash"], { encoding: "utf8", env: env2, timeout: 10000 });
  assert.equal(drv.status, 3); assert.match(drv.stdout, /already open in another window/);
  await new Promise((res) => holder.on("exit", res));       // the holder ends: the lock is released with it
  const after = run(["codex"], { SQUAD_DIR: repo });
  assert.equal(after.status, 0, after.stderr); assert.match(after.stdout, /cs -p codex in /, "launches normally again once the other window is closed");
  // a crashed holder cannot leave it stuck: kill one hard and launch right away
  const crashed = spawn("python3", [driver, "--hold", "60"], { env: env2, stdio: "ignore" });
  await new Promise((res) => setTimeout(res, 800)); crashed.kill("SIGKILL"); await new Promise((res) => crashed.on("exit", res));
  assert.equal(run(["codex"], { SQUAD_DIR: repo }).status, 0, "a killed window leaves no stale lock");
}
fs.rmSync(tmp, { recursive: true });
console.log("squad: all tests passed");
