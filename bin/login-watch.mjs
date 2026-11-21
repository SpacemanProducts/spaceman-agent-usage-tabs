// One-time "now available" notice: the first time an agent whose tab is hidden
// gets a login. `signedIn` is true/false when the collector could tell, null
// when the agent has no login concept (never notifies).
// Hidden = the user hid it while it was installed, or it isn't installed and
// the "hide uninstalled" switch is on.
//
// `seen` remembers every agent ever seen signed in, so a notice fires at most
// once per agent. The very first run (seen === null) is a silent baseline:
// everyone already signed in is recorded without a notification.
export function isHidden(agent, { hiddenAgents = [], hideUninstalled = true } = {}) {
  const installed = agent.installed !== false;
  return installed ? hiddenAgents.includes(agent.id) : hideUninstalled;
}

export function planLoginNotices(agents, settings, seen) {
  const baseline = seen === null || seen === undefined || typeof seen !== "object";
  const next = baseline ? {} : { ...seen };
  const notify = [];
  for (const a of agents || []) {
    if (a.signedIn !== true || next[a.id]) continue;
    next[a.id] = true;
    if (!baseline && isHidden(a, settings)) notify.push(a);
  }
  return { notify, seen: next };
}

// One-time notice when an agent that was hidden because it wasn't installed is
// now installed and its tab reappears. Compares the previous refresh with this
// one. Nothing fires if "hide uninstalled" is off (the tab was already showing),
// if the user hid the tab by choice (it stays hidden), on the first run (no
// previous data), or for an agent already announced. `notified` is the memory.
export function planInstallNotices(prevAgents, agents, settings, notified) {
  const had = new Map((Array.isArray(prevAgents) ? prevAgents : []).filter((a) => a && a.id).map((a) => [a.id, a]));
  const memory = notified && typeof notified === "object" ? { ...notified } : {};
  const hiddenAgents = (settings && settings.hiddenAgents) || [];
  const hideUninstalled = !settings || settings.hideUninstalled !== false;
  const notify = [];
  for (const a of agents || []) {
    const before = had.get(a.id);
    if (!before || before.installed !== false || a.installed === false) continue; // not a not-installed -> installed flip
    if (memory[a.id]) continue;
    if (!hideUninstalled || hiddenAgents.includes(a.id)) continue;
    memory[a.id] = true;
    notify.push(a);
  }
  return { notify, notified: memory };
}
