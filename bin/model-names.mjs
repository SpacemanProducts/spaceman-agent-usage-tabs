// Friendly names for raw model ids an agent reports (Antigravity especially): background worker
// models are grouped into one "Background workers" row, the "unknown" bucket becomes
// "Unlabeled usage", and other raw ids read like names ("gemini-3.8-flash-high" -> "Gemini 3.8 Flash High").
// Rows that already have a name from models.json or the agent's live list are left alone.
const SUM = ["input", "output", "cacheRead", "cacheWrite", "total"];
const isRaw = (r) => /^[a-z0-9][a-z0-9._-]*$/.test(String(r.name || "")) && /[-_]/.test(r.name);
const ACRONYMS = { gpt: "GPT", oss: "OSS", agy: "Antigravity" };
export const prettyId = (id) => String(id).split(/[-_]+/).filter(Boolean)
  .reduce((out, w) => { if (/^\d+$/.test(w) && /^\d+(\.\d+)?$/.test(out.at(-1) || "") && !out.at(-1).includes(".")) out[out.length - 1] += "." + w; else out.push(w); return out; }, [])
  .map((w) => ACRONYMS[w] || (/^\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1))).join(" ");

export function friendlyModels(rows, agentName = "the agent") {
  const out = [], workers = [];
  for (const r of rows || []) {
    const id = String(r.id || r.name || "");
    if (/^unknown$/i.test(String(r.name || ""))) out.push({ ...r, name: "Unlabeled usage", tip: `${agentName} didn't name the model for these tokens.` });
    else if (/worker/i.test(id) && isRaw(r)) workers.push(r);
    else out.push(isRaw(r) ? { ...r, name: prettyId(r.name), rawId: r.name } : r);
  }
  if (workers.length) {
    const g = { name: "Background workers", id: "background-workers", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, state: "zero", removing: "",
      tip: `Models ${agentName} runs in the background: ${workers.map((w) => w.name).join(", ")}.` };
    for (const w of workers) for (const k of SUM) g[k] += Number(w[k]) || 0;
    if (g.total > 0) g.state = "used";
    out.push(g);
  }
  const rank = { used: 0, zero: 1, unavailable: 2 };
  return out.map((r, i) => ({ r, i })).sort((a, b) => rank[a.r.state] - rank[b.r.state] || (a.r.state === "used" ? b.r.total - a.r.total : a.i - b.i)).map((x) => x.r);
}
