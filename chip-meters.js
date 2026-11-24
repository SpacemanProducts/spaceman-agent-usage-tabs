.pragma library
// Which meters color a tab chip. Returns {session, weekly} as 0..1 fractions,
// or -1 for "no data". Session = fullest meter titled "session"; weekly =
// fullest titled "weekly"; anything else (monthly, daily, credits) is "other".
// An agent with one meter, or with only one of the pair, uses it for both.
// With neither, the fullest "other" meter stands in for both. A hit limit counts as both.
function chipMeters(agent) {
  var session = -1, weekly = -1, other = -1
  var limits = ((agent && agent.limits) || []).slice()
  // With several accounts the worst meter across all of them colors the chip.
  var accts = (agent && agent.accounts) || []
  for (var a = 0; a < accts.length; a++) limits = limits.concat((accts[a] && accts[a].limits) || [])
  for (var i = 0; i < limits.length; i++) {
    var p = limits[i] ? limits[i].percent : NaN
    if (typeof p !== "number" || !isFinite(p) || p < 0) continue
    var t = String(limits[i].title || "")
    // A full limit (100%), one the agent reported hitting, or a cap that walls the agent off (Grok's free
    // per-model cap) colors both.
    if (p >= 1 || limits[i].hitAt || limits[i].cap) { if (p > session) session = p; if (p > weekly) weekly = p }
    else if (/session/i.test(t)) { if (p > session) session = p }
    else if (/weekly/i.test(t)) { if (p > weekly) weekly = p }
    else if (p > other) other = p
  }
  if (session < 0 && weekly < 0) return { session: other, weekly: other }
  if (session < 0) return { session: weekly, weekly: weekly }
  if (weekly < 0) return { session: session, weekly: session }
  return { session: session, weekly: weekly }
}

// The bar icon's one severity table, shared by every agent: the color and
// whether the percentage label shows come from the same reading, so no agent
// can disagree with its own tab. >= 90% is red and shows the number, >= 60%
// is amber, below that green; nothing reported is neutral (null level).
var BAR_LEVELS = [
  { min: 0.9, color: "red", showPercent: true },
  { min: 0.6, color: "amber", showPercent: false },
  { min: 0, color: "green", showPercent: false }
];
function barLevel(value) {
  if (typeof value !== "number" || !isFinite(value) || value < 0) return null
  for (var i = 0; i < BAR_LEVELS.length; i++) if (value >= BAR_LEVELS[i].min) return BAR_LEVELS[i]
  return null
}

// The worst limit an agent reports — the fullest meter across its accounts —
// as {percent, title}, or percent -1 when it reports nothing. This is the
// reading the bar icon colors and labels from; it matches the fullest limit
// bar in the agent's tab.
function barWorst(agent) {
  var worst = -1, title = ""
  var limits = ((agent && agent.limits) || []).slice()
  var accts = (agent && agent.accounts) || []
  for (var a = 0; a < accts.length; a++) limits = limits.concat((accts[a] && accts[a].limits) || [])
  for (var i = 0; i < limits.length; i++) {
    var p = limits[i] ? limits[i].percent : NaN
    if (typeof p !== "number" || !isFinite(p) || p < 0) continue
    if (p > worst) { worst = p; title = String(limits[i].title || "") }
  }
  return { percent: worst, title: title }
}
