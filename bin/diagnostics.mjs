// "Data looks wrong": checks collected agent data and records problems in a
// small JSON-lines log instead of failing silently. The tab only shows a
// one-line note; everything else goes to collector.log.
import fs from "node:fs";
import path from "node:path";

const MAX_LOG_LINES = 300;
const REPEAT_MS = 60 * 60 * 1000; // log the same problem at most hourly

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const badTime = (t) => t !== "" && t != null && isNaN(Date.parse(String(t)));

// Sanity checks on one agent's final record. Returns [message, ...].
export function checkAgentData(agent) {
  const out = [];
  if (!agent || typeof agent !== "object") return ["agent record is not an object"];
  if (agent.installed === false) return [];
  if (!Array.isArray(agent.limits)) out.push("limits is not a list");
  for (const l of Array.isArray(agent.limits) ? agent.limits : []) {
    if (!isNum(l?.percent) || l.percent < 0 || l.percent > 1) out.push(`meter "${l?.title}" has percent ${JSON.stringify(l?.percent)} (expected 0 to 1)`);
    if (badTime(l?.resetsAt)) out.push(`meter "${l?.title}" has an unreadable reset time ${JSON.stringify(l?.resetsAt)}`);
  }
  if (!Array.isArray(agent.models)) out.push("models is not a list");
  for (const m of Array.isArray(agent.models) ? agent.models : []) {
    if (!isNum(m?.total) || m.total < 0) out.push(`model "${m?.name}" has token total ${JSON.stringify(m?.total)}`);
  }
  if (!Array.isArray(agent.days)) out.push("days is not a list");
  else {
    // Agents with no token-history source (Kiro, Amp) legitimately have none.
    if (agent.days.length !== 0 && agent.days.length !== 7) out.push(`days has ${agent.days.length} entries (expected 7)`);
    if (agent.days.some((d) => !isNum(d?.tokens) || d.tokens < 0)) out.push("a day has an invalid token count");
  }
  return out;
}

// Collects problems per agent id, then logs (rate limited) and summarizes.
export function createDiagnostics({ logFile, stateFile, now = () => Date.now() } = {}) {
  const problems = new Map(); // id -> [{message, details}]
  const add = (id, message, details) => { if (!problems.has(id)) problems.set(id, []); problems.get(id).push({ message, details }); };
  return {
    add,
    problemsFor: (id) => problems.get(id) || [],
    summary(id) {
      const list = problems.get(id) || [];
      return list.length ? `Data looks wrong (${list.length} problem${list.length === 1 ? "" : "s"}) - see collector.log` : "";
    },
    flush() {
      if (!problems.size || !logFile) return 0;
      let state = {}; try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")) || {}; } catch {}
      const t = now(); const lines = [];
      for (const [id, list] of problems) for (const p of list) {
        const key = `${id}|${p.message}`;
        if (state[key] && t - state[key] < REPEAT_MS) continue;
        state[key] = t;
        lines.push(JSON.stringify({ at: new Date(t).toISOString(), agent: id, problem: p.message, details: p.details ?? null }));
      }
      for (const k of Object.keys(state)) if (t - state[k] > 24 * REPEAT_MS) delete state[k];
      if (lines.length) {
        let existing = []; try { existing = fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean); } catch {}
        const all = existing.concat(lines).slice(-MAX_LOG_LINES);
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        fs.writeFileSync(logFile, all.join("\n") + "\n", { mode: 0o600 });
      }
      try { fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 }); } catch {}
      return lines.length;
    },
  };
}
