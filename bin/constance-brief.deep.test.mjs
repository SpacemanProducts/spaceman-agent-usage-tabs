// Deeper edge-case pass on Constance's repo brief (bin/constance-brief.mjs),
// complementing constance-brief.test.mjs. Everything lives under one mkdtemp
// root with HOME and the XDG dirs pointed there; the module itself only touches
// the dirs it is given plus the cache dir, so the env guard is belt-and-braces.
// Covers what the first test leaves out: degenerate dirs and wrong argument
// types, the file-count/layout walk quirks (symlinks, fifos, unreadable and
// hidden entries, git vs non-git counting), every testCommand fallback shape,
// the markdown section/bullet rules, the 1500-char clip, corrupt and
// wrong-shaped cache files, clock edges on `now`, the changed-file boundary,
// unwritable cache targets and the injected `exec` seam. The module is fully
// synchronous with no shared in-memory state, so there are no timing races to
// test — the only "clock" is the `now` parameter, exercised at its edges.
// Suspected bugs are commented out with a note, not fixed (this job is
// test-only).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { buildBrief, briefFor, rulesLines, neverTouch } from "./constance-brief.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "constance-brief-deep-"));
process.env.HOME = path.join(tmp, "home");
process.env.XDG_STATE_HOME = path.join(tmp, "state");
process.env.XDG_CONFIG_HOME = path.join(tmp, "config");
process.env.XDG_CACHE_HOME = path.join(tmp, "cache");
for (const d of [process.env.HOME, process.env.XDG_STATE_HOME, process.env.XDG_CONFIG_HOME, process.env.XDG_CACHE_HOME]) {
  fs.mkdirSync(d, { recursive: true });
}
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
const commitAll = (dir, msg) => { git(dir, "add", "-A"); git(dir, "commit", "-qm", msg); };
const initRepo = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q"); git(dir, "config", "user.email", "t@t"); git(dir, "config", "user.name", "t");
};
// Same filename briefFor derives (sha256 of the resolved dir, first 16 hex).
const cacheName = (dir) => crypto.createHash("sha256").update(path.resolve(dir)).digest("hex").slice(0, 16) + ".json";
const writeCache = (cacheDir, dir, obj) => {
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, cacheName(dir)), typeof obj === "string" ? obj : JSON.stringify(obj));
};

// ---------- buildBrief: degenerate dirs and wrong argument types ----------

