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

// The bar icon's reading of an agent: {value, session, weekly, other, otherTitle}.
// `value` is the worst of the session and weekly meters — whichever is closer to
// running out — through the same chipMeters rules the tab chip colors from, so
// the bar and the tab can never disagree; -1 when the agent reports nothing.
// session and weekly are only the real meters titled that way (-1 = not
// reported), so the tooltip never invents one. When `value` is driven by a
// meter of another kind (a cap, monthly, credits) `other`/`otherTitle` carry it
// so the tooltip can name what is actually maxed out. The panel colors `value`
// with the same meterColorFor thresholds the tab's limit bars use.
function barReadings(agent) {
  var m = chipMeters(agent)
  var session = -1, weekly = -1, other = -1, otherTitle = ""
  var limits = ((agent && agent.limits) || []).slice()
  var accts = (agent && agent.accounts) || []
  for (var a = 0; a < accts.length; a++) limits = limits.concat((accts[a] && accts[a].limits) || [])
  for (var i = 0; i < limits.length; i++) {
    var p = limits[i] ? limits[i].percent : NaN
    if (typeof p !== "number" || !isFinite(p) || p < 0) continue
    var t = String(limits[i].title || "")
    if (/session/i.test(t)) { if (p > session) session = p }
    else if (/weekly/i.test(t)) { if (p > weekly) weekly = p }
    else if (p > other) { other = p; otherTitle = t }
  }
  return { value: Math.max(m.session, m.weekly), session: session, weekly: weekly, other: other, otherTitle: otherTitle }
}
