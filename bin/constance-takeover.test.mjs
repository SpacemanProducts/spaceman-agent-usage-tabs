// "Give it to Opus" helpers (constance-takeover.mjs): who may take over, when Opus is blocked by
// Claude's own limits, the slider rule, the partial diff, the log tail and the takeover prompt.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { OPUS, opusCommand, autoTakeoverOn, AUTO_FROM, takeoverProblem, opusBlocked, lastLines, partialDiff, readTail, takeoverPrompt, LOG_LINES } from "./constance-takeover.mjs";
import { PROFILES, sandboxProblem, sandboxArgs } from "./constance-sandbox.mjs";
import { judge } from "./constance-agents.mjs";

// Opus runs as the real Claude Code CLI, headless, model opus, prompt as one argument.
assert.deepEqual(opusCommand("do it; rm -rf x"), ["claude", "-p", "--model", "opus", "--dangerously-skip-permissions", "do it; rm -rf x"]);
assert.equal(OPUS.worker, "Opus");
// It has its own sandbox profile, and is still never picked as a free worker.
assert.ok(PROFILES.claude, "claude has a sandbox profile");
assert.equal(sandboxProblem("claude"), "");
assert.equal(judge({ id: "claude", installed: true, signedIn: true, limits: [{ title: "Session", percent: 0.1 }] }).available, false, "Claude is never a free worker");
{
  // The profile binds ~/.claude writable and ~/.claude.json only when it is a file that exists.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "constance-takeover-home-"));
  const proj = path.join(home, "proj"); fs.mkdirSync(proj);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "constance-takeover-tmp-"));
  let a = sandboxArgs({ agent: "claude", dir: proj, tmp, env: { HOME: home } });
  const binds = (a) => a.flatMap((x, i) => (x === "--bind" ? [a[i + 1]] : []));
  assert.ok(binds(a).includes(path.join(home, ".claude")));
  assert.ok(!binds(a).includes(path.join(home, ".claude.json")), "no settings file: not bound (and not created)");
  assert.ok(!fs.existsSync(path.join(home, ".claude.json")));
  fs.writeFileSync(path.join(home, ".claude.json"), "{}");
  a = sandboxArgs({ agent: "claude", dir: proj, tmp, env: { HOME: home } });
  assert.ok(binds(a).includes(path.join(home, ".claude.json")));
  assert.ok(a.some((x, i) => x === "--tmpfs" && a[i + 1] === home), "home is still an empty tmpfs");
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(tmp, { recursive: true, force: true });
}

// The Milk Opus slider: off at max delegation, on toward the Opus end.
assert.equal(autoTakeoverOn(0), false);
assert.equal(autoTakeoverOn(25), false, "the default (25) is off");
assert.equal(autoTakeoverOn(50), false);
assert.equal(AUTO_FROM, 51);
assert.equal(autoTakeoverOn(51), true);
assert.equal(autoTakeoverOn(100), true);
assert.equal(autoTakeoverOn("nope"), false);