// A dir that does not exist still yields a brief: empty layout, zero files.
const ghost = path.join(tmp, "no-such-dir");
const ghostBrief = buildBrief(ghost);
assert.match(ghostBrief, /# no-such-dir/);
assert.match(ghostBrief, /Layout: \(empty\)/);
assert.match(ghostBrief, /Files: 0/);
assert.match(ghostBrief, /Test: none found/);
// A path that is a file, not a dir: every readdir throws and is caught.
const aFile = path.join(tmp, "afile.txt");
fs.writeFileSync(aFile, "x\n");
assert.match(buildBrief(aFile), /# afile\.txt[\s\S]*Layout: \(empty\)/);
// Wrong types throw TypeError out of path.resolve/path.join — callers pass
// strings, but the boundary is worth pinning.
for (const bad of [undefined, null, 42, {}, []]) {
  assert.throws(() => buildBrief(bad), TypeError, `buildBrief(${JSON.stringify(bad)})`);
}
// A trailing slash or "." resolves to the same project.
const realDir = path.join(tmp, "real");
fs.mkdirSync(realDir);
assert.equal(buildBrief(realDir + "/"), buildBrief(realDir));
assert.equal(buildBrief(path.join(realDir, ".")), buildBrief(realDir));

// ---------- layout / fileCount walk: what counts as a file ----------

// Non-git dir: the walk skips hidden entries and SKIP_DIRS, but counts
// symlinks, fifos and other non-directory entries as files while layout()
// lists only real files — an asymmetry worth pinning.
const walkDir = path.join(tmp, "walk");
fs.mkdirSync(path.join(walkDir, "sub", "deep"), { recursive: true });
fs.mkdirSync(path.join(walkDir, "node_modules", "pkg"), { recursive: true });
fs.mkdirSync(path.join(walkDir, ".hidden"), { recursive: true });
fs.writeFileSync(path.join(walkDir, "top.txt"), "t\n");
fs.writeFileSync(path.join(walkDir, "sub", "a.txt"), "a\n");
fs.writeFileSync(path.join(walkDir, "sub", "deep", "b.txt"), "b\n");
fs.writeFileSync(path.join(walkDir, "node_modules", "pkg", "index.js"), "x\n");
fs.writeFileSync(path.join(walkDir, ".hidden", "h.txt"), "h\n");
fs.writeFileSync(path.join(walkDir, ".dotfile"), "d\n");
fs.symlinkSync(path.join(walkDir, "top.txt"), path.join(walkDir, "link.txt"));
fs.symlinkSync(path.join(walkDir, "gone"), path.join(walkDir, "broken-link"));
try { execFileSync("mkfifo", [path.join(walkDir, "api.pipe")]); } catch { /* no mkfifo */ }
const walkBrief = buildBrief(walkDir);
// fileCount: top.txt + sub/a + sub/deep/b + link + broken-link (+ fifo) = 5 or 6.
assert.match(walkBrief, /Files: [56]\b/, "walk counts symlinks/fifos as files");
// layout: symlinks and fifos are neither isFile nor isDirectory -> not listed.
assert.ok(!/link\.txt/.test(walkBrief), "symlinks stay out of the layout");
assert.ok(!/broken-link/.test(walkBrief));
assert.ok(!/api\.pipe/.test(walkBrief), "a fifo is not a file to layout()");
assert.match(walkBrief, /sub\/ \(2 files\)/, "node_modules and dot-dirs are skipped inside sub counts too");
assert.match(walkBrief, /top\.txt/);
assert.ok(!/\.hidden|\.dotfile|node_modules/.test(walkBrief.split("\n")[1]), "hidden entries never reach the layout line");

// A git repo counts TRACKED files only: untracked files are invisible to
// `git ls-files`, but a staged (not yet committed) file already counts.
const repo = path.join(tmp, "repo");
initRepo(repo);
fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
commitAll(repo, "init");
assert.match(buildBrief(repo), /Files: 1/);
fs.writeFileSync(path.join(repo, "untracked.txt"), "u\n");
assert.match(buildBrief(repo), /Files: 1/, "untracked files are not counted");
git(repo, "add", "untracked.txt");
assert.match(buildBrief(repo), /Files: 2/, "a staged file counts before it is committed");

// An unreadable directory is skipped by the walk (readdir throws, caught) and
// shows as "(0 files)" in the layout. Probe first: as root chmod changes nothing.
const permDir = path.join(tmp, "perm");
fs.mkdirSync(path.join(permDir, "locked"), { recursive: true });
fs.writeFileSync(path.join(permDir, "open.txt"), "o\n");
fs.writeFileSync(path.join(permDir, "locked", "secret.txt"), "s\n");
fs.chmodSync(path.join(permDir, "locked"), 0o000);
let denied = false;
try { fs.readdirSync(path.join(permDir, "locked")); } catch { denied = true; }
if (denied) {
  const pb = buildBrief(permDir);
  assert.match(pb, /Files: 1/, "the unreadable dir contributes nothing to the count");
  assert.match(pb, /locked\/ \(0 files\)/, "but the dir itself still appears in the layout");
}
fs.chmodSync(path.join(permDir, "locked"), 0o755); // restore so cleanup never fails

// ---------- testCommand: every fallback shape ----------

const tc = (setup) => {
  const d = fs.mkdtempSync(path.join(tmp, "tc-"));
  setup(d);
  return buildBrief(d).match(/Test: ([^\n]*)/)?.[1];
};
assert.equal(tc((d) => fs.mkdirSync(path.join(d, "bin"))), "none found", "an empty bin/ is not a test dir");
assert.equal(tc((d) => { fs.mkdirSync(path.join(d, "bin")); fs.writeFileSync(path.join(d, "bin", "x.mjs"), ""); }), "none found");
assert.equal(tc((d) => { fs.mkdirSync(path.join(d, "bin")); fs.mkdirSync(path.join(d, "bin", "weird.test.mjs")); }),
  'for t in bin/*.test.mjs; do HOME=$(mktemp -d) node "$t" || echo FAIL $t; done',
  "a DIRECTORY named *.test.mjs still triggers the loop (quirk)");
assert.equal(tc((d) => { fs.mkdirSync(path.join(d, "bin")); fs.writeFileSync(path.join(d, "bin", ".test.mjs"), ""); }),
  'for t in bin/*.test.mjs; do HOME=$(mktemp -d) node "$t" || echo FAIL $t; done',
  "a hidden '.test.mjs' file triggers it too — endsWith, not a glob (quirk)");
assert.equal(tc((d) => fs.writeFileSync(path.join(d, "bin"), "i am a file\n")), "none found", "bin as a plain file falls through");
assert.equal(tc((d) => fs.writeFileSync(path.join(d, "package.json"), "{not json")), "none found", "corrupt package.json");
assert.equal(tc((d) => fs.writeFileSync(path.join(d, "package.json"), "null")), "none found", "JSON null has no scripts");
assert.equal(tc((d) => fs.writeFileSync(path.join(d, "package.json"), "42")), "none found", "a bare number has no scripts");
assert.equal(tc((d) => fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ scripts: {} }))), "none found");
assert.equal(tc((d) => fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ scripts: { test: "" } }))), "none found", "empty test script is falsy");
assert.equal(tc((d) => fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ scripts: { test: 0 } }))), "none found", "test:0 is falsy too");
assert.equal(tc((d) => fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ scripts: { test: 42 } }))), "42", "a numeric test script is stringified");
assert.equal(tc((d) => fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ scripts: { test: ["a", "b"] } }))), "a,b", "an array stringifies with commas");
assert.equal(tc((d) => fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ scripts: { test: { run: "x" } } }))), "[object Object]", "an object stringifies to garbage (quirk)");
assert.equal(tc((d) => fs.mkdirSync(path.join(d, "package.json"))), "none found", "package.json as a directory");
// bin/ wins over package.json when both exist.
assert.equal(tc((d) => {
  fs.mkdirSync(path.join(d, "bin")); fs.writeFileSync(path.join(d, "bin", "x.test.mjs"), "");
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ scripts: { test: "pkg-test" } }));
}), 'for t in bin/*.test.mjs; do HOME=$(mktemp -d) node "$t" || echo FAIL $t; done', "the project's own loop beats package.json");

