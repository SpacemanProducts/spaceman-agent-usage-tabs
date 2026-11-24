// Constance's log as plain text, for the panel's "Copy all": every entry in log.jsonl, oldest first,
// with its date and time, the same headings the panel shows, and practice prompts in full.
const pad = (n) => String(n).padStart(2, "0");

export function stamp(at) {
  const d = new Date(Number(at) || 0);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function entryText(e, nameOf = (id) => id) {
  const who = e.agent ? (e.worker || nameOf(e.agent)) + (e.account ? ` (${e.account})` : "") : "";
  const head = {
    goal: "Goal", handoff: `Job ${e.job} → ${who}`, practice: `Practice job ${e.job} → ${who}${e.reason ? ` (${e.reason})` : ""}`,
    returned: `Job ${e.job} back from ${who}`, held: `Job ${e.job} → ${who} (held)`, model: "Model",
    review: `Job ${e.job}${e.verdict === "accept" ? " accepted" : " sent back"}`, report: "Report", paused: "Paused",
    signal: "Signal", queue: "Queue", resumed: "Resumed", stopped: "Stopped", failed: "Failed", note: "Note", lesson: "Lesson",
  }[e.kind] || e.kind || "Entry";
  let line = `${stamp(e.at)}  ${head}${e.text ? ": " + e.text : ""}`;
  if (e.kind === "practice" && e.worktree) line += `\n(a real run works in ${e.worktree} on ${e.branch || "its own branch"})`;
  if (e.prompt) line += "\n" + String(e.prompt);
  return line;
}

export function logText(entries, nameOf) {
  return (entries || []).map((e) => entryText(e, nameOf)).join("\n\n") + "\n";
}
