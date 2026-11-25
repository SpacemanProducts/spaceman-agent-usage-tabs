// Deeper edge-case pass on the per-project backlog (bin/constance-backlog.mjs),
// complementing constance-backlog.test.mjs. Covers malformed inputs, checkbox
// and kind/tag parsing boundaries, dedupe and tag-replacement corners, and
// filesystem edge cases (missing file, file-as-directory, no trailing newline,
// leftover tmp files). Suspected bugs are commented out with a note, not fixed
// (this job is test-only). The module only touches <dir>/.constance/backlog.md;
// the fake HOME under mktemp is a guard so nothing can ever touch the real one.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KINDS, backlogFile, parseBacklog, readBacklog, addItem, markTaken, markDone, removeItem, openItems, formatItem } from "./constance-backlog.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "constance-backlog-deep-"));
process.env.HOME = path.join(tmp, "home");
fs.mkdirSync(process.env.HOME, { recursive: true });
const dir = path.join(tmp, "project");

// ---------- parseBacklog: malformed and empty inputs ----------

assert.deepEqual(parseBacklog(null), [], "null text parses to no items");
assert.deepEqual(parseBacklog(undefined), [], "undefined text parses to no items");
assert.deepEqual(parseBacklog(42), [], "a number has no item lines");
assert.deepEqual(parseBacklog({}), [], "an object stringifies to '[object Object]'");
assert.deepEqual(parseBacklog(""), [], "empty text");
assert.deepEqual(parseBacklog("\n\n\n"), [], "blank lines only");
assert.deepEqual(parseBacklog("no items here\njust prose\n"), [], "prose is skipped, not an error");

// ---------- parseBacklog: checkbox shape ----------

// Uppercase X counts as done, same as lowercase x.
assert.equal(parseBacklog("- [X] task: done thing\n")[0].done, true, "[X] is done");
// Only space, x and X are valid marks: '-' and '?' lines are not items.
assert.deepEqual(parseBacklog("- [-] task: nope\n- [?] task: nope2\n"), [], "other checkbox chars are not items");
assert.deepEqual(parseBacklog("- [] task: nope\n"), [], "empty brackets are not an item");
assert.deepEqual(parseBacklog("- [  ] task: nope\n"), [], "two spaces inside brackets are not an item");
// A space is required between ']' and the body.
assert.deepEqual(parseBacklog("- [ ]task: no space\n"), [], "no space after ']' is not an item");
// Leading whitespace breaks the anchor.
assert.deepEqual(parseBacklog("  - [ ] task: indented\n\t- [ ] task: tabbed\n"), [], "indented items do not parse");
// '* [ ]' is not the item's bullet.
assert.deepEqual(parseBacklog("* [ ] task: star\n"), [], "'*' bullet is not an item");
// An item marker mid-line is prose.
assert.deepEqual(parseBacklog("see - [ ] task: inline\n"), [], "mid-line marker is not an item");
// A trailing space with an empty body still parses, as an empty-text item.
const emptyBody = parseBacklog("- [ ] \n");
assert.equal(emptyBody.length, 1);
assert.equal(emptyBody[0].kind, "task");
assert.equal(emptyBody[0].text, "");
assert.equal(emptyBody[0].done, false);
// A bare '- [ ]' with no trailing space is not an item at all.
assert.deepEqual(parseBacklog("- [ ]\n"), [], "no space after ']' means no item");

// ---------- parseBacklog: kind prefix boundaries ----------

// Kind matching is case-sensitive and requires '[a-z]+' then ':' then whitespace.
assert.equal(parseBacklog("- [ ] Bug: capital\n")[0].kind, "task", "capitalised kind is not a kind");
assert.equal(parseBacklog("- [ ] bug : space before colon\n")[0].kind, "task");
assert.equal(parseBacklog("- [ ] bug:x\n")[0].kind, "task", "no space after colon keeps whole text");
assert.equal(parseBacklog("- [ ] bug:x\n")[0].text, "bug:x");
assert.equal(parseBacklog("- [ ] bug:\n")[0].kind, "task", "colon with no body is not a kind prefix");
assert.equal(parseBacklog("- [ ] bug:\n")[0].text, "bug:");
assert.equal(parseBacklog("- [ ] bug:\tTabbed body\n")[0].kind, "bug", "a tab counts as the separating whitespace");
assert.equal(parseBacklog("- [ ] bug:\tTabbed body\n")[0].text, "Tabbed body");
// 'task' is itself a known kind, so its prefix is stripped like any other.
assert.equal(parseBacklog("- [ ] task: explicit\n")[0].kind, "task");
assert.equal(parseBacklog("- [ ] task: explicit\n")[0].text, "explicit");
// A non-ASCII 'kind' never matches [a-z]+.
assert.equal(parseBacklog("- [ ] café: unicode\n")[0].kind, "task");
// Every known kind round-trips through the prefix form.
for (const kind of KINDS) {
  const it = parseBacklog(`- [ ] ${kind}: body text\n`)[0];
  assert.equal(it.kind, kind, `${kind}: prefix parses`);
  assert.equal(it.text, "body text");
}