// Who can be taken over.
assert.equal(takeoverProblem({ id: 3, status: "running", agent: "devin" }), "");
assert.match(takeoverProblem(null), /no such job/);
assert.match(takeoverProblem({ id: 3, status: "finished", agent: "devin" }), /finished, not running/);
assert.match(takeoverProblem({ id: 3, status: "running", agent: "claude", handedFrom: { agent: "devin" } }), /already Opus's/);

// Claude's own limits gate it: the click at her stop line (90%), the automatic handoff at the lean line (70%).
const claude = (pct, extra = {}) => ({ id: "claude", limits: [{ title: "Session", percent: pct, ...extra }, { title: "Weekly", percent: 0.1 }] });
assert.equal(opusBlocked(claude(0.5)), "");
assert.equal(opusBlocked(claude(0.8)), "");
assert.match(opusBlocked(claude(0.9)), /Session is at 90%/);
assert.match(opusBlocked(claude(0.5, { hitAt: "x" })), /Session/);
assert.match(opusBlocked(claude(0.75), { auto: true }), /75%/);
assert.equal(opusBlocked(claude(0.6), { auto: true }), "");
assert.match(opusBlocked(null), /can't be read/);
assert.match(opusBlocked({ limits: [{ title: "Session", percent: null }] }), /can't be read/);

// lastLines: the last 50 lines, capped.
{
  const text = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join("\n") + "\n\n";
  const t = lastLines(text);
  assert.equal(t.split("\n").length, LOG_LINES);
  assert.equal(t.split("\n")[0], "line 71"); assert.equal(t.split("\n").at(-1), "line 120");
  assert.ok(lastLines("x".repeat(20000)).length <= 8001);
  assert.equal(lastLines(""), "");
  assert.equal(lastLines("a\r\nb"), "a\nb");
}

// partialDiff: committed and uncommitted changes since the pre-run HEAD, plus new files, never .constance/.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "constance-takeover-"));
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n"); git("add", "a.txt"); git("commit", "-qm", "init");
  const base = git("rev-parse", "HEAD").trim();
  assert.deepEqual(partialDiff(dir, base), { diff: "", untracked: [] });
  fs.writeFileSync(path.join(dir, "b.txt"), "b1\n"); git("add", "b.txt"); git("commit", "-qm", "worker: b");
  fs.appendFileSync(path.join(dir, "a.txt"), "half done\n");
  fs.writeFileSync(path.join(dir, "new.txt"), "n\n");
  fs.mkdirSync(path.join(dir, ".constance")); fs.writeFileSync(path.join(dir, ".constance/done-1.json"), "{}");
  const d = partialDiff(dir, base);
  assert.match(d.diff, /\+b1/, "its commit");
  assert.match(d.diff, /\+half done/, "its uncommitted edit");
  assert.deepEqual(d.untracked, ["new.txt"]);
  assert.match(d.diff, /--- new file new\.txt ---\nn\n/, "a new file's text is included");
  fs.writeFileSync(path.join(dir, "bin.dat"), Buffer.from([1, 0, 2]));
  assert.doesNotMatch(partialDiff(dir, base).diff, /bin\.dat/, "binary new files stay names only");
  assert.ok(partialDiff(dir, base).untracked.includes("bin.dat"));
  fs.rmSync(path.join(dir, "bin.dat"));
  assert.doesNotMatch(d.diff, /done-1/);
  const cut = partialDiff(dir, base, 20);
  assert.match(cut.diff, /diff cut at 20 characters/);
  assert.deepEqual(partialDiff(path.join(dir, "nope"), base), { diff: "", untracked: [] }, "unreadable: empty, no crash");
  // readTail
  fs.writeFileSync(path.join(dir, "log"), "0123456789");
  assert.equal(readTail(path.join(dir, "log"), 4), "6789");
  assert.equal(readTail(path.join(dir, "missing")), "");
  fs.rmSync(dir, { recursive: true, force: true });
}

// The prompt: the original prompt first (task, rules, done file), then what the worker left.
{
  const p = takeoverPrompt({ prompt: "ORIGINAL PROMPT\nwrite the file /tmp/.constance/done-4.json", from: "Devin 2", reason: "it looked stuck", diff: "+half", untracked: ["n.txt"], logTail: "last words" });
  assert.ok(p.startsWith("ORIGINAL PROMPT"));
  assert.match(p, /done-4\.json/);
  assert.match(p, /Taking over: Devin 2 started this job and was stopped \(it looked stuck\)\. You are Opus/);
  assert.match(p, /stay inside the same file list/);
  assert.match(p, /git diff against where the job started\):\n\+half/);
  assert.match(p, /New files it created: n\.txt/);
  assert.match(p, /The last 50 lines of its log:\nlast words$/);
  const empty = takeoverPrompt({ prompt: "P", from: "Grok" });
  assert.match(empty, /\(no tracked changes\)/); assert.match(empty, /\(its log is empty\)/);
}
console.log("constance-takeover: ok");
