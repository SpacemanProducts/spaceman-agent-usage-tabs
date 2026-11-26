// Constance's sandbox, for real (needs bwrap): a "worker" that tries to delete
// and move files outside its project can't — hidden files (Documents, ~/.ssh,
// other projects, other agents' logins) aren't there, and read-only ones (the
// toolchain, the rest of the system) refuse. It can write its project, its own
// config folder and /tmp; it can't plant git hooks, reach the session bus or
// see the ssh-agent. Stop's group kill ends a sandboxed job. Agents that can't
// be sandboxed are refused. Uses a fake home under the system temp folder (TMPDIR), never the real one.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { sandboxArgs, sandboxEnv, sandboxLaunch, sandboxProblem, bwrapWorks, PROFILES } from "./constance-sandbox.mjs";
import { judge, LAUNCH } from "./constance-agents.mjs";

// Every launchable worker has a profile; keyring agents are refused unless the owner allows them.
for (const id of Object.keys(LAUNCH)) assert.ok(PROFILES[id], `${id} has a sandbox profile`);
assert.match(sandboxProblem("nobody"), /no sandbox profile/);
assert.equal(sandboxProblem("grok"), "");
for (const id of ["copilot", "cursor", "antigravity"]) {
  assert.match(sandboxProblem(id), /keyring/, `${id} needs the owner's keyring opt-in`);
}
// freebuff and kilo use file logins (no keyring) and get exactly their own dirs.
assert.deepEqual(PROFILES.freebuff.rw, [".config/manicode", ".freebuff"]);
assert.deepEqual(PROFILES.kilo.rw, [".config/kilo", ".local/share/kilo", ".cache/kilo"]);
for (const id of ["freebuff", "kilo"]) {
  assert.ok(!PROFILES[id].keyring, `${id} must not be a keyring agent`);
  assert.equal(sandboxProblem(id), "", `${id} should sandbox cleanly`);
}
// judge() never offers an agent the sandbox refuses.
const a = { id: "grok", installed: true, signedIn: true, limits: [{ title: "Daily", percent: 0.1 }] };
assert.equal(judge(a).available, true);
const j = judge(a, { sandbox: () => "bwrap missing" });
assert.equal(j.available, false); assert.match(j.reason, /can't run sandboxed: bwrap missing/);

if (!bwrapWorks()) { console.log("constance-sandbox: bwrap can't run here — escape tests skipped (and no agent would launch)"); process.exit(0); }

const base = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "constance-box-"));
const home = path.join(base, "home"), proj = path.join(home, "Projects", "app"), other = path.join(home, "Projects", "other");
const tmp = path.join(base, "jobtmp"); fs.mkdirSync(tmp);
const put = (p, t = "keep\n") => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); };
put(path.join(home, "Documents", "taxes.txt"));
put(path.join(home, ".ssh", "id_ed25519"));
put(path.join(home, ".config", "omarchy", "shell.json"));
put(path.join(home, ".codex", "auth.json"));            // another agent's login
put(path.join(home, ".claude.json"));
put(path.join(other, "src.txt"));
put(path.join(home, ".local", "bin", "tool"));          // toolchain: visible, read-only
put(path.join(base, "outside", "victim.txt"));          // outside home, outside the project
put(path.join(home, ".grok", "auth.json"), "{}\n");     // grok's own login folder
fs.mkdirSync(proj, { recursive: true });
execFileSync("git", ["-C", proj, "init", "-q"]);
const env = { ...process.env, HOME: home, SSH_AUTH_SOCK: "/run/user/1000/ssh-agent.sock" };

// The "agent": a shell that tries everything and reports, one line per attempt.
// rm -rf succeeds on a path it can't see (when the temp folder is /tmp, the sandbox's own /tmp
// hides it), so that attempt only counts as "ok" if the victim was visible and is really gone.
const attempts = `
try() { if eval "$2" 2>/dev/null; then echo "$1=ok"; else echo "$1=blocked"; fi; }
try rm-docs "rm -f '${home}/Documents/taxes.txt' && [ ! -e '${home}/Documents/taxes.txt' ] && ls '${home}/Documents' >/dev/null"
try see-docs "[ -e '${home}/Documents/taxes.txt' ]"
try see-ssh "[ -e '${home}/.ssh/id_ed25519' ]"
try see-config "[ -e '${home}/.config/omarchy/shell.json' ]"
try see-codex "[ -e '${home}/.codex/auth.json' ]"
try see-claude "[ -e '${home}/.claude.json' ]"
try see-other-project "[ -e '${other}/src.txt' ]"
try rm-tool "rm '${home}/.local/bin/tool'"
try mv-tool "mv '${home}/.local/bin/tool' '${proj}/stolen'"
try rm-outside "rm '${base}/outside/victim.txt'"
try mv-outside "mv '${base}/outside/victim.txt' '${proj}/moved.txt'"
try rmrf-outside "[ -e '${base}/outside/victim.txt' ] && rm -rf '${base}/outside' && [ ! -e '${base}/outside' ]"
try write-project "echo hi > '${proj}/hello.txt'"
try write-own-config "echo x > '${home}/.grok/note'"
try write-tmp "echo x > /tmp/scratch"
try write-hook "echo 'touch /pwned' > '${proj}/.git/hooks/post-commit'"
try write-gitconfig "echo '[core]' >> '${proj}/.git/config'"
try see-bus "[ -e /run/user/$(id -u)/bus ]"
try ssh-env "[ -n \\"$SSH_AUTH_SOCK\\" ]"
`;
const [cmd, ...args] = ["bwrap", ...sandboxArgs({ agent: "grok", dir: proj, tmp, env }), "--", "sh", "-c", attempts];
const r = spawnSync(cmd, args, { env: sandboxEnv(env, "grok"), encoding: "utf8", timeout: 30e3 });
assert.equal(r.status, 0, r.stderr);
const res = Object.fromEntries(r.stdout.trim().split("\n").map((l) => l.split("=")));
const blocked = ["see-docs", "see-ssh", "see-config", "see-codex", "see-claude", "see-other-project",
  "rm-tool", "mv-tool", "rm-outside", "mv-outside", "rmrf-outside", "write-hook", "write-gitconfig", "see-bus", "ssh-env"];
