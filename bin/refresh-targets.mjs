// Which Omarchy usage collectors to refresh on our schedule.
//
// Codex and Grok are our `builtin` agents, so their Omarchy records — which
// carry every registered account's limits — refresh with the rest. Claude is
// NOT a builtin (we read its OAuth usage ourselves for the seated login), but
// once the owner registers extra Claude accounts, Omarchy's usage-claude
// record is the only place those accounts' meters live. Refresh it too when
// its account registry exists, or secondary accounts go stale.
import fs from "node:fs";
import path from "node:path";

// builtinIds: the `builtin` field of installed agents. accountsDir:
// <state>/omarchy/agents/accounts. Returns builtinIds plus "claude" when a
// Claude account registry exists (deduped, order preserved).
export function refreshTargets(builtinIds, accountsDir, exists = fs.existsSync) {
  const ids = [...builtinIds];
  if (exists(path.join(accountsDir, "claude.json")) && !ids.includes("claude")) ids.push("claude");
  return ids;
}
