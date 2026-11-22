.pragma library
// Which meters color a tab chip. Returns {session, weekly} as 0..1 fractions,
// or -1 for "no data". Session = fullest meter titled "session"; weekly =
// fullest titled "weekly"; anything else (monthly, daily, credits) is "other".
// An agent with one meter, or with only one of the pair, uses it for both.
// With neither, the fullest "other" meter stands in for both.
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
    if (/session/i.test(t)) { if (p > session) session = p }
    else if (/weekly/i.test(t)) { if (p > weekly) weekly = p }
    else if (p > other) other = p
  }
  if (session < 0 && weekly < 0) return { session: other, weekly: other }
  if (session < 0) return { session: weekly, weekly: weekly }
  if (weekly < 0) return { session: session, weekly: session }
  return { session: session, weekly: weekly }
}
