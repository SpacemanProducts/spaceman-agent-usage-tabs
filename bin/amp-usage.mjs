// Amp's usage, from `amp usage --details` (a documented status command; it asks Amp for the signed-in account's trailing
// 7 days). The ONLY number this panel takes from it is the token total: the same output also reports a credit balance and
// recorded cost in dollars, which are money the user could be charged, so they are never read or shown.
import { spawnSync } from "node:child_process";

export function parseAmpUsage(text) {
  const t = String(text || "");
  const m = t.match(/Total tokens:\s*([\d,]+)/i);
  const tokens = m && /\d/.test(m[1]) ? Number(m[1].replace(/,/g, "")) : null;
  const range = t.match(/Range:\s*(\S+)\s+to\s+(\S+)/i);
  const days = range ? Math.round((Date.parse(range[2]) - Date.parse(range[1])) / 86400000) : null;
  if (tokens === null || !Number.isFinite(tokens)) return { tokens: null, status: "" };
  const fmt = tokens >= 1e6 ? `${(tokens / 1e6).toFixed(1)}M` : tokens >= 1e3 ? `${(tokens / 1e3).toFixed(1)}K` : String(tokens);
  return { tokens, status: `Last ${days && days > 0 ? days + " days" : "7 days"}: ${fmt} tokens (from \`amp usage\`).` };
}

export function readAmpUsage({ env = process.env, timeoutMs = 30000 } = {}) {
  const r = spawnSync("amp", ["usage", "--details"], { encoding: "utf8", env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  if (r.error || r.status !== 0) return { tokens: null, status: "" };
  return parseAmpUsage(r.stdout);
}
