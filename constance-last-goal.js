.pragma library
// Constance's idle panel: a finished goal folds into one "Last goal" line so the
// new-goal box is up front; the full report stays one click away. Pure functions,
// so bin/constance-last-goal.test.mjs runs them in node. Panel.qml imports this
// as LastGoal.

// A goal that ended: done, stopped or failed (not running or paused, not none).
function finished(goal) {
  return !!goal && (goal.status === "done" || goal.status === "stopped" || goal.status === "failed");
}

// "just now", "5 min ago", "3 h ago", "2 d ago"; "" when the time is unknown.
function ago(at, now) {
  var t = Number(at), n = Number(now);
  if (!isFinite(t) || t <= 0 || !isFinite(n)) return "";
  var s = Math.max(0, Math.round((n - t) / 1000));
  if (s < 60) return "just now";
  var m = Math.floor(s / 60);
  if (m < 60) return m + " min ago";
  var h = Math.floor(m / 60);
  if (h < 48) return h + " h ago";
  return Math.floor(h / 24) + " d ago";
}

// The goal's first line, without a leading "1." or "-" marker.
function title(goal) {
  var text = String((goal && goal.text) || "").trim();
  var first = text.split("\n")[0].replace(/^\s*(?:\d+[.)]|[-*])\s+/, "").trim();
  return first || "(no goal text)";
}

// "Done", "Stopped", "Couldn't finish"; a goal that ended needing the owner says so.
function statusWord(goal) {
  if (!goal) return "";
  if (goal.needsOwner && goal.status !== "stopped") return "Needs you";
  return { done: "Done", stopped: "Stopped", failed: "Couldn't finish" }[goal.status] || String(goal.status || "");
}

// "Done · 7/7 · 14 h ago": status, checklist count when there is one, and when it ended.
function summary(goal, done, total, now) {
  if (!finished(goal)) return "";
  var parts = [statusWord(goal)];
  if (Number(total) > 0) parts.push(Number(done) + "/" + Number(total));
  var when = ago(goal.finishedAt, now);
  if (when) parts.push(when);
  return parts.join(" · ");
}

// Color key for the dot: "green" done, "amber" stopped or needs the owner, "red" failed.
function tone(goal) {
  if (!finished(goal)) return "";
  if (goal.needsOwner && goal.status !== "stopped") return "amber";
  return { done: "green", stopped: "amber", failed: "red" }[goal.status];
}

// The full report the goal ended with (her own words), else its fail reason, else "".
function report(goal) {
  if (!goal) return "";
  var r = String(goal.report || "").trim();
  if (r) return r;
  return String(goal.failReason || "").trim();
}
