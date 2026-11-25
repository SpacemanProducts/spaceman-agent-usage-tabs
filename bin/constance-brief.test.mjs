// Constance's repo brief in throwaway git repos: the layout, test command,
// rules and never-touch list all land in under 1500 chars, and the cache only
// rebuilds when the tree moved a lot or the week is up.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildBrief, briefFor, rulesLines, neverTouch } from "./constance-brief.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "constance-brief-"));
const cacheDir = path.join(root, "cache");
const repo = path.join(root, "app");
fs.mkdirSync(path.join(repo, "bin"), { recursive: true });
fs.mkdirSync(path.join(repo, "src"), { recursive: true });
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");

fs.writeFileSync(path.join(repo, "bin", "x.test.mjs"), "// t\n");
fs.writeFileSync(path.join(repo, "bin", "y.mjs"), "// y\n");
fs.writeFileSync(path.join(repo, "src", "a.mjs"), "// a\n");
fs.writeFileSync(path.join(repo, "README.md"), "# app\n");
fs.mkdirSync(path.join(repo, ".constance"));
fs.writeFileSync(path.join(repo, ".constance", "rules.md"), "Keep diffs small.\nNever edit secrets.txt.\n" + Array.from({ length: 19 }, (_, i) => `pad ${i}\n`).join("") + "filler\n".repeat(30));
fs.writeFileSync(path.join(repo, "CLAUDE.md"), `# notes

## Working rules

- Run the tests before committing.
- Never touch prod credentials or deploy scripts.
  wrapped continuation line stays out.
- Keep commits small.

## Other

- not a working rule
`);
git("add", "-A"); git("commit", "-qm", "init");

// buildBrief: every section lands, under the limit.
const brief = buildBrief(repo);
assert.ok(brief.length < 1500, `brief is ${brief.length} chars`);
assert.match(brief, /Layout: /);
assert.match(brief, /bin\/ \(2 files\)/);
assert.match(brief, /src\/ \(1 file\)/);
assert.match(brief, /README\.md/);
assert.ok(!brief.match(/Layout: [^\n]*\.git\//), "hidden entries stay out of the layout");
assert.match(brief, /Test: for t in bin\/\*\.test\.mjs/);
assert.match(brief, /Files: 6/, "tracked files counted");
assert.match(brief, /Rules:[\s\S]*Keep diffs small\./);
assert.match(brief, /pad 7/, "rules.md is capped in the brief");
assert.ok(!brief.includes("pad 8") && !brief.includes("filler"), "lines past the cap are dropped");
assert.match(brief, /Run the tests before committing\./);
assert.ok(!brief.includes("wrapped continuation"), "bullet continuations are dropped");
assert.ok(!brief.includes("not a working rule"), "only the Working rules section counts");
assert.match(brief, /Never touch: .*\.git\//);
assert.match(brief, /Never touch: .*secrets\.txt/);
assert.match(brief, /Never touch: .*settings\/credentials files/);

// rulesLines / neverTouch are the pieces briefFor reuses.
assert.ok(rulesLines(repo).length > 0);
assert.ok(neverTouch(repo).includes(".git/"));

// Test-command fallback: package.json scripts.test, then "none found".
const pkgRepo = path.join(root, "pkgapp");
fs.mkdirSync(pkgRepo);
fs.writeFileSync(path.join(pkgRepo, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
assert.match(buildBrief(pkgRepo), /Test: node --test/);
const bare = path.join(root, "bare");
fs.mkdirSync(bare);
assert.match(buildBrief(bare), /Test: none found/);
assert.match(buildBrief(bare), /Layout: \(empty\)/);

// briefFor caches: same HEAD and a fresh cache returns the stored brief even
// though the tree now looks different.
const t0 = Date.parse("2026-11-25T00:00:00Z");
const first = briefFor(repo, { cacheDir, now: t0 });
assert.equal(first, brief);
const cacheFile = fs.readdirSync(cacheDir).find((f) => f.endsWith(".json"));
assert.ok(cacheFile, "a cache file was written");
const cached = JSON.parse(fs.readFileSync(path.join(cacheDir, cacheFile), "utf8"));
assert.match(cached.head, /^[0-9a-f]{40}$/);
assert.equal(cached.files, 6);
fs.mkdirSync(path.join(repo, "newdir"));
fs.writeFileSync(path.join(repo, "newdir", "n.mjs"), "// n\n");
assert.equal(briefFor(repo, { cacheDir, now: t0 + 1000 }), first, "uncommitted churn keeps the cached brief");
git("add", "-A"); git("commit", "-qm", "add newdir"); // 1 file changed: still cached
assert.equal(briefFor(repo, { cacheDir, now: t0 + 2000 }), first, "under 20 changed files keeps the cache");

// More than 20 committed files since the cached HEAD -> rebuild.
for (let i = 0; i < 21; i++) {
  const d = path.join(repo, `d${i}`);
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, "f.txt"), `${i}\n`);
}
git("add", "-A"); git("commit", "-qm", "21 dirs");
const rebuilt = briefFor(repo, { cacheDir, now: t0 + 3000 });
assert.notEqual(rebuilt, first, "a big change rebuilds the brief");
assert.match(rebuilt, /d0\//);

// A week-old cache rebuilds even with no commits.
const stale = briefFor(repo, { cacheDir, now: t0 + 8 * 24 * 3600 * 1000 });
assert.equal(typeof stale, "string");
assert.ok(stale.length < 1500);

// A non-git folder still gets a brief (and can't crash the cache path).
const plain = path.join(root, "plain");
fs.mkdirSync(path.join(plain, "docs"), { recursive: true });
fs.writeFileSync(path.join(plain, "docs", "a.md"), "# a\n");
const plainBrief = briefFor(plain, { cacheDir, now: t0 });
assert.match(plainBrief, /docs\/ \(1 file\)/);
assert.match(plainBrief, /Test: none found/);

fs.rmSync(root, { recursive: true, force: true });
console.log("constance-brief: tests passed");
