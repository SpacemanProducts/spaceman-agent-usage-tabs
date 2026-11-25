// Kilo (opencode-based) free-model guard for Constance worker runs.
// Kilo bills per token for paid models; a Constance copy must only ever run a
// model we KNOW is free, and must fail the job if the run reports otherwise.
// Rules (unknown is never free):
//  - id "kilo-auto/free", or ending ":free" / "/free"  -> free
//  - a models-cache entry (~/.cache/kilo/models.json shape) whose cost.input
//    and cost.output are both 0 AND which is explicitly tagged free -> free
//  - anything else -> not free
// kiloArgs() builds the headless `kilo run` argv (verified against
// `kilo run --help` on kilo 7.8.32: -m/--model provider/model,
// --format json for raw events, --auto to approve permissions).
// costCheck() scans the JSON event stream and reports the first sign of a
// paid model or a non-zero cost so the job can be failed instead of billed.

const FREE_ID = /(^|[/])free$|:free$/i;

function tagFree(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.free === true) return true;
  for (const key of ["tag", "tags", "labels"]) {
    const v = entry[key];
    const list = Array.isArray(v) ? v : v == null ? [] : [v];
    if (list.some((t) => typeof t === "string" && t.trim().toLowerCase() === "free")) return true;
  }
  return false;
}

function zeroCost(entry) {
  const c = entry?.cost;
  if (!c || typeof c !== "object") return false;
  return Number(c.input) === 0 && Number(c.output) === 0 &&
    Number.isFinite(Number(c.input)) && Number.isFinite(Number(c.output));
}

// id: "provider/model" string. entry: optional models-cache model object.
export function isFreeModel(id, entry) {
  if (typeof id !== "string" || !id.trim()) return false;
  const norm = id.trim().toLowerCase();
  if (norm === "kilo-auto/free" || FREE_ID.test(norm)) return true;
  return zeroCost(entry) && tagFree(entry);
}

function itemId(item) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return null;
  if (typeof item.id === "string") return item.id;
  if (typeof item.modelID === "string")
    return item.providerID ? `${item.providerID}/${item.modelID}` : item.modelID;
  return null;
}

// list: strings, {id, entry?}, or {providerID, modelID} objects.
// Returns the chosen model id (string) or null.
export function pickFreeModel(list) {
  const items = (Array.isArray(list) ? list : []).map((item) => {
    const id = itemId(item);
    if (!id) return null;
    const entry = item && typeof item === "object" ? (item.entry ?? (item.cost ? item : undefined)) : undefined;
    return { id, entry };
  }).filter(Boolean);
  const auto = items.find((i) => i.id.toLowerCase() === "kilo-auto/free");
  if (auto) return auto.id;
  const free = items.find((i) => isFreeModel(i.id, i.entry));
  return free ? free.id : null;
}

// Headless args for `kilo run`. Throws on anything not provably free.
export function kiloArgs(prompt, model) {
  const id = typeof model === "string" ? model : itemId(model);
  const entry = model && typeof model === "object" ? model.entry : undefined;
  if (!isFreeModel(id, entry)) throw new Error(`kilo model "${id ?? model}" is not a known free model`);
  return ["run", "--format", "json", "--auto", "-m", id, String(prompt)];
}

function* records(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 8) return;
  yield obj;
  for (const v of Object.values(obj)) if (v && typeof v === "object") yield* records(v, depth + 1);
}

// Scans kilo run --format json output (one JSON event per line, but tolerant
// of a single pretty-printed doc). Returns {paid:true, reason} on the first
// non-free model or cost > 0, else null.
export function costCheck(outputText) {
  for (const line of String(outputText || "").split("\n")) {
    const t = line.trim();
    if (!t || (t[0] !== "{" && t[0] !== "[")) continue;
    let events;
    try { events = JSON.parse(t); } catch { continue; }
    for (const ev of Array.isArray(events) ? events : [events]) {
      for (const r of records(ev)) {
        if (typeof r.modelID === "string" && r.modelID) {
          const id = r.providerID ? `${r.providerID}/${r.modelID}` : r.modelID;
          if (!isFreeModel(id)) return { paid: true, reason: `non-free model ${id}` };
        }
        if (typeof r.cost === "number" && Number.isFinite(r.cost) && r.cost > 0)
          return { paid: true, reason: `cost ${r.cost} reported` };
      }
    }
  }
  return null;
}