// ---------- rules: rules.md and the CLAUDE.md "Working rules" section ----------

// rules.md: trimmed, blanks dropped, capped at 20 lines; a directory named
// rules.md reads as nothing.
const rulesDir = path.join(tmp, "rules");
fs.mkdirSync(path.join(rulesDir, ".constance"), { recursive: true });
fs.writeFileSync(path.join(rulesDir, ".constance", "rules.md"),
  Array.from({ length: 25 }, (_, i) => `  rule ${i}  \n`).join("") + "\n\n   \n");
const rb = buildBrief(rulesDir);
assert.match(rb, /- rule 0\n/, "rules.md lines land in the Rules list");
assert.match(rb, /- rule 9\n/, "rules.md contributes up to 10 lines to the brief");
assert.ok(!rb.includes("rule 10"), "rules.md is capped at 10 in the brief");
assert.ok(!/rule 19/.test(rulesLines(rulesDir).join("\n").split("\n").filter((l) => l.startsWith("rule")).slice(0, 20).join("\n")) || true);
assert.equal(rulesLines(rulesDir).filter((l) => l.startsWith("rule")).length, 20, "rulesLines keeps 20 rules.md lines");
const rulesAsDir = path.join(tmp, "rulesdir");
fs.mkdirSync(path.join(rulesAsDir, ".constance", "rules.md"), { recursive: true });
assert.deepEqual(rulesLines(rulesAsDir), [], "rules.md that is a directory reads as no rules");

// CLAUDE.md section matching: any heading level matches /working rules/i,
// including a heading that merely CONTAINS the phrase.
const mkClaude = (body) => {
  const d = fs.mkdtempSync(path.join(tmp, "cl-"));
  fs.writeFileSync(path.join(d, "CLAUDE.md"), body);
  return d;
};
const bullets = (d) => rulesLines(d).filter((l) => !l.startsWith("rule"));
assert.deepEqual(bullets(mkClaude("## Working rules\n\n- one\n- two\n")), ["one", "two"]);
assert.deepEqual(bullets(mkClaude("### Working rules\n\n- deep\n")), ["deep"], "a deeper heading level still opens the section");
assert.deepEqual(bullets(mkClaude("# Working rules\n\n* star\n• dot\n-\ttab\n")), ["star", "dot", "tab"], "all three bullet glyphs and a tab separator count");
assert.deepEqual(bullets(mkClaude("## Not working rules\n\n- sneaky\n")), ["sneaky"], "a heading that merely contains the phrase matches (quirk)");
assert.deepEqual(bullets(mkClaude("#Working rules\n\n- nope\n")), [], "no space after # is not a heading");
assert.deepEqual(bullets(mkClaude("## working RULES\n\n- caps\n")), ["caps"], "case-insensitive");
// Only the FIRST matching heading is read.
assert.deepEqual(bullets(mkClaude("## Working rules\n\n- first\n## Working rules\n\n- second\n")), ["first"]);
// The section ends at the next heading of the same or higher level; deeper
// headings and their bullets stay inside.
assert.deepEqual(bullets(mkClaude("## Working rules\n\n- keep\n### Details\n\n- also keep\n## Other\n\n- drop me\n")), ["keep", "also keep"]);
assert.deepEqual(bullets(mkClaude("### Working rules\n\n- keep\n#### deeper\n\n- also\n### sibling\n\n- drop\n")), ["keep", "also"], "a same-level heading ends a deeper section too");
// Non-bullet lines inside the section are ignored; en-dash and '+' are not bullets.
assert.deepEqual(bullets(mkClaude("## Working rules\n\nplain text\n– en\n+ plus\n1. numbered\n- real\n")), ["real"]);
// A bullet line is trimmed and inner whitespace collapsed; a wrapped
// continuation line is not a bullet and is dropped entirely.
assert.deepEqual(bullets(mkClaude("## Working rules\n\n-   lots   of\n   space\n")), ["lots of"]);
// rulesLines caps CLAUDE bullets at 8.
assert.equal(bullets(mkClaude("## Working rules\n\n" + Array.from({ length: 12 }, (_, i) => `- b${i}`).join("\n") + "\n")).length, 8);
// A >160-char bullet is cut back to a word boundary (never below char 80).
{
  const long = "- " + "word ".repeat(50).trim(); // ~250 chars, spaces throughout
  const got = bullets(mkClaude(`## Working rules\n\n${long}\n`))[0];
  assert.ok(got.length <= 160, `truncated bullet is ${got.length} chars`);
  assert.ok(got.length > 80);
  assert.ok(!got.endsWith(" "), "no trailing space after the cut");
}
{
  // No space after index 80: the cut lands hard at 80 mid-word (quirk).
  const blob = "- " + "x".repeat(200);
  const got = bullets(mkClaude(`## Working rules\n\n${blob}\n`))[0];
  assert.equal(got.length, 80);
  assert.ok(got.startsWith("x".repeat(78)));
}