for (const k of blocked) assert.equal(res[k], "blocked", `${k} must be blocked: ${r.stdout}`);
for (const k of ["write-project", "write-own-config", "write-tmp"]) assert.equal(res[k], "ok", `${k} must work: ${r.stdout}`);

// Nothing outside the project changed on the host.
for (const f of [path.join(home, "Documents", "taxes.txt"), path.join(home, ".ssh", "id_ed25519"), path.join(other, "src.txt"),
  path.join(home, ".local", "bin", "tool"), path.join(base, "outside", "victim.txt"), path.join(home, ".config", "omarchy", "shell.json")]) {
  assert.equal(fs.readFileSync(f, "utf8"), "keep\n", `${f} untouched`);
}
// (mv off a read-only folder copies, then fails to delete: the original above is
// intact, so nothing was moved — at most the agent made a copy of a file it can read.)
assert.ok(!fs.existsSync(path.join(proj, ".git", "hooks", "post-commit")), "no hook planted");
assert.equal(fs.readFileSync(path.join(proj, "hello.txt"), "utf8"), "hi\n", "project writes land");
assert.equal(fs.readFileSync(path.join(home, ".grok", "note"), "utf8"), "x\n", "own config writes land");
assert.equal(fs.readFileSync(path.join(tmp, "scratch"), "utf8"), "x\n", "/tmp is the job's own temp folder");

// The home folder itself, or a folder above it, is never a sandbox project.
assert.throws(() => sandboxArgs({ agent: "grok", dir: home, tmp, env }), /home folder/);
assert.throws(() => sandboxArgs({ agent: "grok", dir: base, tmp, env }), /home folder/);
// A refused agent never gets a launch.
const busDirs = () => fs.readdirSync(process.env.XDG_RUNTIME_DIR || os.tmpdir()).filter((n) => n.startsWith("constance-bus-")).length;
const busBefore = busDirs();
assert.throws(() => sandboxLaunch(["copilot", "-p", "x"], { agent: "copilot", dir: proj, tmp, env }), /keyring/);
assert.equal(busDirs(), busBefore, "a refused launch leaves nothing behind");

// Stop's group kill (the job is its own process group) ends the sandboxed process too.
{
  const box = sandboxLaunch(["sh", "-c", "sleep 60"], { agent: "grok", dir: proj, tmp, env });
  const c = spawn(box.cmd[0], box.cmd.slice(1), { env: box.env, detached: true, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 700));
  const inner = () => spawnSync("pgrep", ["-g", String(c.pid), "-x", "sleep"], { encoding: "utf8" }).stdout.trim();
  assert.ok(inner(), "the sandboxed sleep is running in the job's group");
  process.kill(-c.pid, "SIGTERM");
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(inner(), "", "the group kill ended it");
}

// When the CLI exits, whatever it left running inside (a daemon, even one that
// left the process group) dies with the sandbox, and the job's exit code comes through.
{
  // A random fractional duration marks this run's sleep so a parallel suite's
  // own `sleep` can't be mistaken for a survivor (pgrep -f is global).
  const dur = `77.${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`;
  const box = sandboxLaunch(["sh", "-c", `setsid sleep ${dur} >/dev/null 2>&1 & sleep 0.3; exit 3`], { agent: "grok", dir: proj, tmp, env });
  const c = spawn(box.cmd[0], box.cmd.slice(1), { env: box.env, detached: true, stdio: "ignore" });
  const code = await new Promise((r) => c.on("exit", r));
  assert.equal(code, 3, "the agent's exit code is the job's");
  await new Promise((r) => setTimeout(r, 700));
  const pat = `^sleep ${dur.replace(".", "[.]")}$`;
  assert.equal(spawnSync("pgrep", ["-f", pat], { encoding: "utf8" }).stdout.trim(), "", "nothing it started outlives the job");
}
// The job survives its short-lived launcher (delegate exits right after spawning it).
{
  const box = sandboxLaunch(["sh", "-c", `sleep 1.5; echo done > '${proj}/late.txt'`], { agent: "grok", dir: proj, tmp, env });
  const launcher = spawnSync("node", ["-e", `const c=require("child_process").spawn(process.argv[1], JSON.parse(process.argv[2]), { detached: true, stdio: "ignore" }); c.unref();`, box.cmd[0], JSON.stringify(box.cmd.slice(1))], { env: box.env });
  assert.equal(launcher.status, 0);
  await new Promise((r) => setTimeout(r, 3000));
  assert.equal(fs.readFileSync(path.join(proj, "late.txt"), "utf8"), "done\n", "the job ran to the end after its launcher exited");
}

