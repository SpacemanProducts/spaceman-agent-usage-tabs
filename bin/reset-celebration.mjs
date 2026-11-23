// The reset celebration: when a session or weekly meter fell by more than 50
// points since the last refresh, flag the agent (`resetAt`) so the panel flashes
// its chip green and plays the confetti burst, and send one silent notification.
import { classifyResets, windowPhrase, magnitudeOf } from "./reset-detect.mjs";

export const FLASH_MS = 10000;
const SAME_WINDOW_MS = 5 * 60 * 1000;   // reset times of one window wobble by seconds
const NO_TIME_GAP_MS = 60 * 60 * 1000;  // without a reset time, one celebration per meter per hour at most
const FIRED_KEEP_MS = 3 * 24 * 3600 * 1000;

// Agents that get a surprise celebration: an early drop on them can only be the
// provider resetting meters (there is no banked reset the user could have spent),
// so it is celebrated separately. The WORDING is honest: we can see our own meter
// drop early, not what happened to everyone. Only when agyresets.com has a matching
// announcement (info.confirmed) may the message say everyone was reset.
// Claude joined on 2026-11-23 at the owner's request: a Claude meter that drops before its due time is a banked reset
// being spent (or Anthropic resetting), and is celebrated the same way. No announcement source exists for it, so the
// wording is always the honest one.
export const SURPRISE_AGENTS = {
  claude: {
    honest: (phrase) => `Claude ${phrase} reset came early, go cook.`,
  },
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
    if (info.confirmed && copy.confirmed) {   // only agents with an announcement source (Antigravity)
      const by = info.confirmed.source?.author ? ` by @${info.confirmed.source.author}` : "";
      return { title: copy.confirmed(windowPhrase(early.map((d) => d.title))), body: `\u26A1 ${titles} reset early. Announced${by} (via agyresets.com)` };
    }
    return { title: copy.honest(windowPhrase(early.map((d) => d.title))), body: `\u26A1 ${titles} reset early${due ? ` - it wasn't due until ${clock(new Date(due).toISOString())}` : ""}. No announcement found.` };
  }
  // With several accounts the notice names the ones that reset.
  const who = (info?.accounts || []).length ? ` (${info.accounts.join(", ")})` : "";
  return {
    title: `${agent.name}${who} ${windowPhrase(windows)} reset, go cook.`,
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
  const args = ["-a", "Cook Meter", "-t", "8000", "-u", "normal", "-i", "emblem-ok-symbolic",
    "-h", "boolean:suppress-sound:true", "-h", "string:category:presence"];
  if (imagePath) args.push("-h", `string:image-path:${imagePath}`);
  return [...args, notice.title, notice.body];
}

// Mutates `agents` (adds resetAt / resetWindows / resetKind / resetDetails).
// `notify(agent, windows, info)` is called once per detected reset. The kind is
// "surprise" only for agents in SURPRISE_AGENTS, and only when a meter dropped
// before its recorded reset time; everything else is "scheduled".
// Once per reset: a window that already celebrated must not celebrate again (a meter that flickers, a restart, a
// duplicate detection). `fired` is a plain object the caller saves between runs: "agent|meter" -> { endMs, at }, where
// endMs is when the window that just ended was due to reset (its previous resetsAt), if known.
function newReset(fired, key, prevLimits, title, now) {
  const prevIso = (Array.isArray(prevLimits) ? prevLimits : []).find((l) => l && l.title === title)?.resetsAt;
  const endMs = Number.isFinite(Date.parse(prevIso || "")) ? Date.parse(prevIso) : null;
  const rec = fired[key];
  if (rec) {
    if (endMs && rec.endMs && Math.abs(endMs - rec.endMs) <= SAME_WINDOW_MS) return false;
    if (!endMs && now - rec.at < NO_TIME_GAP_MS) return false;
  }
  fired[key] = { endMs, at: now };
  return true;
}
function pruneFired(fired, now) {
  for (const k of Object.keys(fired)) if (!fired[k] || now - fired[k].at > FIRED_KEEP_MS) delete fired[k];
}

export function applyResets(agents, prevAgents, notify, now = Date.now(), fired = {}) {
  pruneFired(fired, now);
  const prev = new Map((Array.isArray(prevAgents) ? prevAgents : []).filter((a) => a && a.id).map((a) => [a.id, a]));
  for (const a of agents || []) {
    const before = prev.get(a.id);
    let details, accounts = [];
    if ((a.accounts || []).length > 1) {
      // Several accounts: each is compared with its own previous meters.
      details = [];
      const prevAcc = new Map((before?.accounts || []).map((x) => [x.id, x]));
      for (const acc of a.accounts) {
        const prevLimits = prevAcc.get(acc.id)?.limits;
        const d = classifyResets(prevLimits, acc.limits, now).filter((x) => newReset(fired, `${a.id}:${acc.id}|${x.title}`, prevLimits, x.title, now));
        if (d.length) { accounts.push(acc.label); details.push(...d); }
      }
    } else details = classifyResets(before?.limits, a.limits, now).filter((x) => newReset(fired, `${a.id}|${x.title}`, before?.limits, x.title, now));
    if (details.length) {
      const windows = details.map((d) => d.title);
      const kind = SURPRISE_AGENTS[a.id] && details.some((d) => d.surprise) ? "surprise" : "scheduled";
      a.resetAt = now;
      a.resetWindows = windows;
      a.resetKind = kind;
      a.resetMagnitude = magnitudeOf(windows);
      a.resetPhrase = windowPhrase(windows);
      a.resetDetails = details;
      a.resetAccounts = accounts;
      notify(a, windows, { kind, details, accounts });
    } else if (before?.resetAt && now - before.resetAt < FLASH_MS + 5000) {
      // A refresh that lands inside an in-progress flash keeps it alive.
      a.resetAt = before.resetAt;
      a.resetWindows = before.resetWindows || [];
      a.resetKind = before.resetKind || "scheduled";
      a.resetMagnitude = before.resetMagnitude || 1;
      a.resetPhrase = before.resetPhrase || "";
      a.resetDetails = before.resetDetails || [];
      a.resetAccounts = before.resetAccounts || [];
    }
  }
}