// ---------- parseBacklog: files/job tag boundaries ----------

// '(job 0)' parses as job 0, which is !== null so the item is not open.
const jobZero = parseBacklog("- [ ] task: x (job 0)\n")[0];
assert.equal(jobZero.job, 0);
// Negative, decimal and non-numeric job tags are not stripped; they stay in the text.
for (const tag of ["(job -3)", "(job 1.5)", "(job abc)", "(job)", "(job 5 )"]) {
  const it = parseBacklog(`- [ ] task: x ${tag}\n`)[0];
  assert.equal(it.job, null, `${tag} is not a job tag`);
  assert.ok(it.text.endsWith(tag), `${tag} stays in the text`);
}
// A huge job number still parses (Number() handles it).
assert.equal(parseBacklog("- [ ] task: x (job 999999999999)\n")[0].job, 999999999999);
// A job tag mid-text is not a tag; only a trailing one counts.
const midJob = parseBacklog("- [ ] task: fix (job 5) later\n")[0];
assert.equal(midJob.job, null);
assert.equal(midJob.text, "fix (job 5) later");
// Two job tags: every trailing tag is stripped, and the last one wins.
const twoJobs = parseBacklog("- [ ] task: x (job 5) (job 6)\n")[0];
assert.equal(twoJobs.job, 6);
assert.equal(twoJobs.text, "x");
// An item that is only a kind prefix plus tags keeps the bare prefix as text
// (the kind regex needs a non-empty body after the colon).
const onlyTags = parseBacklog("- [ ] task: (job 5)\n")[0];
assert.equal(onlyTags.job, 5);
assert.equal(onlyTags.text, "task:");
// '(files:)' with no entries is not stripped.
const emptyFiles = parseBacklog("- [ ] task: x (files:)\n")[0];
assert.equal(emptyFiles.job, null);
assert.equal(emptyFiles.text, "x (files:)");
const spaceFiles = parseBacklog("- [ ] task: x (files: )\n")[0];
assert.equal(spaceFiles.text, "x (files: )", "a lone space inside files: is still content");
// Files split on commas, trim each entry, and drop empties.
const messyFiles = parseBacklog("- [ ] task: x (files: a.mjs , ,b.mjs,  )\n")[0];
assert.deepEqual(messyFiles.files, ["a.mjs", "b.mjs"]);
// Interleaved files/job groups strip in any order; repeated files groups merge in order.
const interleaved = parseBacklog("- [ ] task: x (files: a.mjs) (job 9) (files: b.mjs)\n")[0];
assert.deepEqual(interleaved.files, ["a.mjs", "b.mjs"]);
assert.equal(interleaved.job, 9);
assert.equal(interleaved.text, "x");
// A parenthesised note that is not a known tag stays in the text.
const note = parseBacklog("- [ ] task: ship it (needs review)\n")[0];
assert.equal(note.text, "ship it (needs review)");
assert.deepEqual(note.files, []);
// Filenames containing commas cannot be expressed; the split is unconditional.
assert.deepEqual(parseBacklog("- [ ] task: x (files: a,b.mjs)\n")[0].files, ["a", "b.mjs"]);

// ---------- readBacklog / openItems on odd files ----------

// A file that is a directory reads as empty rather than throwing.
const dirAsFile = path.join(tmp, "dirfile");
fs.mkdirSync(path.join(dirAsFile, ".constance"), { recursive: true });
fs.mkdirSync(backlogFile(dirAsFile));
assert.deepEqual(readBacklog(dirAsFile), [], "backlog.md as a directory reads empty");
assert.deepEqual(openItems(dirAsFile), []);
// ...but writing through it fails, since rename cannot replace a directory.
assert.throws(() => addItem(dirAsFile, { text: "x" }));

