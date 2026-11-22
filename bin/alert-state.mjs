// Decides which limit windows need a "passed N%" notification, and what to
// remember. A window alerts once; it is forgotten only when its meter is
// reported back at or below the threshold (or its reset time has long passed).
// A refresh where a meter is simply missing (agent errored, network blip)
// changes nothing, so an outage can never cause a repeat alert.
export const WATCHED = /session|weekly/i;
const PRUNE_AFTER_MS = 24 * 3600 * 1000;

export function planAlerts(agents, before, threshold, now = Date.now()) {
  const memory = { ...(before || {}) };
  const toSend = [];
  // A multi-account agent also alerts per account, named by its label.
  const watched = [];
  for (const a of agents || []) {
    watched.push(a);
    if ((a.accounts || []).length > 1)
      for (const acc of a.accounts) watched.push({ ...a, id: `${a.id}:${acc.id}`, name: `${a.name} (${acc.label})`, limits: acc.limits, accounts: undefined });
  }
  for (const a of watched) {
    for (const l of a.limits || []) {
      if (!WATCHED.test(String(l.title)) || typeof l.percent !== "number") continue;
      const prefix = `${a.id}|${l.title}|`;
      const key = `${prefix}${l.resetsAt || ""}`;
      if (l.percent > threshold) {
        if (!memory[key]) { toSend.push({ agent: a, limit: l, key }); }
      } else {
        for (const k of Object.keys(memory)) if (k.startsWith(prefix)) delete memory[k];
      }
    }
  }
  // Old windows whose reset time passed a day ago can never fire again.
  for (const k of Object.keys(memory)) {
    const reset = Date.parse(k.split("|").slice(2).join("|"));
    if (Number.isFinite(reset) && now - reset > PRUNE_AFTER_MS) delete memory[k];
  }
  return { toSend, memory };
}
