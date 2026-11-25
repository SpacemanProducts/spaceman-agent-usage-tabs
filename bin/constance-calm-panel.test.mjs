// Constance's screen, calmer: the log starts folded, the big-number tiles stay on
// top, job cards show worker + title + one status word (time/tokens/files/result
// open with the card's detail), and section labels are one or two words. Source-
// level checks on Panel.qml, same style as the other panel tests. Runs against a
// fake HOME in a mktemp folder; nothing touches the real home folder.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "constance-calm-panel-"));
process.env.HOME = home;

const here = path.dirname(fileURLToPath(import.meta.url));
const qml = fs.readFileSync(path.join(here, "..", "Panel.qml"), "utf8");

// The log starts folded and stays folded until its header is clicked.
assert.match(qml, /property bool constanceLogOpen: false/, "the log starts folded");
assert.ok(qml.includes("root.constanceLogOpen = !root.constanceLogOpen"), "the log header still toggles it");
assert.ok(qml.includes("visible: root.constanceLogOpen"), "the log body only shows when open");

// The big-number tiles are still the header of her screen.
assert.ok(qml.includes("id: constanceHead"), "tile row exists");
for (const label of ['label: "done"', 'label: "copies"', 'label: "session"', 'label: "per 1%"'])
  assert.ok(qml.includes(label), `tile ${label} exists`);

// Short labels: the long section names and button are gone.
for (const old of ["GOAL QUEUE", "WAITING ON LIMITS", "ADD A GOAL TO HER QUEUE", "EDIT A QUEUED GOAL", "Give it to Constance"])
  assert.ok(!qml.includes(old), `${old} is gone`);
assert.ok(qml.includes('text: "QUEUE" +'), "queue header is one word");
assert.ok(qml.includes('text: "WAITING"'), "waiting header is one word");
assert.ok(qml.includes('"EDIT GOAL" : (root.constanceActive ? "ADD A GOAL" : "GOAL")'), "goal headers are short");
assert.ok(qml.includes('root.constanceActive ? "Add to queue" : "Start"'), "the go button is one word when free");

// Explanatory sentences that repeated what a number or button already shows.
assert.ok(qml.includes('text: "Nothing queued."'), "empty queue is one line");
assert.ok(!qml.includes("each starts by itself when the one before ends well"), "queue explanation is gone");
assert.ok(!qml.includes("Start next when you're ready."), "paused-queue instruction is gone");
assert.ok(qml.includes('"Nothing yet."'), "empty log is one line");

// Job cards: closed they are worker + title + status word; the meta line and the
// result open with the card (queued cards can't open, so theirs stays visible).
assert.ok(qml.includes("visible: jobCard.open || jobCard.modelData.id === null"), "card meta waits for the detail view");
assert.ok(qml.includes("visible: jobCard.open && text !== \"\""), "card result waits for the detail view");
assert.ok(qml.includes("root.openConstanceCard(jobCard.modelData.id)"), "cards still open their detail");
assert.ok(qml.includes("root.constanceJobReport(root.constanceJobDetail)"), "the detail view still shows the full report");

const opens = (qml.match(/\{/g) || []).length;
const closes = (qml.match(/\}/g) || []).length;
assert.equal(opens, closes, "Panel.qml braces are balanced");

fs.rmSync(home, { recursive: true, force: true });
console.log("constance-calm-panel: all tests passed");