// Edits on a project with no backlog file at all report false.
const fresh = path.join(tmp, "fresh");
assert.equal(markDone(fresh, 1), false);
assert.equal(markTaken(fresh, 1, 3), false);
assert.equal(removeItem(fresh, 1), false);

// ---------- addItem: text and files argument edges ----------

// Whitespace-only text is refused; text is trimmed before storing.
assert.throws(() => addItem(dir, { text: " \t " }), /needs text/);
const trimmed = addItem(dir, { text: "  padded item  " });
assert.equal(trimmed.text, "padded item", "stored text is trimmed");
assert.ok(fs.readFileSync(backlogFile(dir), "utf8").includes("- [ ] task: padded item\n"), "no padding written");
// 'files' must be an array; a bare string throws a TypeError.
assert.throws(() => addItem(dir, { text: "x", files: "a.mjs" }), TypeError);
// Non-string file entries are stringified before the empty filter, so null/false survive as "null"/"false".
const weirdFiles = addItem(dir, { text: "weird files", files: [null, false, "", 0, "ok.mjs"] });
assert.deepEqual(weirdFiles.files, ["null", "false", "0", "ok.mjs"]);
// A file that exists but has no '# Backlog' heading gets no heading added — only a missing file does.
const noHeading = path.join(tmp, "noheading");
fs.mkdirSync(path.join(noHeading, ".constance"), { recursive: true });
fs.writeFileSync(backlogFile(noHeading), "- [ ] task: preexisting\n");
addItem(noHeading, { text: "appended" });
const noHeadingText = fs.readFileSync(backlogFile(noHeading), "utf8");
assert.ok(!noHeadingText.includes("# Backlog"), "no heading is invented for an existing file");
assert.ok(noHeadingText.endsWith("- [ ] task: appended\n"));
// A file without a trailing newline still gets the new item on its own line.
const noNewline = path.join(tmp, "nonewline");
fs.mkdirSync(path.join(noNewline, ".constance"), { recursive: true });
fs.writeFileSync(backlogFile(noNewline), "- [ ] task: first");
const nn = addItem(noNewline, { text: "second" });
assert.equal(nn.line, 1, "appended item lands on the next line index");
assert.equal(fs.readFileSync(backlogFile(noNewline), "utf8"), "- [ ] task: first\n- [ ] task: second\n");
// A whitespace-only file is not treated as missing: no heading, item appended after the blank.
const wsOnly = path.join(tmp, "wsonly");
fs.mkdirSync(path.join(wsOnly, ".constance"), { recursive: true });
fs.writeFileSync(backlogFile(wsOnly), "\n");
const ws = addItem(wsOnly, { text: "after blank" });
assert.equal(ws.line, 1);
assert.equal(fs.readFileSync(backlogFile(wsOnly), "utf8"), "\n- [ ] task: after blank\n");
// Writes are atomic: no '.<pid>.tmp' file is left behind.
assert.deepEqual(fs.readdirSync(path.join(dir, ".constance")).filter((f) => f.endsWith(".tmp")), [], "no tmp leftovers");
// Re-adding after a removal reuses the next free id (ids recount from items.length).
removeItem(dir, trimmed.id);
const readded = addItem(dir, { text: "brand new" });
assert.equal(readded.id, readBacklog(dir).length, "id is items.length + 1 at add time");

// ---------- addItem: dedupe corners ----------

// An item already handed to a job (not done) still blocks a duplicate add:
// the dedupe check only looks at done/kind/text, not job. Documented behaviour.
const taken = addItem(dir, { text: "in flight" });
markTaken(dir, taken.id, 42);
const dupTaken = addItem(dir, { kind: "task", text: "in flight" });
assert.equal(dupTaken.id, taken.id, "a taken-but-open item still dedupes");
assert.equal(readBacklog(dir).filter((x) => x.text === "in flight").length, 1);
// Dedupe is exact: different kind, different text, or extra whitespace does not match.
addItem(dir, { kind: "bug", text: "same words" });
const sameTextOtherKind = addItem(dir, { kind: "task", text: "same words" });
assert.notEqual(sameTextOtherKind.kind, "bug");
assert.equal(readBacklog(dir).filter((x) => x.text === "same words").length, 2, "kind is part of the dedupe key");
// A done duplicate does not block (covered in the first test); a taken one does — see above.
// Text that differs only by a trailing job/files tag is a different string at add time.
const tagged = addItem(dir, { text: "watch this (job 3)" });
assert.equal(tagged.job, null, "the returned item reports what was asked, not the re-parse");

