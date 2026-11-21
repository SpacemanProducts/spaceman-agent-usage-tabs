// Plan / free-tier info from what each tool itself reports. Pure parsers
// (tested against real output) plus a cached runner. Nothing here invents a
// number: if a tool reports nothing, the result is empty and the tab shows
// nothing extra.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const clamp01 = (n) => Math.max(0, Math.min(1, n));
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Kiro: `kiro-cli chat --no-interactive "/usage"`
//   Estimated Usage | resets on 2026-12-01 | KIRO FREE
//   Credits (0.02 of 50 covered in plan), 0.0%
export function parseKiroUsage(out) {
  const head = String(out).match(/Estimated Usage\s*\|\s*resets on (\d{4}-\d{2}-\d{2})\s*\|\s*([^\n]+)/i);
  const cr = String(out).match(/Credits \(([\d.,]+) of ([\d.,]+)/i);
  if (!head && !cr) return null;
  const num = (s) => Number(String(s).replace(/,/g, ""));
  const plan = head ? head[2].trim().replace(/^kiro\s+/i, "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : "";
  const info = { plan, limits: [] };
  if (cr && num(cr[2]) > 0) {
    info.limits.push({ title: "Credits", percent: clamp01(num(cr[1]) / num(cr[2])), resetsAt: head ? `${head[1]}T00:00:00Z` : "", detail: `${cr[1]} of ${cr[2]}` });
  }
  return info;
}

// Amp: `amp usage`. Only the sign-in and a daily allowance (if Amp reports one)
// are used; purchased credit balances are deliberately ignored.
export function parseAmpUsage(out) {
  const text = String(out);
  if (!/Signed in as/i.test(text)) return null;
  const daily = text.match(/(?:daily[^\n$]*|[^\n$]*per day[^\n$]*)\$([\d,.]+)[^\n]*/i);
  return { signedIn: true, note: daily ? `Daily allowance $${daily[1]}` : "" };
}

// Hermes: `hermes status`. Returns {loggedIn, freeTier} for Nous Portal.
export function parseHermesStatus(out) {
  const text = String(out);
  const nous = text.match(/Nous Portal\s+(✓ logged in|✗ not logged in)/);
  if (!nous) return null;
  return { loggedIn: nous[1].startsWith("✓"), freeTier: /no usable paid credits/i.test(text) };
}

const RUNNERS = {
  kiro: { cmd: ["kiro-cli", "chat", "--no-interactive", "/usage"], parse: parseKiroUsage },
  amp: { cmd: ["amp", "usage"], parse: parseAmpUsage },
  hermes: { cmd: ["hermes", "status"], parse: parseHermesStatus },
};
const TTL_MS = 30 * 60 * 1000;

// Runs the tool (headless), cached 30 min; keeps the last good answer on failure.
export function planInfo(agentId, { env, stateDir, now = Date.now(), run = defaultRun, onUnexpected } = {}) {
  const spec = RUNNERS[agentId];
  if (!spec) return null;
  const file = path.join(stateDir, "plan-info.json");
  let cache = {}; try { cache = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch {}
  const hit = cache[agentId];
  if (hit && now - hit.at < TTL_MS) return hit.info ?? null;
  const raw = run(spec.cmd, env);
  const info = spec.parse(raw);
  if (!info && raw.trim() && !/not (logged|signed) in|not authenticated|log ?in|sign ?in|only available for/i.test(raw) && onUnexpected)
    onUnexpected("usage output didn't match the expected format", { command: spec.cmd.join(" "), head: raw.slice(0, 200) });
  if (info) { cache[agentId] = { at: now, info }; try { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(cache)); } catch {} return info; }
  return hit?.info ?? null;
}

function defaultRun(cmd, env) {
  const e = { ...env }; delete e.DISPLAY; delete e.WAYLAND_DISPLAY;
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8", env: e, timeout: 45000, stdio: ["ignore", "pipe", "ignore"] });
  return String(r.stdout || "");
}
