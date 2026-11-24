// Constance's goal checklist: the goal split into its items, and which of them are done.
//
// Items are the goal's numbered or bulleted lines ("1. ...", "2) ...", "- ...", "* ...", "• ..."). An
// indented line right after an item continues it; any other line (a preamble, or a closing line such as
// "Tests for each, commit.") is not an item. A goal with no list is one item: the whole goal.
//
// She tags each handoff with the item(s) it is for (`delegate --item 2`), and can tick an item she did
// herself (`check 2`). An item is done when she ticked it, or when at least one of its jobs was merged
// (accepted) and none of its jobs is still open or stuck on a merge conflict. Nothing is guessed: a job
// with no item tag only counts when the goal has a single item.

const ITEM = /^(?:(\d{1,2})[.)]|[-*•])\s+(.*\S)\s*$/;

export function parseItems(text = "") {
  const lines = String(text).split(/\r?\n/);
  const items = [];
  let open = false;
  for (const line of lines) {
    const m = line.match(ITEM);
    if (m && !/^\s/.test(line)) { items.push(m[2]); open = true; continue; }
    if (open && /^\s+\S/.test(line)) { items[items.length - 1] += " " + line.trim(); continue; }
    open = false;
  }
  if (items.length < 2) return [String(text).trim().replace(/\s+/g, " ")].filter(Boolean);
  return items;
}

// "2" / "1,3" / [2] -> [2] / [1, 3] (1-based item numbers, deduped, sorted).
export function parseItemArg(v) {
  const list = Array.isArray(v) ? v : String(v ?? "").split(/[,\s]+/);
  return [...new Set(list.map(Number).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
}

const OPEN = new Set(["waiting", "held", "running", "finished"]);
const isPractice = (j) => String(j.summary || "").startsWith("(practice run");

// The job's item numbers for this goal (single-item goals own every job).
export function jobItems(j, count) {
  const tagged = parseItemArg(j.items || []).filter((n) => n <= count);
  if (tagged.length) return tagged;
  return count === 1 ? [1] : [];
}

// [{ n, text, state: done|working|review|problem|todo, by: "jobs"|"constance"|"", jobs: [ids] }] + progress.
export function checklist(goal, jobs = []) {
  if (!goal) return { items: [], done: 0, total: 0, line: "" };
  const texts = Array.isArray(goal.items) && goal.items.length ? goal.items : parseItems(goal.text);
  const mine = jobs.filter((j) => !j.goal || j.goal === goal.id);
  const checked = goal.checked || {};
  const items = texts.map((text, i) => {
    const n = i + 1;
    const js = mine.filter((j) => jobItems(j, texts.length).includes(n));
    const ids = js.map((j) => j.id);
    let state = "todo", by = "";
    const merged = js.some((j) => j.status === "accepted" && !isPractice(j));
    const open = js.filter((j) => OPEN.has(j.status));
    if (checked[n] !== undefined) { state = "done"; by = "constance"; }
    else if (js.some((j) => j.status === "conflict")) state = "problem";
    else if (merged && !open.length) { state = "done"; by = "jobs"; }
    else if (open.some((j) => j.status === "finished")) state = "review";
    else if (open.length) state = "working";
    return { n, text, state, by, note: checked[n] ? String(checked[n]) : "", jobs: ids };
  });
  const done = items.filter((x) => x.state === "done").length;
  return { items, done, total: items.length, line: `${done} of ${items.length} done` };
}