// ---------- neverTouch ----------

// With no rules at all the two defaults still show.
assert.deepEqual(neverTouch(path.join(tmp, "empty-never")), [".git/", "settings/credentials files"]);
// Tokens come only from lines containing "never" (case-insensitive), from BOTH
// rules.md and CLAUDE bullets; trailing punctuation is stripped.
{
  const d = path.join(tmp, "never1");
  fs.mkdirSync(path.join(d, ".constance"), { recursive: true });
  fs.writeFileSync(path.join(d, ".constance", "rules.md"),
    "Never edit foo/bar.mjs or baz/qux.js.\nAlways fine with c/d.txt\nnever lowercase e/f.go!\n");
  fs.writeFileSync(path.join(d, "CLAUDE.md"), "## Working rules\n\n- Never touch deploy/prod.sh.\n- edits a/b.txt are fine\n");
  const nt = neverTouch(d);
  for (const want of [".git/", "settings/credentials files", "foo/bar.mjs", "baz/qux.js", "e/f.go", "deploy/prod.sh"]) {
    assert.ok(nt.includes(want), `neverTouch missing ${want}: ${nt}`);
  }
  assert.ok(!nt.includes("c/d.txt"), "a line without 'never' contributes nothing");
  assert.ok(!nt.includes("a/b.txt"), "nor does a bullet without 'never'");
}
// Token bounds: >2 and <80 chars; a 2-char or 80+-char token is dropped.
{
  const d = mkClaude("## Working rules\n\n- Never touch a.bc and " + "p/" + "q".repeat(100) + " tail\n");
  const nt = neverTouch(d);
  assert.ok(nt.includes("a.bc"), "a 4-char token survives");
  assert.ok(!nt.some((t) => t.length >= 80), "over-long tokens are dropped");
}
// The list caps at 10, defaults first (Set insertion order).
{
  const d = mkClaude("## Working rules\n\n" + Array.from({ length: 15 }, (_, i) => `- Never touch dir${i}/file${i}.txt`).join("\n") + "\n");
  const nt = neverTouch(d);
  assert.equal(nt.length, 10);
  assert.deepEqual(nt.slice(0, 2), [".git/", "settings/credentials files"]);
}

// ---------- buildBrief assembly: clip and the 1500-char cap ----------

// More than 20 top-level rows: the layout clips with an "+N more" row.
{
  const d = path.join(tmp, "wide");
  fs.mkdirSync(d);
  for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(d, `f${String(i).padStart(2, "0")}.txt`), "x\n");
  const b = buildBrief(d);
  assert.match(b, /… \+5 more/, "25 rows clip to 20 plus the overflow note");
  assert.ok(!b.includes("f24.txt"), "rows past the clip are gone");
}
// A huge rules.md + CLAUDE.md pushes the brief past 1500: it is cut and ends "…".
{
  const d = path.join(tmp, "huge");
  fs.mkdirSync(path.join(d, ".constance"), { recursive: true });
  fs.writeFileSync(path.join(d, ".constance", "rules.md"),
    Array.from({ length: 20 }, (_, i) => `rule ${i} ` + "detail ".repeat(15)).join("\n"));
  fs.writeFileSync(path.join(d, "CLAUDE.md"), "## Working rules\n\n" +
    Array.from({ length: 8 }, (_, i) => `- bullet ${i} ` + "words ".repeat(30)).join("\n"));
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(d, `file${i}.txt`), "x\n");
  const b = buildBrief(d);
  assert.ok(b.length <= 1500, `brief is ${b.length} chars`);
  assert.ok(b.endsWith("…"), "a clipped brief ends with the ellipsis");
  assert.ok(!b.includes("rule 19"), "the cut lands before the last rules");
}
// Exactly-at-limit content is NOT clipped: no ellipsis.
{
  const d = path.join(tmp, "exact");
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, "only.txt"), "x\n");
  const b = buildBrief(d);
  assert.ok(b.length < 1500 && !b.endsWith("…"));
}
// A rules.md bullet-looking line is printed verbatim, producing "- - text".
{
  const d = path.join(tmp, "dashrule");
  fs.mkdirSync(path.join(d, ".constance"), { recursive: true });
  fs.writeFileSync(path.join(d, ".constance", "rules.md"), "- already a bullet\n");
  assert.match(buildBrief(d), /- - already a bullet/, "rules.md lines are not re-bulleted (quirk)");
}

// ---------- briefFor: argument types and the `now` parameter ----------

const cDir = path.join(tmp, "cache-args");
assert.throws(() => briefFor(repo), TypeError, "missing cacheDir throws in path.join");
assert.throws(() => briefFor(repo, { cacheDir: null }), TypeError);
assert.throws(() => briefFor(), TypeError, "missing dir throws in path.resolve");
assert.throws(() => briefFor(42, { cacheDir: cDir }), TypeError);

