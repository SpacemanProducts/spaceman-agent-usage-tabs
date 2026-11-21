// The reset celebration: when a session or weekly meter fell by more than 50
// points since the last refresh, flag the agent (`resetAt`) so the panel flashes
// its chip green and plays the confetti burst, and send one silent notification.
import { classifyResets, windowPhrase, magnitudeOf } from "./reset-detect.mjs";

export const FLASH_MS = 10000;

// Agents that get a surprise celebration: an early drop on them can only be the
// provider resetting meters (there is no banked reset the user could have spent),
// so it is celebrated separately. The WORDING is honest: we can see our own meter
// drop early, not what happened to everyone. Only when agyresets.com has a matching
// announcement (info.confirmed) may the message say everyone was reset.
export const SURPRISE_AGENTS = {
  antigravity: {
    honest: (phrase) => `Antigravity ${phrase} reset came early, go cook.`,
    confirmed: (phrase) => `Google just reset everyone's ${phrase} limit${phrase.includes(" and ") ? "s" : ""}, go cook.`,
  },
};

const clock = (iso) => { const d = new Date(iso); return isNaN(d.getTime()) ? "" : d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); };

// info = { kind: "surprise" | "scheduled", details: [{title, surprise, dueAt}], confirmed?: <agyresets announcement> }
export function resetNotice(agent, windows, info) {
  const copy = SURPRISE_AGENTS[agent.id];
  if (info?.kind === "surprise" && copy) {
    const early = (info.details || []).filter((d) => d.surprise);
    const titles = early.map((d) => d.title).join(" and ");
    const due = early.map((d) => Date.parse(d.dueAt)).filter(Number.isFinite).sort((a, b) => a - b)[0];
    if (info.confirmed) {
      const by = info.confirmed.source?.author ? ` by @${info.confirmed.source.author}` : "";
      return { title: copy.confirmed(windowPhrase(early.map((d) => d.title))), body: `\u26A1 ${titles} reset early. Announced${by} (via agyresets.com)` };
    }
    return { title: copy.honest(windowPhrase(early.map((d) => d.title))), body: `\u26A1 ${titles} reset early${due ? ` - it wasn't due until ${clock(new Date(due).toISOString())}` : ""}. No announcement found.` };
  }
  return {
    title: `${agent.name} ${windowPhrase(windows)} reset, go cook.`,
    body: `\u{1F4B8} ${windows.join(" and ")} limit${windows.length > 1 ? "s" : ""} reset`,
  };
}

// The picture and the sound for a kind of reset. A surprise gets its own pair.
export function resetAssets(kind) {
  return kind === "surprise"
    ? { image: "surprise-burst.svg", sound: "jackpot.wav" }
    : { image: "cash-burst.svg", sound: "cha-ching.wav" };
}

// notify-send arguments for the desktop notification box: the cash-burst picture
// (the renderer shows a sender image in full colour), silent from the daemon's
// side because the cha-ching is played separately, in sync, by us.
export function resetNotifyArgs(notice, imagePath) {
  const args = ["-a", "Cook Meter", "-u", "normal", "-i", "emblem-ok-symbolic",
    "-h", "boolean:suppress-sound:true", "-h", "string:category:presence"];
  if (imagePath) args.push("-h", `string:image-path:${imagePath}`);
  return [...args, notice.title, notice.body];
}

// Mutates `agents` (adds resetAt / resetWindows / resetKind / resetDetails).
// `notify(agent, windows, info)` is called once per detected reset. The kind is
// "surprise" only for agents in SURPRISE_AGENTS, and only when a meter dropped
// before its recorded reset time; everything else is "scheduled".
export function applyResets(agents, prevAgents, notify, now = Date.now()) {
  const prev = new Map((Array.isArray(prevAgents) ? prevAgents : []).filter((a) => a && a.id).map((a) => [a.id, a]));
  for (const a of agents || []) {
    const before = prev.get(a.id);
    const details = classifyResets(before?.limits, a.limits, now);
    if (details.length) {
      const windows = details.map((d) => d.title);
      const kind = SURPRISE_AGENTS[a.id] && details.some((d) => d.surprise) ? "surprise" : "scheduled";
      a.resetAt = now;
      a.resetWindows = windows;
      a.resetKind = kind;
      a.resetMagnitude = magnitudeOf(windows);
      a.resetPhrase = windowPhrase(windows);
      a.resetDetails = details;
      notify(a, windows, { kind, details });
    } else if (before?.resetAt && now - before.resetAt < FLASH_MS + 5000) {
      // A refresh that lands inside an in-progress flash keeps it alive.
      a.resetAt = before.resetAt;
      a.resetWindows = before.resetWindows || [];
      a.resetKind = before.resetKind || "scheduled";
      a.resetMagnitude = before.resetMagnitude || 1;
      a.resetPhrase = before.resetPhrase || "";
      a.resetDetails = before.resetDetails || [];
    }
  }
}
