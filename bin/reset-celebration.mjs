// The reset celebration: when a session or weekly meter fell by more than 50
// points since the last refresh, flag the agent (`resetAt`) so the panel flashes
// its chip green and plays the confetti burst, and send one silent notification.
import { detectResets } from "./reset-detect.mjs";

export const FLASH_MS = 10000;

export function resetNotice(agent, windows) {
  return {
    title: `${agent.name} reset. Go cook.`,
    body: `\u{1F4B8} ${windows.join(" and ")} limit${windows.length > 1 ? "s" : ""} reset`,
  };
}

// notify-send arguments for the desktop notification box: the cash-burst picture
// (the renderer shows a sender image in full colour), silent from the daemon's
// side because the cha-ching is played separately, in sync, by us.
export function resetNotifyArgs(notice, imagePath) {
  const args = ["-a", "Agent Usage Tabs", "-u", "normal", "-i", "emblem-ok-symbolic",
    "-h", "boolean:suppress-sound:true", "-h", "string:category:presence"];
  if (imagePath) args.push("-h", `string:image-path:${imagePath}`);
  return [...args, notice.title, notice.body];
}

// Mutates `agents` (adds resetAt / resetWindows). `notify(agent, windows)` is
// called once per detected reset.
export function applyResets(agents, prevAgents, notify, now = Date.now()) {
  const prev = new Map((Array.isArray(prevAgents) ? prevAgents : []).filter((a) => a && a.id).map((a) => [a.id, a]));
  for (const a of agents || []) {
    const before = prev.get(a.id);
    const windows = detectResets(before?.limits, a.limits);
    if (windows.length) {
      a.resetAt = now;
      a.resetWindows = windows;
      notify(a, windows);
    } else if (before?.resetAt && now - before.resetAt < FLASH_MS + 5000) {
      // A refresh that lands inside an in-progress flash keeps it alive.
      a.resetAt = before.resetAt;
      a.resetWindows = before.resetWindows || [];
    }
  }
}