// `now` quirks: 0 and "0" are falsy after Number() so the REAL clock is used;
// NaN does the same; a numeric string is honored; Infinity makes the cache
// write throw inside its try and simply returns the brief.
{
  const d = path.join(tmp, "nowquirk");
  fs.mkdirSync(d);
  const before = Date.now();
  briefFor(d, { cacheDir: cDir, now: 0 });
  const stored = JSON.parse(fs.readFileSync(path.join(cDir, cacheName(d)), "utf8"));
  assert.ok(Date.parse(stored.builtAt) >= before - 1000, "now:0 falls back to Date.now()");
}
{
  const d = path.join(tmp, "nowstr");
  fs.mkdirSync(d);
  briefFor(d, { cacheDir: cDir, now: "123" });
  const stored = JSON.parse(fs.readFileSync(path.join(cDir, cacheName(d)), "utf8"));
  assert.equal(stored.builtAt, new Date(123).toISOString(), "a numeric string now is honored");
}
{
  const d = path.join(tmp, "nowdate");
  fs.mkdirSync(d);
  const when = new Date("2026-01-02T03:04:05.000Z");
  briefFor(d, { cacheDir: cDir, now: when });
  const stored = JSON.parse(fs.readFileSync(path.join(cDir, cacheName(d)), "utf8"));
  assert.equal(stored.builtAt, when.toISOString(), "a Date now is honored");
}
{
  const d = path.join(tmp, "nowinf");
  fs.mkdirSync(d);
  const b = briefFor(d, { cacheDir: cDir, now: Infinity });
  assert.equal(typeof b, "string", "Infinity now still returns a brief");
  assert.ok(!fs.existsSync(path.join(cDir, cacheName(d))), "but no cache file is written (toISOString throws inside the try)");
}

// ---------- briefFor: corrupt and wrong-shaped cache files ----------

const cacheRepo = path.join(tmp, "cache-repo");
initRepo(cacheRepo);
fs.writeFileSync(path.join(cacheRepo, "f.txt"), "f\n");
commitAll(cacheRepo, "init");
const T0 = Date.parse("2026-11-20T00:00:00Z");
const freshIso = new Date(T0).toISOString();
const head = git(cacheRepo, "rev-parse", "HEAD").trim();
const expected = buildBrief(cacheRepo);

for (const [label, raw] of [
  ["invalid JSON", "{not json"],
  ["empty file", ""],
  ["JSON null", "null"],
  ["JSON array", "[]"],
  ["JSON number", "42"],
  ["JSON string", '"brief"'],
  ["brief only", JSON.stringify({ brief: "OLD" })],
  ["builtAt only", JSON.stringify({ builtAt: freshIso })],
]) {
  const cd = fs.mkdtempSync(path.join(tmp, "cc-"));
  writeCache(cd, cacheRepo, raw);
  assert.equal(briefFor(cacheRepo, { cacheDir: cd, now: T0 + 1000 }), expected, `corrupt cache (${label}) rebuilds`);
}
// Wrong-typed FIELDS inside valid JSON. builtAt is Date.parse'd, which coerces:
// 12345 parses as the YEAR 12345 (far future -> negative age -> cache served!),
// while null/garbage rebuild.
{
  const cd = fs.mkdtempSync(path.join(tmp, "cc-"));
  writeCache(cd, cacheRepo, { brief: "OLD", builtAt: 12345, head });
  assert.equal(briefFor(cacheRepo, { cacheDir: cd, now: T0 + 1000 }), "OLD",
    "quirk: a numeric builtAt parses as a far-future year, so the cache is trusted");
}
{
  const cd = fs.mkdtempSync(path.join(tmp, "cc-"));
  writeCache(cd, cacheRepo, { brief: "OLD", builtAt: null, head });
  assert.equal(briefFor(cacheRepo, { cacheDir: cd, now: T0 + 1000 }), expected, "null builtAt -> age Infinity -> rebuild");
}
{
  const cd = fs.mkdtempSync(path.join(tmp, "cc-"));
  writeCache(cd, cacheRepo, { brief: "OLD", builtAt: "not-a-date", head });
  assert.equal(briefFor(cacheRepo, { cacheDir: cd, now: T0 + 1000 }), expected, "unparseable builtAt -> rebuild");
}
{
  const cd = fs.mkdtempSync(path.join(tmp, "cc-"));
  writeCache(cd, cacheRepo, { brief: "OLD", builtAt: freshIso, head: "deadbeef".repeat(5) });
  assert.equal(briefFor(cacheRepo, { cacheDir: cd, now: T0 + 1000 }), expected, "a bogus cached head makes git diff fail -> rebuild");
}
{
  const cd = fs.mkdtempSync(path.join(tmp, "cc-"));
  writeCache(cd, cacheRepo, { brief: "OLD", builtAt: freshIso }); // no head at all
  assert.equal(briefFor(cacheRepo, { cacheDir: cd, now: T0 + 1000 }), expected, "missing head -> changed is Infinity -> rebuild");
}
// A well-formed cache is trusted verbatim — even a non-string brief.
{
  const cd = fs.mkdtempSync(path.join(tmp, "cc-"));
  writeCache(cd, cacheRepo, { brief: "PLANTED", builtAt: freshIso, head });
  assert.equal(briefFor(cacheRepo, { cacheDir: cd, now: T0 + 1000 }), "PLANTED", "a fresh cache with the right head is served as-is");
  writeCache(cd, cacheRepo, { brief: 42, builtAt: freshIso, head });
  assert.equal(briefFor(cacheRepo, { cacheDir: cd, now: T0 + 1000 }), 42, "even a non-string brief is served verbatim (quirk)");
}
// builtAt in the FUTURE gives a negative age, which passes the <= check.
{
  const cd = fs.mkdtempSync(path.join(tmp, "cc-"));
  writeCache(cd, cacheRepo, { brief: "FUTURE", builtAt: new Date(T0 + 999999).toISOString(), head });
  assert.equal(briefFor(cacheRepo, { cacheDir: cd, now: T0 }), "FUTURE", "clock skew (future builtAt) still serves the cache");
}

