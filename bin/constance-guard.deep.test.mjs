// Deeper edge-case pass on Constance's post-run guard (bin/constance-guard.mjs),
// complementing constance-guard.test.mjs. Every scenario gets its own throwaway
// HOME/Projects/git repo under mktemp; nothing touches the real home, network or
// any agent CLI. Covers what the first test leaves out: several bad commits at
// once, pre-dirty paths, commits that are not the run's own, renames and
// deletions, an empty allowed list, old snapshots without a HEAD, and the
// restoreRun dedupe — plus the five edge cases that used to be suspected bugs
// (directory allowed entries, rename sources, quoted/arrow filenames,
// untracked-dir collapse, rewritten base HEADs).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { snapshot, checkRun, restoreRun, changedPaths, commitFromRun, newCommits, dirtyPaths } from "./constance-guard.mjs";

// One isolated world per scenario: fake HOME with a Projects folder holding a
// git repo "app", mirroring how delegate() sets a job up (including the
// .constance/ info/exclude, unless a scenario asks for none).
function setup({ exclude = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "constance-guard-deep-"));
  const home = path.join(root, "home"), projects = path.join(home, "Projects"), repo = path.join(projects, "app");
  fs.mkdirSync(repo, { recursive: true });
  const env = { HOME: home, SQUAD_PROJECTS: projects };
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  if (exclude) fs.writeFileSync(path.join(repo, ".git/info/exclude"), ".constance/\n");
  const write = (p, t = "x\n") => { const f = path.join(repo, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
  write("readme.md", "r\n");
  git("add", "-A"); git("commit", "-qm", "init");
  const head = () => git("rev-parse", "HEAD").trim();
  const commit = (msg) => { git("add", "-A"); git("commit", "-qm", msg); return head(); };
  return { root, home, projects, repo, env, git, write, head, commit, before: () => snapshot(env, repo), done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// ---- several commits, each touching different outside files: every new commit
// is diff-checked, badCommits comes back newest-first, badPaths is the union.
{
  const s = setup();
  const b = s.before();
  s.write("ok.txt", "o\n"); s.git("add", "ok.txt"); s.git("commit", "-qm", "allowed only");
  const c1 = s.head();
  s.write("bad1.txt"); const c2 = s.commit("bad one");
  s.write("sub/bad2.txt"); s.write("bad3.txt"); const c3 = s.commit("bad two and three");
  const res = checkRun({ dir: s.repo, files: ["ok.txt"], commit: c3, before: b, env: s.env });
  assert.equal(res.ok, false);
  assert.deepEqual(res.ownCommits, [c1, c2, c3], "all three commits since the snapshot, oldest first");
  assert.deepEqual(res.badCommits, [c3, c2], "newest first; the clean commit is not bad");
  for (const p of ["bad1.txt", "sub/bad2.txt", "bad3.txt"]) assert.ok(res.badPaths.includes(p), `${p} flagged`);
  assert.ok(!res.badPaths.includes("ok.txt"), "the allowed file is never blamed");
  assert.equal(res.ownCommit, c3, "the reported new commit stays ownCommit even though it is bad");
  s.done();
}

// ---- paths dirty before the run are never blamed, even when the run edits
// them further; only genuinely new dirty paths count.
{
  const s = setup();
  s.write("wip.txt", "base\n"); s.git("add", "wip.txt"); s.git("commit", "-qm", "wip base");
  s.write("wip.txt", "owner edit\n"); s.write("draft.md", "d\n");
  const b = s.before();
  assert.ok(b.dirty.includes("wip.txt") && b.dirty.includes("draft.md"), "pre-run dirt recorded");
  s.write("wip.txt", "owner edit + agent\n"); s.write("stray.txt"); s.write("sub/new-dirty.txt");
  const res = checkRun({ dir: s.repo, files: ["ok.txt"], commit: "", before: b, env: s.env });
  // "sub/new-dirty.txt", not "sub/": --untracked-files=all expands a wholly
  // untracked directory to its files, so nothing hides under a collapsed "dir/".
  assert.deepEqual([...res.badPaths].sort(), ["stray.txt", "sub/new-dirty.txt"],
    "pre-dirty wip.txt/draft.md excused no matter how the run touched them");
  const did = restoreRun({ dir: s.repo, badPaths: res.badPaths });
  assert.ok(did.some((d) => d.includes("left in place")), "strays are reported, never deleted");
  assert.equal(fs.readFileSync(path.join(s.repo, "wip.txt"), "utf8"), "owner edit + agent\n", "owner's file untouched");
  s.done();
}

// ---- a pre-dirty path the run COMMITS is still blamed: before.dirty only
// excuses paths still dirty, never files inside a new commit. Asserted as-is —
// the commit genuinely mixes the owner's edits with the run's, so flagging it
// is defensible, but it is worth knowing the excuse does not extend to commits.
{
  const s = setup();
  s.write("wip.txt", "base\n"); s.git("add", "wip.txt"); s.git("commit", "-qm", "base");
  s.write("wip.txt", "owner edit\n");
  const b = s.before();
  const c = s.commit("agent commits the owner's dirty file");
  const res = checkRun({ dir: s.repo, files: ["ok.txt"], commit: c, before: b, env: s.env });
  assert.deepEqual(res.badPaths, ["wip.txt"], "committed paths are never excused by before.dirty");
  s.done();
}

// ---- commits that are not the run's own: an old commit, the pre-run HEAD, a
// commit on an unmerged side branch, and junk hashes are all refused — they are
// flagged as untrusted, never diff-checked as the run's, and never in badCommits.
{
  const s = setup();
  const oldC = s.head();
  s.git("checkout", "-qb", "side");
  s.write("side.txt"); s.git("add", "side.txt"); s.git("commit", "-qm", "someone else's branch");
  const foreign = s.head();
  s.git("checkout", "-q", "-");
  const b = s.before();
  assert.equal(commitFromRun(s.repo, foreign, b.head), false, "unmerged side-branch commit is not the run's");
  assert.equal(commitFromRun(s.repo, oldC, b.head), false, "a commit older than the snapshot is not the run's");
  assert.equal(commitFromRun(s.repo, b.head, b.head), false, "the pre-run HEAD itself is not the run's");
  assert.equal(commitFromRun(s.repo, "not-a-hash", b.head), false);
  assert.equal(commitFromRun(s.repo, "", b.head), false);
  s.write("new.txt"); const c = s.commit("the real run commit");
  assert.equal(commitFromRun(s.repo, c.slice(0, 9), b.head), true, "a 9-char short hash resolves");
  assert.deepEqual(newCommits(s.repo, b.head), [c], "the side branch never enters ownCommits");
  const res = checkRun({ dir: s.repo, files: ["new.txt"], commit: foreign, before: b, env: s.env });
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => v.includes("not a new commit")), res.violations.join("; "));
  assert.deepEqual(res.badCommits, [], "the foreign commit is never marked bad or good — just untrusted");
  assert.equal(res.ownCommit, c, "ownCommit falls back to the newest real new commit");
  s.done();
}

// ---- renames and deletions: --name-status reports both sides of a rename, so
// renaming an outside file INTO an allowed name still flags the deleted source.
{
  const s = setup();
  s.write("ok.txt", "o\n"); s.write("gone.txt", "g\n");
  s.git("add", "-A"); s.git("commit", "-qm", "base");
  const b = s.before();
  s.git("mv", "ok.txt", "ok2.txt"); s.git("commit", "-qm", "rename inside the list");
  const rc = s.head();
  s.git("rm", "gone.txt"); s.git("commit", "-qm", "delete an outside file");
  const dc = s.head();
  const res = checkRun({ dir: s.repo, files: ["ok2.txt"], commit: dc, before: b, env: s.env });
  assert.equal(res.ok, false);
  assert.deepEqual(res.ownCommits, [rc, dc]);
  assert.deepEqual(res.badCommits, [dc, rc], "both commits touched a path outside the list: the rename deleted ok.txt");
  assert.deepEqual([...res.badPaths].sort(), ["gone.txt", "ok.txt"],
    "the deleted outside file and the rename's source are caught; ok2.txt is fine");
  s.done();
}
{
  const s = setup();
  s.write("ok.txt", "o\n"); s.git("add", "ok.txt"); s.git("commit", "-qm", "add ok");
  const b = s.before();
  s.git("mv", "ok.txt", "stolen.txt"); // destination outside the allowed list
  const c = s.commit("rename out of the list");
  const res = checkRun({ dir: s.repo, files: ["ok.txt"], commit: c, before: b, env: s.env });
  assert.equal(res.ok, false);
  assert.deepEqual(res.badPaths, ["stolen.txt"], "the rename destination is what gets checked");
  s.done();
}
{
  const s = setup();
  s.write("ok.txt", "o\n"); s.git("add", "ok.txt"); s.git("commit", "-qm", "add ok");
  const b = s.before();
  s.git("rm", "ok.txt"); s.git("commit", "-qm", "delete the allowed file");
  const c = s.head();
  const res = checkRun({ dir: s.repo, files: ["ok.txt"], commit: c, before: b, env: s.env });
  assert.equal(res.ok, true, "deleting an allowed file is inside the list: " + JSON.stringify(res.violations));
  s.done();
}
{
  // Same rename rule for uncommitted work: a staged rename's "to\0from" pair
  // reaches dirtyPaths as both names, so the deleted source is checked too.
  const s = setup();
  s.write("ok.txt", "o\n"); s.git("add", "ok.txt"); s.git("commit", "-qm", "add ok");
  const b = s.before();
  s.git("mv", "ok.txt", "stolen.txt");
  const res = checkRun({ dir: s.repo, files: ["ok.txt"], commit: "", before: b, env: s.env });
  assert.equal(res.ok, false);
  assert.deepEqual(res.badPaths, ["stolen.txt"], "ok.txt is allowed; stolen.txt is not");
  s.done();
}

// ---- empty allowed list: read-only job. Any tracked change is a violation;
// an untracked .constance/ folder alone (no exclude configured here, so it
// really reaches dirtyPaths) is inside the built-in ".constance/" entry.
{
  const s = setup({ exclude: false });
  const b = s.before();
  fs.mkdirSync(path.join(s.repo, ".constance"));
  fs.writeFileSync(path.join(s.repo, ".constance", "done-1.json"), "{}");
  let res = checkRun({ dir: s.repo, files: [], commit: "", before: b, env: s.env });
  assert.equal(res.ok, true, "only .constance/ churn on a read-only job: " + JSON.stringify(res.violations));
  s.write("x.txt");
  res = checkRun({ dir: s.repo, files: [], commit: "", before: b, env: s.env });
  assert.equal(res.ok, false, "read-only jobs flag any real change");
  assert.deepEqual(res.badPaths, ["x.txt"]);
  s.done();
}

// ---- old snapshots without a recorded HEAD (pre-1.4x jobs): only dirty paths
// are judged; a bogus reported commit is not even flagged, ownCommits stays [].
{
  const s = setup();
  s.write("stray.txt");
  const oldBefore = { home: ["Projects"], projects: ["app"], projectsDir: s.projects };
  const res = checkRun({ dir: s.repo, files: [], commit: "deadbeef", before: oldBefore, env: s.env });
  assert.equal(res.ok, false);
  assert.deepEqual(res.badPaths, ["stray.txt"]);
  assert.ok(!res.violations.some((v) => v.includes("not a new commit")),
    "with no recorded HEAD the reported commit is not judged at all");
  assert.deepEqual(res.ownCommits, []);
  s.done();
}

// ---- allowed-list matching details: "." allows everything; "./" prefixes and
// trailing slashes are normalised away.
{
  const s = setup();
  const b = s.before();
  s.write("anything/deep.txt"); const c = s.commit("everything");
  let res = checkRun({ dir: s.repo, files: ["."], commit: c, before: b, env: s.env });
  assert.equal(res.ok, true, "'.' is the whole project: " + JSON.stringify(res.violations));
  s.done();
}
{
  const s = setup();
  s.write("src/keep.txt", "k\n"); s.git("add", "-A"); s.git("commit", "-qm", "track src");
  const b = s.before();
  s.write("src/foo.mjs", "f\n"); // src/ is tracked now, so status lists the file itself
  const res = checkRun({ dir: s.repo, files: ["./src/foo.mjs/"], commit: "", before: b, env: s.env });
  assert.equal(res.ok, true, "'./' and trailing '/' on the allowed entry still match: " + JSON.stringify(res.badPaths));
  s.done();
}

// ---- home/projects removals are notices too, and dotfile churn stays ignored.
{
  const s = setup();
  fs.mkdirSync(path.join(s.projects, "old-project"), { recursive: true });
  const b = s.before();
  fs.rmSync(path.join(s.projects, "old-project"), { recursive: true });
  fs.mkdirSync(path.join(s.home, ".hidden-churn"));
  const res = checkRun({ dir: s.repo, files: [], commit: "", before: b, env: s.env });
  assert.equal(res.ok, true, "home/projects differences are never violations");
  assert.deepEqual(res.removedProjects, ["old-project"]);
  assert.ok(res.notices.some((n) => n.includes("old-project")), "the removal is noticed");
  assert.ok(!res.notices.some((n) => n.includes("hidden-churn")), "dotfile churn is ignored");
  s.done();
}

// ---- restoreRun dedupes: the same commit passed as both `commit` and inside
// `commits` is reverted exactly once; commits revert newest-first as given.
{
  const s = setup();
  s.write("a1.txt"); const c1 = s.commit("a1");
  s.write("b2.txt"); const c2 = s.commit("b2");
  const did = restoreRun({ dir: s.repo, commit: c2, commits: [c2, c1] });
  assert.equal(did.filter((d) => d.startsWith("reverted commit")).length, 2, did.join("; "));
  assert.ok(!fs.existsSync(path.join(s.repo, "a1.txt")) && !fs.existsSync(path.join(s.repo, "b2.txt")));
  assert.equal(s.git("status", "--porcelain").trim(), "", "clean tree after the reverts");
  s.done();
}

// ---- changedPaths with an explicit commit: the commit's files plus dirty
// paths that were not already dirty — and pre-dirty paths stay excluded.
{
  const s = setup();
  s.write("wip.txt", "base\n"); s.git("add", "wip.txt"); s.git("commit", "-qm", "base");
  s.write("wip.txt", "owner edit\n");
  const b = s.before();
  s.write("in-commit.txt"); s.git("add", "in-commit.txt"); s.git("commit", "-qm", "one file");
  s.write("new-dirty.txt"); // left untracked
  const c = s.head();
  const paths = changedPaths(s.repo, c, b);
  assert.ok(paths.includes("in-commit.txt"), "the commit's files are listed");
  assert.ok(paths.includes("new-dirty.txt"), "new dirty paths are listed");
  assert.ok(!paths.includes("wip.txt"), "the pre-dirty path stays excluded");
  s.done();
}

// ============================================================ edge cases
// The five suspected bugs, now fixed in bin/constance-guard.mjs and asserted
// here for real.

// ---- a directory entry in the allowed list covers files INSIDE it: ".constance/"
// aside means a forced add or a tracked .constance file is not "outside the
// list" (inside() now also matches changed paths under an allowed entry).
{
  const s = setup({ exclude: false });
  const b = s.before();
  fs.mkdirSync(path.join(s.repo, ".constance"));
  fs.writeFileSync(path.join(s.repo, ".constance", "done-1.json"), "{}");
  s.git("add", "-f", ".constance/done-1.json");
  const c = s.commit("done file committed");
  const res = checkRun({ dir: s.repo, files: [], commit: c, before: b, env: s.env });
  assert.equal(res.ok, true, ".constance/ aside: " + JSON.stringify(res.violations));
  s.done();
}

// ---- a rename INTO an allowed name still reports the deleted source:
// `git mv evil.txt allowed.txt` changes "allowed.txt" (inside the list) but
// also deletes evil.txt — commitFiles reads --name-status so both sides count.
{
  const s = setup();
  s.write("evil.txt"); s.git("add", "evil.txt"); s.git("commit", "-qm", "base");
  const b = s.before();
  s.git("mv", "evil.txt", "allowed.txt");
  const c = s.commit("sneaky rename");
  const res = checkRun({ dir: s.repo, files: ["allowed.txt"], commit: c, before: b, env: s.env });
  assert.equal(res.ok, false);
  assert.deepEqual(res.badPaths, ["evil.txt"], "the deleted source is flagged even though the destination is allowed");
  s.done();
}
{
  // Same rule uncommitted: a staged rename reports both names in dirtyPaths.
  const s = setup();
  s.write("evil.txt"); s.git("add", "evil.txt"); s.git("commit", "-qm", "base");
  const b = s.before();
  s.git("mv", "evil.txt", "allowed.txt");
  const res = checkRun({ dir: s.repo, files: ["allowed.txt"], commit: "", before: b, env: s.env });
  assert.equal(res.ok, false);
  assert.deepEqual(res.badPaths, ["evil.txt"]);
  s.done();
}

// ---- dirtyPaths returns real filenames verbatim: porcelain -z is unquoted
// and un-split, so a file literally named "x -> y.txt" is not mangled.
{
  const s = setup();
  const b = s.before();
  s.write("x -> y.txt");
  assert.ok(dirtyPaths(s.repo).includes("x -> y.txt"), JSON.stringify(dirtyPaths(s.repo)));
  const res = checkRun({ dir: s.repo, files: [], commit: "", before: b, env: s.env });
  assert.deepEqual(res.badPaths, ["x -> y.txt"], "the real name reaches the violation list");
  s.done();
}

// ---- an untracked directory no longer hides new files next to a
// not-yet-existing allowed file: --untracked-files=all lists src/evil.txt
// itself instead of collapsing to "?? src/".
{
  const s = setup();
  const b = s.before();
  s.write("src/evil.txt"); // src/foo.mjs does not exist yet
  const res = checkRun({ dir: s.repo, files: ["src/foo.mjs"], commit: "", before: b, env: s.env });
  assert.equal(res.ok, false);
  assert.deepEqual(res.badPaths, ["src/evil.txt"]);
  s.done();
}

// ---- newCommits treats a baseHead that is not an ancestor of HEAD as "cannot
// verify": after the history is rewritten, base..HEAD would span ALL of HEAD's
// history, so the answer is [] — nothing is diff-checked or reverted as the
// run's own.
{
  const s = setup();
  const b = s.before();
  s.git("checkout", "-q", "--orphan", "rewritten");
  s.git("commit", "-qm", "fresh root, unrelated to the snapshot");
  assert.deepEqual(newCommits(s.repo, b.head), [], "a non-ancestor base lists nothing");
  const res = checkRun({ dir: s.repo, files: [], commit: "", before: b, env: s.env });
  assert.deepEqual(res.ownCommits, [], "the rewritten history is never the run's");
  s.done();
}

console.log("constance-guard.deep: tests passed");