// A linked worktree: .git is a pointer file into the main repo. The sandbox must
// keep that pointer read-only, bind the shared git dir for objects/refs, expose
// only THIS worktree's gitdir writable, and keep the main repo's hooks/config
// read-only — exactly like a normal repo's .git.
{
  const wt = path.join(base, "wt");
  execFileSync("git", ["-C", proj, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", proj, "config", "user.name", "t"]);
  fs.writeFileSync(path.join(proj, "seed.txt"), "seed\n");
  execFileSync("git", ["-C", proj, "add", "seed.txt"]);
  execFileSync("git", ["-C", proj, "commit", "-qm", "seed"]);
  execFileSync("git", ["-C", proj, "worktree", "add", "-b", "wt-test", wt, "HEAD"], { encoding: "utf8" });
  const wargs = sandboxArgs({ agent: "grok", dir: wt, tmp, env }).join(" ");
  const common = path.join(proj, ".git");
  const wtGit = fs.readdirSync(path.join(common, "worktrees"))[0];
  const wtGitDir = path.join(common, "worktrees", wtGit);
  for (const frag of [
    `--ro-bind ${wt}/.git ${wt}/.git`,
    `--bind ${common} ${common}`,
    `--ro-bind ${common}/hooks ${common}/hooks`,
    `--ro-bind ${common}/config ${common}/config`,
    `--ro-bind ${path.join(common, "worktrees")} ${path.join(common, "worktrees")}`,
    `--bind ${wtGitDir} ${wtGitDir}`,
  ]) assert.ok(wargs.includes(frag), `worktree sandbox args contain ${frag}: ${wargs}`);
  execFileSync("git", ["-C", proj, "worktree", "remove", "--force", wt]);
  execFileSync("git", ["-C", proj, "branch", "-D", "wt-test"]);
}

// freebuff and kilo, for real: a fake headless CLI of each on PATH, run inside
// the sandbox. Each can write the worktree and its own config/login dirs, and
// gets a write error anywhere else (here: the read-only toolchain bind).
{
  const fakebin = path.join(tmp, "fakebin"); fs.mkdirSync(fakebin);
  const cases = [
    ["freebuff", [".config/manicode", ".freebuff"]],
    ["kilo", [".config/kilo", ".local/share/kilo", ".cache/kilo"]],
  ];
  for (const [id, dirs] of cases) {
    const script = ["#!/bin/sh",
      'try() { if eval "$2" 2>/dev/null; then echo "$1=ok"; else echo "$1=blocked"; fi; }',
      `try worktree "echo hi > '${proj}/${id}.txt'"`,
      ...dirs.map((d, i) => `try cfg${i} "echo x > '${path.join(home, d)}/probe-${i}'"`),
      `try outside "echo x >> '${path.join(home, ".local", "bin", "tool")}'"`,
    ].join("\n") + "\n";
    fs.writeFileSync(path.join(fakebin, id), script, { mode: 0o755 });
    const penv = { ...env, PATH: `/tmp/fakebin:${env.PATH}` };
    const r2 = spawnSync("bwrap", [...sandboxArgs({ agent: id, dir: proj, tmp, env: penv }), "--", id, "--help"],
      { env: sandboxEnv(penv, id), encoding: "utf8", timeout: 30e3 });
    assert.equal(r2.status, 0, `${id}: ${r2.stderr}`);
    const got = Object.fromEntries(r2.stdout.trim().split("\n").map((l) => l.split("=")));
    assert.equal(got.worktree, "ok", `${id} worktree write: ${r2.stdout}`);
    dirs.forEach((d, i) => {
      assert.equal(got[`cfg${i}`], "ok", `${id} write to ${d}: ${r2.stdout}`);
      assert.equal(fs.readFileSync(path.join(home, d, `probe-${i}`), "utf8"), "x\n", `${id} ${d} landed on host`);
    });
    assert.equal(got.outside, "blocked", `${id} write outside its dirs: ${r2.stdout}`);
    assert.equal(fs.readFileSync(path.join(proj, `${id}.txt`), "utf8"), "hi\n");
  }
}

fs.rmSync(base, { recursive: true, force: true });
console.log("constance-sandbox: tests passed");