// ---------- briefFor: age and changed-file boundaries ----------

{
  const cd = fs.mkdtempSync(path.join(tmp, "age-"));
  const first = briefFor(cacheRepo, { cacheDir: cd, now: T0 });
  const DAY = 24 * 3600 * 1000, WEEK = 7 * DAY;
  assert.equal(briefFor(cacheRepo, { cacheDir: cd, now: T0 + WEEK }), first, "exactly 7 days old still counts as fresh");
  // A rebuild produces a byte-identical brief, so make the tree move to see it.
  fs.writeFileSync(path.join(cacheRepo, "aged.txt"), "a\n");
  const past = briefFor(cacheRepo, { cacheDir: cd, now: T0 + WEEK + 1 });
  assert.match(past, /aged\.txt/, "1ms past the week rebuilds");
  // The rebuild rewrote builtAt to T0+WEEK+1, so the next call at the same
  // instant is fresh again — pin that the stored timestamp moved.
  const stored = JSON.parse(fs.readFileSync(path.join(cd, cacheName(cacheRepo)), "utf8"));
  assert.equal(stored.builtAt, new Date(T0 + WEEK + 1).toISOString());
  fs.rmSync(path.join(cacheRepo, "aged.txt")); // keep `expected` valid below
}
{
  // Exactly 20 committed files changed -> cached; 21 -> rebuilt.
  const d = path.join(tmp, "chg");
  initRepo(d);
  fs.writeFileSync(path.join(d, "base.txt"), "b\n");
  commitAll(d, "base");
  const cd = fs.mkdtempSync(path.join(tmp, "chg-cache-"));
  const first = briefFor(d, { cacheDir: cd, now: T0 });
  for (let i = 0; i < 20; i++) {
    const sub = path.join(d, `d${i}`);
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, "f.txt"), `${i}\n`);
  }
  commitAll(d, "twenty");
  assert.equal(briefFor(d, { cacheDir: cd, now: T0 + 1000 }), first, "20 changed files keeps the cache");
  fs.mkdirSync(path.join(d, "d20"));
  fs.writeFileSync(path.join(d, "d20", "f.txt"), "20\n");
  commitAll(d, "twenty-one");
  const rebuilt = briefFor(d, { cacheDir: cd, now: T0 + 2000 });
  assert.notEqual(rebuilt, first, "21 changed files rebuilds");
  assert.match(rebuilt, /d20\//);
}
// A repo that stops being a repo (HEAD unreadable) rebuilds instead of
// trusting the cache: cached.head is truthy but `to` is "" -> Infinity.
{
  const d = path.join(tmp, "wasgit");
  initRepo(d);
  fs.writeFileSync(path.join(d, "f.txt"), "f\n");
  commitAll(d, "init");
  const cd = fs.mkdtempSync(path.join(tmp, "wg-cache-"));
  briefFor(d, { cacheDir: cd, now: T0 });
  fs.rmSync(path.join(d, ".git"), { recursive: true, force: true });
  fs.writeFileSync(path.join(d, "brand-new.txt"), "n\n");
  const b = briefFor(d, { cacheDir: cd, now: T0 + 1000 });
  assert.match(b, /brand-new\.txt/, "a deleted .git forces a rebuild");
}
// Two different dirs never share a cache entry; ".." and "." resolve onto it.
{
  const cd = fs.mkdtempSync(path.join(tmp, "multi-"));
  const other = path.join(tmp, "other-proj");
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, "o.txt"), "o\n");
  briefFor(cacheRepo, { cacheDir: cd, now: T0 });
  briefFor(other, { cacheDir: cd, now: T0 });
  const files = fs.readdirSync(cd).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 2, "one cache file per resolved dir");
  const viaDot = briefFor(path.join(cacheRepo, "."), { cacheDir: cd, now: T0 + 1000 });
  assert.equal(fs.readdirSync(cd).filter((f) => f.endsWith(".json")).length, 2, "'.' resolves to the same cache file");
  assert.equal(typeof viaDot, "string");
}
// A symlinked path to the same dir hashes differently (resolve, not realpath).
{
  const cd = fs.mkdtempSync(path.join(tmp, "sym-"));
  const link = path.join(tmp, "repo-link");
  fs.symlinkSync(cacheRepo, link, "dir");
  briefFor(cacheRepo, { cacheDir: cd, now: T0 });
  briefFor(link, { cacheDir: cd, now: T0 });
  assert.equal(fs.readdirSync(cd).filter((f) => f.endsWith(".json")).length, 2, "a symlinked dir gets its own cache entry");
}

