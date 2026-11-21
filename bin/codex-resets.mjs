// Codex "full reset" credits, as the Codex login exposes them: the usage record
// carries resetCredits {available, nextExpiresAt} only when the account holds
// at least one. Each one refreshes the 5-hour and weekly windows and moves the
// weekly reset date. Returns {left, expiresAt} or null.
export function codexResets(record) {
  const c = record?.resetCredits;
  if (!c || typeof c !== "object") return null;
  const left = Number(c.available);
  if (!Number.isInteger(left) || left <= 0) return null;
  const ms = Date.parse(c.nextExpiresAt || "");
  return { left, usableNow: true, expiresAt: Number.isFinite(ms) ? new Date(ms).toISOString() : "" };
}
