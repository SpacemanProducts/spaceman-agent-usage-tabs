// Cursor's dashboard (GetCurrentPeriodUsage) can say 0% while Cursor's own CLI stops a turn with
// "You've hit your usage limit" (checked 2026-11-23: a Free account, 0% and no usage events on the
// dashboard, yet the turn ended with that error). The CLI records the end of every turn in its
// transcript under ~/.cursor/projects/<project>/agent-transcripts/<id>/<id>.jsonl as
//   {"type":"turn_ended","status":"error","error":"You've hit your usage limit ..."}
// Transcripts hold no tokens and no timestamps, so the file's modification time is the hit time.
// The "Auto · 44.7%" in Cursor's status bar is not a usage meter: it is the context window fill
// (contextUsagePercent in the CLI), so it is never used here.
// A wall stays up until a later turn ends without that error, or until the meters' reset.
// Read-only. Returns a limit row (cap: true), or null when no wall is standing.
import fs from "node:fs"; import path from "node:path";

const LIMIT = /usage limit/i;

function lastTurn(file) {
  let text; try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
  let turn = null;
  for (const line of text.split("\n")) {
    if (!line.includes("turn_ended")) continue;
    try { const d = JSON.parse(line); if (d.type === "turn_ended") turn = d; } catch {}
  }
  return turn;
}

export function cursorWall(projectsDir, nowMs = Date.now(), { resetsAt = "" } = {}) {
  let hit = 0, ok = 0, message = "";
  let dirs = []; try { dirs = fs.readdirSync(projectsDir); } catch { return null; }
  for (const p of dirs) {
    const root = path.join(projectsDir, p, "agent-transcripts");
    let ids = []; try { ids = fs.readdirSync(root); } catch { continue; }
    for (const id of ids) {
      const file = path.join(root, id, `${id}.jsonl`);
      let mtime; try { mtime = fs.statSync(file).mtimeMs; } catch { continue; }
      const t = lastTurn(file);
      if (!t) continue;
      if (t.status === "error" && LIMIT.test(String(t.error || ""))) { if (mtime > hit) { hit = mtime; message = String(t.error); } }
      else if (t.status !== "error" && mtime > ok) ok = mtime;   // another kind of error proves nothing
    }
  }
  if (!hit || ok > hit) return null;                                  // never hit, or a later turn went through
  const reset = Date.parse(resetsAt);
  if (Number.isFinite(reset) && nowMs >= reset) return null;           // the meters have reset since
  const at = new Date(hit).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return { title: "Cursor limit", cap: true, percent: 1, resetsAt: Number.isFinite(reset) ? new Date(reset).toISOString() : "", hitAt: new Date(hit).toISOString(),
    note: `Cursor stopped a task at ${at}: "${message.replace(/\s*Get Cursor Pro.*$/i, "").trim()}" Its dashboard still shows 0%, so this is the only sign.` };
}