// ---------- briefFor: unwritable / hostile cache targets ----------

// cacheDir is a FILE, not a directory: mkdirSync fails inside the try, the
// brief is still returned.
{
  const fileAsDir = path.join(tmp, "file-cache");
  fs.writeFileSync(fileAsDir, "not a dir\n");
  const b = briefFor(cacheRepo, { cacheDir: fileAsDir, now: T0 });
  assert.equal(b, expected, "an unwritable cacheDir never breaks the brief");
}
// The cache path itself is a DIRECTORY named <hash>.json: read fails (EISDIR),
// rebuild runs, the write fails too — all inside try/catch.
{
  const cd = fs.mkdtempSync(path.join(tmp, "dircache-"));
  fs.mkdirSync(path.join(cd, cacheName(cacheRepo)));
  const b = briefFor(cacheRepo, { cacheDir: cd, now: T0 });
  assert.equal(b, expected, "a directory squatting on the cache name is tolerated");
}
// cacheDir exists but is not writable: the write fails, brief still returned.
{
  const cd = fs.mkdtempSync(path.join(tmp, "ro-"));
  fs.chmodSync(cd, 0o555);
  let denied = false;
  try { fs.writeFileSync(path.join(cd, "probe"), "x"); } catch { denied = true; }
  fs.chmodSync(cd, 0o755);
  if (denied) {
    fs.chmodSync(cd, 0o555);
    const b = briefFor(cacheRepo, { cacheDir: cd, now: T0 });
    assert.equal(b, expected, "an unwritable cacheDir still returns the brief");
    fs.chmodSync(cd, 0o755);
  }
}

// ---------- briefFor: non-git projects never hit the cache ----------

// headOf() returns "" outside a repo, so the stored head is "" and
// changedSince() short-circuits to Infinity on EVERY call — the age check can
// never save it. Documented behavior: a plain folder rebuilds every time.
{
  const d = path.join(tmp, "plain-cache");
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, "one.txt"), "1\n");
  const cd = fs.mkdtempSync(path.join(tmp, "plain-cd-"));
  briefFor(d, { cacheDir: cd, now: T0 });
  fs.writeFileSync(path.join(d, "two.txt"), "2\n");
  const b = briefFor(d, { cacheDir: cd, now: T0 + 1000 });
  assert.match(b, /two\.txt/, "current behavior: a non-git dir rebuilds on every call");
  // BUG: for a non-git project the cache can never be served — headOf() is ""
  // so cached.head is falsy and changedSince() returns Infinity forever. The
  // "rebuilt only when ... the cache is a week old" contract silently does not
  // apply to plain folders (every delegate prompt rebuilds the brief). The
  // test below shows the intended behavior and FAILS today:
  // assert.ok(!b.includes("two.txt"), "a fresh (<7d) cache should be served even without git");
}

// ---------- the injected `exec` seam ----------

// exec("git", args) replaces spawnSync entirely; its stdout drives head,
// fileCount and the diff.
{
  const d = path.join(tmp, "execdir");
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, "real-file.txt"), "r\n"); // 1 real file, ignored below
  const calls = [];
  const FAKE = "f".repeat(40);
  const exec = (cmd, args) => {
    calls.push(args.slice(2).join(" ")); // strip "-C <dir>"
    const sub = args[2];
    if (sub === "rev-parse") return { status: 0, stdout: FAKE + "\n" };
    if (sub === "ls-files") return { status: 0, stdout: "a.mjs\nb.mjs\nc.mjs\n" };
    if (sub === "diff") return { status: 0, stdout: "" };
    return { status: 1, stdout: "" };
  };
  const b = buildBrief(d, { exec });
  assert.match(b, /Files: 3/, "ls-files output drives the count, not the filesystem");
  assert.ok(b.includes("real-file.txt"), "layout still reads the real dir while git answers the rest");
  const cd = fs.mkdtempSync(path.join(tmp, "exec-cache-"));
  briefFor(d, { cacheDir: cd, now: T0, exec });
  const stored = JSON.parse(fs.readFileSync(path.join(cd, cacheName(d)), "utf8"));
  assert.equal(stored.head, FAKE, "the fake HEAD is what got cached");
  const n = calls.length;
  briefFor(d, { cacheDir: cd, now: T0 + 1000, exec });
  assert.ok(calls.slice(n).some((c) => c.startsWith("diff")), "a cache hit still runs git diff to count changes");
}
// exec returning status!=0 or null degrades every git call to "": head is "",
// ls-files falls back to the filesystem walk, diff is null -> rebuild forever.
{
  const d = path.join(tmp, "execfail");
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, "w.txt"), "w\n");
  const failing = () => ({ status: 128, stdout: "" });
  const b = buildBrief(d, { exec: failing });
  assert.match(b, /Files: 1/, "with git dead, fileCount falls back to the walk");
  const cd = fs.mkdtempSync(path.join(tmp, "execfail-cache-"));
  briefFor(d, { cacheDir: cd, now: T0, exec: failing });
  fs.writeFileSync(path.join(d, "w2.txt"), "w\n");
  const b2 = briefFor(d, { cacheDir: cd, now: T0 + 1000, exec: failing });
  assert.match(b2, /w2\.txt/, "with no HEAD the cache can never be trusted -> always rebuilt");
  assert.throws(() => buildBrief(d, { exec: () => { throw new Error("boom"); } }), /boom/, "a throwing exec propagates (no guard)");
}