// SUSPECTED BUG (not fixed, test-only job): the line just written is
// '- [ ] task: watch this (job 3)', which parseBacklog reads back with
// job=3 — so the item is immediately excluded from openItems() even though
// addItem returned job:null. User text ending in '(job N)' (or '(files: ...)')
// is silently reinterpreted as a tag.
//
// assert.ok(openItems(dir).some((x) => x.id === tagged.id));
// -> currently fails: openItems() does NOT contain tagged.id.
//
// Same class of issue: markTaken() accepts any jobId and returns true even when
// the tag can never parse, e.g. markTaken(dir, id, "abc") writes '(job abc)'.
// And a CRLF backlog parses to zero items entirely ('.' never matches '\r', so
// ITEM_RE fails on every line): readBacklog/openItems see an empty file and
// addItem can then append LF lines and duplicate "invisible" items.
//
// assert.deepEqual(parseBacklog("- [ ] task: a\r\n- [x] bug: b\r\n").length, 2);
// -> currently fails: returns [].
//
// assert.equal(markTaken(dir, taken.id, "abc"), false);
// -> currently fails: returns true and leaves an unparseable '(job abc)' tag.

// ---------- markTaken / markDone / removeItem: line surgery ----------

// markDone is idempotent: marking an already-done item returns true and changes nothing.
const d = addItem(dir, { text: "done twice" });
markDone(dir, d.id);
const beforeDone = fs.readFileSync(backlogFile(dir), "utf8");
assert.equal(markDone(dir, d.id), true);
assert.equal(fs.readFileSync(backlogFile(dir), "utf8"), beforeDone, "second markDone is a no-op");
// markTaken works on a done item too (editItem does not check done).
assert.equal(markTaken(dir, d.id, 77), true);
assert.equal(readBacklog(dir).find((x) => x.text === "done twice").job, 77);
// markTaken on an item whose text ends in a fake mid-string '(job N)' appends a real tag.
const fakeTag = addItem(dir, { text: "see (job 5) details" });
markTaken(dir, fakeTag.id, 8);
const fakeParsed = readBacklog(dir).find((x) => x.id === fakeTag.id || x.text.includes("see (job 5)"));
assert.equal(fakeParsed.job, 8);
assert.ok(fakeParsed.text.includes("(job 5)"), "the mid-text tag stays in the text");
// markTaken replaces only a real trailing tag, never a mid-text one.
const realTaken = addItem(dir, { text: "real tag" });
markTaken(dir, realTaken.id, 3);
markTaken(dir, realTaken.id, 4);
const rt = readBacklog(dir).find((x) => x.text === "real tag");
assert.equal(rt.job, 4);
assert.equal(rt.text.includes("(job 3)"), false, "old trailing tag fully replaced");
// removeItem on the last remaining line leaves a valid (possibly heading-only) file.
const solo = path.join(tmp, "solo");
fs.mkdirSync(path.join(solo, ".constance"), { recursive: true });
addItem(solo, { text: "only item" });
assert.equal(removeItem(solo, 1), true);
assert.deepEqual(readBacklog(solo), []);
// The '# Backlog' heading survives the removal.
assert.equal(fs.readFileSync(backlogFile(solo), "utf8"), "# Backlog\n");

// ---------- formatItem ----------

assert.equal(formatItem({ kind: "bug", text: "crash", files: ["a.mjs"] }), "bug: crash (files: a.mjs)");
assert.equal(formatItem({ kind: "docs", text: "readme" }), "docs: readme");
// files undefined is tolerated; a job tag is never shown.
assert.equal(formatItem({ kind: "task", text: "x", files: undefined, job: 9 }), "task: x");
assert.equal(formatItem({ kind: "task", text: "x", job: 9 }), "task: x", "job is not part of the format");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("constance-backlog.deep: tests passed");
