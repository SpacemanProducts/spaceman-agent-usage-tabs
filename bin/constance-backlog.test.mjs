// Constance's per-project backlog: an owner-editable markdown file at
// <project>/.constance/backlog.md. Items parse with kind/text/files/job,
// non-item lines survive rewrites byte for byte, adds dedupe open items,
// and mark/remove edit only the item's own line.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KINDS, backlogFile, parseBacklog, readBacklog, addItem, markTaken, markDone, removeItem, openItems, formatItem } from "./constance-backlog.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "constance-backlog-"));

// Missing file: empty reads, no items.
assert.deepEqual(KINDS, ["review", "bug", "design", "task", "test", "docs"]);
assert.equal(backlogFile(dir), path.join(dir, ".constance", "backlog.md"));
assert.deepEqual(readBacklog(dir), []);
assert.deepEqual(openItems(dir), []);

// parseBacklog: kinds, defaults, files and job tags, non-item lines skipped.
const sample = [
  "# Backlog",
  "",
  "Things worth doing when agents have room.",
  "- [ ] review: check the diff before merge",
  "- [x] bug: panel froze on empty data",
  "- [ ] plain line with no kind prefix",
  "- [ ] test: cover the queue handoff (files: a.test.mjs, b.test.mjs)",
  "- [ ] docs: update README (job 7)",
  "- [ ] task: both tags (files: x.mjs) (job 3)",
  "- [ ] task: job first (job 4) (files: y.mjs)",
  "trailing prose stays",
].join("\n");
const items = parseBacklog(sample);
assert.equal(items.length, 7);
assert.deepEqual(items.map((x) => x.id), [1, 2, 3, 4, 5, 6, 7], "ids count item lines only");
assert.deepEqual(items.map((x) => x.line), [3, 4, 5, 6, 7, 8, 9], "line is the index in the file's lines");
assert.equal(items[0].kind, "review"); assert.equal(items[0].text, "check the diff before merge");
assert.equal(items[0].done, false); assert.equal(items[0].job, null); assert.deepEqual(items[0].files, []);
assert.equal(items[1].kind, "bug"); assert.equal(items[1].done, true);
assert.equal(items[2].kind, "task"); assert.equal(items[2].text, "plain line with no kind prefix", "unknown prefix keeps whole text");
assert.equal(items[3].kind, "test"); assert.deepEqual(items[3].files, ["a.test.mjs", "b.test.mjs"]);
assert.equal(items[4].kind, "docs"); assert.equal(items[4].job, 7);
assert.deepEqual(items[5].files, ["x.mjs"]); assert.equal(items[5].job, 3, "files-then-job order");
assert.equal(items[6].job, 4); assert.deepEqual(items[6].files, ["y.mjs"], "job-then-files order");

// addItem creates the folder and a '# Backlog' heading.
assert.throws(() => addItem(dir, { text: "   " }), /needs text/);
assert.throws(() => addItem(dir, { kind: "chore", text: "x" }), /unknown backlog kind/);
const a1 = addItem(dir, { kind: "review", text: "tidy the collectors", files: ["collect.mjs"] });
assert.equal(a1.id, 1); assert.equal(a1.kind, "review"); assert.equal(a1.done, false);
assert.deepEqual(a1.files, ["collect.mjs"]); assert.equal(a1.job, null);
assert.equal(fs.readFileSync(backlogFile(dir), "utf8"), "# Backlog\n- [ ] review: tidy the collectors (files: collect.mjs)\n");

// Default kind is task; appends after existing items.
const a2 = addItem(dir, { text: "no kind given" });
assert.equal(a2.kind, "task"); assert.equal(a2.id, 2);
assert.equal(readBacklog(dir).length, 2);

// Duplicate of an open item (same kind + text) returns the existing one.
const dup = addItem(dir, { kind: "review", text: "tidy the collectors", files: ["other.mjs"] });
assert.equal(dup.id, a1.id);
assert.equal(readBacklog(dir).length, 2, "no duplicate line added");

// A done item does not block a fresh add of the same text.
markDone(dir, a2.id);
const a3 = addItem(dir, { text: "no kind given" });
assert.equal(a3.id, 3, "done items don't dedupe");

// markTaken adds and then replaces the job tag; openItems drops taken/done.
assert.equal(markTaken(dir, a1.id, 12), true);
assert.equal(readBacklog(dir)[0].job, 12);
assert.equal(markTaken(dir, a1.id, 15), true);
assert.equal(readBacklog(dir)[0].job, 15, "earlier job tag replaced");
assert.equal(fs.readFileSync(backlogFile(dir), "utf8").includes("(job 12)"), false);
assert.deepEqual(openItems(dir).map((x) => x.id), [3], "taken and done items are not open");

// markDone flips the checkbox; removeItem deletes only that line.
assert.equal(markDone(dir, a3.id), true);
assert.equal(readBacklog(dir)[2].done, true);
assert.equal(markDone(dir, 999), false, "missing id reports false");
assert.equal(removeItem(dir, a2.id), true);
assert.equal(removeItem(dir, 99), false, "missing id reports false");
const after = parseBacklog(fs.readFileSync(backlogFile(dir), "utf8"));
assert.deepEqual(after.map((x) => x.id), [1, 2], "ids recount after removal");
assert.equal(after[0].line, 1); assert.equal(after[1].line, 2);

// Rewrites keep every non-item line byte for byte.
fs.writeFileSync(backlogFile(dir), [
  "# Backlog",
  "",
  "  indented prose  ",
  "- [ ] task: keep me",
  "- weird - [ ] not an item line",
  "",
].join("\n"));
const before = fs.readFileSync(backlogFile(dir), "utf8");
markTaken(dir, 1, 9);
markDone(dir, 1);
const afterText = fs.readFileSync(backlogFile(dir), "utf8");
assert.deepEqual(afterText.split("\n").filter((l) => !l.startsWith("- [")), before.split("\n").filter((l) => !l.startsWith("- [")), "non-item lines untouched");
assert.ok(afterText.includes("- [x] task: keep me (job 9)"));
assert.ok(afterText.includes("- weird - [ ] not an item line"), "mid-line checkbox is not an item");
assert.equal(removeItem(dir, 1), true);
assert.equal(fs.readFileSync(backlogFile(dir), "utf8"), "# Backlog\n\n  indented prose  \n- weird - [ ] not an item line\n");

// formatItem shows kind, text and files.
assert.equal(formatItem({ kind: "review", text: "tidy", files: ["a.mjs", "b.mjs"] }), "review: tidy (files: a.mjs, b.mjs)");
assert.equal(formatItem({ kind: "task", text: "plain", files: [] }), "task: plain");

fs.rmSync(dir, { recursive: true, force: true });
console.log("constance-backlog: tests passed");