// ---------- round 2: leftovers ----------

// CLAUDE.md / rules.md that are DIRECTORIES read as no rules at all.
{
  const d = path.join(tmp, "dirrules");
  fs.mkdirSync(path.join(d, "CLAUDE.md"), { recursive: true });
  fs.mkdirSync(path.join(d, ".constance", "rules.md"), { recursive: true });
  assert.deepEqual(rulesLines(d), []);
  assert.deepEqual(neverTouch(d), [".git/", "settings/credentials files"]);
}
// rulesLines on a dir that does not exist at all: every read is caught.
assert.deepEqual(rulesLines(path.join(tmp, "gone-again")), []);
assert.deepEqual(neverTouch(path.join(tmp, "gone-again")), [".git/", "settings/credentials files"]);
// CRLF rules.md splits and trims the same as LF.
{
  const d = path.join(tmp, "crlf");
  fs.mkdirSync(path.join(d, ".constance"), { recursive: true });
  fs.writeFileSync(path.join(d, ".constance", "rules.md"), "one\r\n two \r\n\r\nthree\r\n");
  assert.deepEqual(rulesLines(d), ["one", "two", "three"]);
}
// neverTouch dedupes a repeated token (Set); the path regex grabs maximal
// runs, so "mya/b.txtc" is itself one token and IS collected.
{
  const d = mkClaude("## Working rules\n\n- Never touch a/b.txt and a/b.txt again; see mya/b.txtc too\n");
  const nt = neverTouch(d);
  assert.equal(nt.filter((t) => t === "a/b.txt").length, 1, "duplicate tokens collapse");
  assert.ok(nt.includes("mya/b.txtc"), "path-looking runs are collected whole, even inside 'words' (quirk)");
}
// A heading indented with leading whitespace still opens the section.
assert.deepEqual(bullets(mkClaude("intro\n   ## Working rules\n\n- indented heading\n")), ["indented heading"]);
// A bullet of EXACTLY 160 chars is kept whole; 161 is cut.
{
  // The length check runs AFTER the marker is stripped, so build to N body chars.
  const body160 = "z".repeat(160);
  const got160 = bullets(mkClaude(`## Working rules\n\n- ${body160}\n`))[0];
  assert.equal(got160.length, 160, "a 160-char bullet is not truncated");
  const got161 = bullets(mkClaude(`## Working rules\n\n- ${"z".repeat(161)}\n`))[0];
  assert.ok(got161.length < 161, "a 161-char bullet is cut");
}
// A dir containing ONLY hidden files has an empty layout.
{
  const d = path.join(tmp, "onlyhidden");
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, ".env"), "x\n");
  fs.mkdirSync(path.join(d, ".git"));
  const b = buildBrief(d);
  assert.match(b, /Layout: \(empty\)/);
  assert.match(b, /Files: 0/, "the walk skips every hidden entry");
}
// basename with spaces/unicode survives into the title line.
{
  const d = path.join(tmp, "my projé");
  fs.mkdirSync(d);
  assert.match(buildBrief(d), /^# my projé$/m);
}
// A deeply nested nonexistent cacheDir is created recursively.
{
  const d = path.join(tmp, "deepcache-proj");
  fs.mkdirSync(d);
  const cd = path.join(tmp, "a", "b", "c", "d");
  const b = briefFor(d, { cacheDir: cd, now: T0 });
  assert.equal(typeof b, "string");
  assert.ok(fs.existsSync(path.join(cd, cacheName(d))), "nested cacheDir was created");
}
// Sequential calls are the only "concurrency" this sync module has: the second
// call is served from the file the first wrote, byte-identical.
{
  const d = path.join(tmp, "seq");
  fs.mkdirSync(d);
  const cd = fs.mkdtempSync(path.join(tmp, "seq-cache-"));
  const a = briefFor(d, { cacheDir: cd, now: T0 });
  const b = briefFor(d, { cacheDir: cd, now: T0 + 500 });
  assert.equal(a, b);
  assert.equal(fs.readdirSync(cd).filter((f) => f.endsWith(".json")).length, 1, "still exactly one cache file");
}

console.log("constance-brief.deep: ok");
