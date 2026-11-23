import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons
import qs.Ui
import "chip-meters.js" as ChipMeters
import "tab-order.js" as TabOrder
import "fixes.js" as Fixes

// Cook Meter (plugin id spaceman.agent-usage-tabs). Display only: bin/collect.mjs writes data.json, this file
// watches it. Written from scratch; shares no code or state with other plugins.
Panel {
  id: root
  moduleName: "spaceman.agent-usage-tabs"
  ipcTarget: "spaceman.agent-usage-tabs"
  manageIpc: false

  // Everything follows the active Omarchy theme live: text, background and border come from the
  // theme's popup colors, icons from its accent. Nothing here is a fixed color except the meter and
  // celebration palettes below, which have a dark-background and a light-background variant.
  readonly property color foreground: Color.popups.text
  readonly property color panelBackground: Color.popups.background
  // Secondary text: the text color pulled toward the background (works on dark and light themes).
  readonly property color dim: Qt.tint(foreground, Qt.rgba(panelBackground.r, panelBackground.g, panelBackground.b, 0.4))
  readonly property color track: Style.selectedFillFor(foreground, Color.accent)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  // Meter colors: green < 60%, amber 60-85%, red > 85%.
  // Each has a bright set for dark backgrounds and a deeper set for light ones (all >= 4.8:1
  // against #fff, #eff1f5 and #fffcf0, and >= 4.8:1 for the bright set against #101315).
  function isLightColor(c) { return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b > 0.55 }
  readonly property bool lightPanel: isLightColor(panelBackground)
  readonly property bool lightBar: isLightColor(Color.bar.background)
  function greenFor(light) { return light ? "#1b7a31" : "#4caf50" }
  function amberFor(light) { return light ? "#9a5b00" : "#f2a900" }
  function redFor(light) { return light ? "#c0262d" : "#e5484d" }
  readonly property color green: greenFor(lightPanel)
  readonly property color amber: amberFor(lightPanel)
  readonly property color red: redFor(lightPanel)
  function soft(c, a) { return Qt.rgba(c.r, c.g, c.b, a) }
  function meterColorFor(p, light) { return p > 0.85 ? redFor(light) : (p >= 0.6 ? amberFor(light) : greenFor(light)) }
  function meterColor(p) { return meterColorFor(p, lightPanel) }
  // A reading the collector couldn't confirm is current and complete never shows green: it shows gray
  // ("unsure"). Amber and red still show, since a high reading is a real warning either way.
  readonly property color unsureColor: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.45)
  function tintFor(p, unsure) { return unsure && p < 0.6 ? unsureColor : meterColor(p) }
  // The whole file is unsure when the collector hasn't written it for three refreshes.
  property double dataGeneratedAt: 0
  readonly property bool dataStale: dataGeneratedAt > 0 && nowMs - dataGeneratedAt > 3 * Math.max(60, Number(setting("refreshIntervalSec", 300))) * 1000
  function unsureReason(a) {
    if (dataStale) return "Not updated since " + Qt.formatDateTime(new Date(dataGeneratedAt), "h:mm AP") + "; readings may be out of date."
    return a && a.unsure ? String(a.unsure) : ""
  }
  // Celebration colors: bright and white-heavy on dark themes, deeper (no white) on light ones.
  readonly property color gold: lightPanel ? "#b8860b" : "#ffd700"
  readonly property var surpriseConfetti: lightPanel
    ? ["#b8860b", "#d70015", "#c25400", "#b8860b", "#1f8a3b", "#008a82", "#0062cc", "#8e3bbf", foreground, "#b8860b"]
    : ["#ffd700", "#ff3b30", "#ff9500", "#ffd700", "#34c759", "#00c7be", "#0a84ff", "#bf5af2", "#ffffff", "#ffd700"]
  readonly property var scheduledConfetti: lightPanel
    ? ["#1b7a31", "#9a5b00", foreground, "#2f9a47", "#b8860b", "#c0262d"]
    : ["#4caf50", "#f2a900", "#ffffff", "#7fdc8a", "#ffd54f", "#e5484d"]
  readonly property var surpriseSparkles: lightPanel ? [foreground, "#b8860b", "#8a6a00"] : ["#ffffff", "#ffd700", "#fff0a0"]
  readonly property var scheduledSparkles: lightPanel ? [foreground, "#9a5b00", "#1b7a31"] : ["#ffffff", "#ffd54f", "#7fdc8a"]

  readonly property string home: Quickshell.env("HOME") || ""
  readonly property string dataPath: (Quickshell.env("XDG_STATE_HOME") || home + "/.local/state") + "/omarchy/agent-usage-tabs/data.json"
  readonly property string pluginDir: String(Qt.resolvedUrl(".")).replace(/^file:\/\//, "").replace(/\/$/, "")

  property var rawAgents: []
  // The panel's own settings.json (written by the gear switches) overrides the
  // matching shell.json setting. Missing -> the shell.json value -> the default.
  property var userSettings: ({})
  readonly property bool hideUninstalled: userSettings.hideUninstalledAgents !== undefined
    ? userSettings.hideUninstalledAgents !== false : root.setting("hideUninstalledAgents", true) !== false
  readonly property var hiddenAgents: Array.isArray(userSettings.hiddenAgents) ? userSettings.hiddenAgents : []
  property bool settingsOpen: false
  property string pluginVersion: ""
  readonly property bool autoOpenOnReset: userSettings.autoOpenOnReset !== undefined
    ? userSettings.autoOpenOnReset !== false : root.setting("autoOpenOnReset", true) !== false
  // True while the panel is open because of a reset (not because the user opened
  // it): it takes no keyboard focus and closes itself after ~5 s.
  property bool autoOpened: false
  property var lastResetSeen: ({})
  property bool resetsPrimed: false
  // Opens the panel on this agent's tab for a reset, without stealing focus.
  // If the user already has the panel open, it only switches to that tab.
  function autoCelebrate(id) {
    if (!autoOpenOnReset) return
    var shown = false
    for (var i = 0; i < agents.length; i++) if (agents[i].id === id) shown = true
    if (!shown) return                               // that tab is hidden: respect it
    selectedId = id; daysOpen = false; modelsExpanded = false; settingsOpen = false
    if (opened) return                               // the user's own panel: leave it open
    autoOpened = true
    open()
    autoCloseTimer.restart()
  }
  readonly property bool resetSound: userSettings.resetSound !== undefined
    ? userSettings.resetSound !== false : root.setting("resetSound", true) !== false
  readonly property int resetVolume: {
    var v = userSettings.resetVolume !== undefined ? Number(userSettings.resetVolume) : Number(root.setting("resetVolume", 60))
    return isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : 60
  }
  // Handoff notes: not decided yet (undefined) = ask the first time; true = write them; false = never.
  readonly property bool handoffNote: userSettings.handoffNote === true
  readonly property bool handoffUndecided: userSettings.handoffNote === undefined
  property var handoffPending: null
  FileView {
    path: (Quickshell.env("XDG_STATE_HOME") || root.home + "/.local/state") + "/omarchy/agent-usage-tabs/handoff-pending.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: { try { root.handoffPending = JSON.parse(String(text() || "")) } catch (e) { root.handoffPending = null } }
    onLoadFailed: root.handoffPending = null
  }
  Process { id: handoffAnswerer; running: false }
  // Allow / Not now / Never: the collector wrote nothing; this answers its question.
  function answerHandoff(action) {
    if (action === "allow") writeSetting(["handoffNote", "true"])
    if (action === "never") writeSetting(["handoffNote", "false"])
    handoffAnswerer.command = ["node", pluginDir + "/bin/handoff-answer.mjs", action === "allow" ? "allow" : "dismiss"]
    handoffAnswerer.running = true
    handoffPending = null
  }
  // The bar robot looks angry (theme red) while the default agent is at 100%.
  readonly property bool angryRobot: userSettings.angryRobot !== undefined
    ? userSettings.angryRobot !== false : root.setting("angryRobot", true) !== false
  property bool testAngry: false   // set for 8 s by the testAngry IPC hook, to check the look in the real bar
  readonly property bool robotAngry: angryRobot && (barValue >= 1 || testAngry)
  Timer { id: testAngryTimer; interval: 8000; onTriggered: root.testAngry = false }
  readonly property bool resetAnimation: userSettings.resetAnimation !== undefined
    ? userSettings.resetAnimation !== false : root.setting("resetAnimation", true) !== false
  // Settings (the gear), + (add an account), >_ (start the default agent) and CS (Claude Squad) each open as their own screen: the chips and usage are
  // hidden and the header has a Back button. Only one is open at a time.
  readonly property bool subView: squadOpen || addOpen || settingsOpen || agentHereOpen
  function leaveSubView() { squadOpen = false; addOpen = false; settingsOpen = false; agentHereOpen = false }
  function openSettings() { settingsOpen = true; squadOpen = false; addOpen = false; agentHereOpen = false }
  readonly property bool showDetail: !!agent && !settingsOpen && !subView
  // An agent with two or more accounts lists each one instead of a single set of limits.
  readonly property bool hasAccounts: !!agent && Array.isArray(agent.accounts) && agent.accounts.length > 1
  // A tab shows when its agent is installed and the user hasn't hidden it, or
  // when it isn't installed and "hide uninstalled" is off. A manual hide only
  // counts while the agent is installed, so a newly installed agent appears on
  // its own unless the user hid it earlier while it was installed.
  function isShownTab(a) {
    return a.installed !== false ? hiddenAgents.indexOf(a.id) < 0 : !hideUninstalled
  }
  function writeSetting(args) {
    settingsWriter.command = ["node", root.pluginDir + "/bin/settings-set.mjs"].concat(args)
    settingsWriter.running = true
  }
  readonly property var defaultOrder: ["claude", "antigravity", "grok", "codex", "copilot", "cursor", "opencode", "kimi", "kiro", "devin", "amp"]
  // The tab order: the one you saved (drag a chip), else `tabOrder` from
  // shell.json, else the default. Agents that are in none of those (new ones) go at the end.
  // A reorder shows at once (pendingOrder) and is dropped when the saved settings.json is read back.
  property var pendingOrder: null
  readonly property var wantedOrder: {
    var v = pendingOrder !== null ? pendingOrder : (userSettings.tabOrder !== undefined ? userSettings.tabOrder : root.setting("tabOrder", ""))
    var list = Array.isArray(v) ? v : String(v).toLowerCase().split(",")
    return list.map(function(x) { return String(x).trim() }).filter(function(x) { return x !== "" })
  }
  // Every agent in order, shown or not (the gear menu lists these); `agents` is the visible subset.
  readonly property var allOrdered: {
    var byId = {}, ids = []
    rawAgents.forEach(function(a) { byId[a.id] = a; ids.push(a.id) })
    return TabOrder.ordered(ids, wantedOrder, defaultOrder).map(function(id) { return byId[id] })
  }
  readonly property var agents: allOrdered.filter(function(a) { return isShownTab(a) })
  function allIds() { return allOrdered.map(function(a) { return a.id }) }
  function saveOrder(ids) { pendingOrder = ids; writeSetting(["order", ids.join(",")]) }
  function resetOrder() { pendingOrder = defaultOrder.slice(); writeSetting(["order", "reset"]) }
  // A chip was released after being dragged (dx, dy) from where it sat: it lands on the chip nearest
  // to where it was let go (the gaps between chips count as the nearest one), and the order is saved.
  function dropChip(fromIndex, dx, dy) {
    var me = chipRepeater.itemAt(fromIndex)
    if (!me) return -1
    var cx = me.x + me.width / 2 + dx, cy = me.y + me.height / 2 + dy
    var to = fromIndex, best = 1e12
    for (var i = 0; i < chipRepeater.count; i++) {
      var c = chipRepeater.itemAt(i)
      if (!c) continue
      var d = Math.pow(c.x + c.width / 2 - cx, 2) + Math.pow(c.y + c.height / 2 - cy, 2)
      if (d < best) { best = d; to = i }
    }
    if (to !== fromIndex) dropTab(me.modelData.id, to)
    return to
  }
  // Dragging a chip onto another one's place: reorder the visible tabs, hidden ones keep their slots.
  function dropTab(id, toVisibleIndex) {
    var vis = agents.map(function(a) { return a.id })
    saveOrder(TabOrder.mergeVisible(allIds(), TabOrder.moveTo(vis, id, toVisibleIndex)))
  }

  // ---- The first tab is Omarchy's default agent (so the shortcut and right-click start it).
  // bin/default-agent.mjs sets it when the first position changes; unsupported or uninstalled agents are skipped.
  readonly property string firstId: agents.length > 0 ? agents[0].id : ""
  readonly property bool firstInstalled: agents.length > 0 && !!agents[0].cli
  readonly property var defaultNames: ({ claude: "claude", antigravity: "agy", grok: "grok", codex: "codex", copilot: "copilot", cursor: "cursor-agent",
    opencode: "opencode", kimi: "kimi", kiro: "kiro-cli", devin: "devin", amp: "amp",
    qwen: "qwen", dsh: "dsh", mcode: "mcode" })
  property string currentDefault: ""
  function isDefaultAgent(a) { return !!a && currentDefault !== "" && defaultNames[a.id] === currentDefault }
  // The bar number follows only the default agent (the first tab until Omarchy's default is known):
  // its session usage, or its weekly when that is higher. -1 when it reports neither.
  readonly property var barAgent: {
    for (var i = 0; i < rawAgents.length; i++) if (isDefaultAgent(rawAgents[i])) return rawAgents[i]
    return agents.length > 0 ? agents[0] : null
  }
  readonly property string defaultAgentName: barAgent && barAgent.name ? barAgent.name : "the default agent"
  readonly property real barValue: {
    if (!barAgent) return -1
    var m = ChipMeters.chipMeters(barAgent)
    return Math.max(m.session, m.weekly)
  }
  onFirstIdChanged: applyDefault()
  onFirstInstalledChanged: applyDefault()
  function applyDefault() {
    if (firstId === "" || defaultNames[firstId] === undefined) return
    defaultSetter.command = ["node", pluginDir + "/bin/default-agent.mjs", firstId].concat(firstInstalled ? ["installed"] : [])
    defaultSetter.running = true
  }
  Process { id: defaultSetter; running: false }
  FileView {
    path: root.home + "/.config/omarchy/defaults/agent"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.currentDefault = String(text() || "").trim()
    onLoadFailed: root.currentDefault = ""
  }
  property string selectedId: ""
  property bool daysOpen: false
  property double nowMs: Date.now()
  // A chip flashes green for 10 s after the collector records a reset for it.
  readonly property int flashMs: 10000
  property double flashNow: Date.now()
  // A test celebration (the gear's button) is local to the panel: it never
  // touches the collector's data.
  property var testResets: ({})
  function resetTimeOf(a) { return a ? Math.max(Number(a.resetAt || 0), Number(testResets[a.id] || 0)) : 0 }
  function isFlashing(a) { return !!a && resetTimeOf(a) > 0 && flashNow - resetTimeOf(a) < flashMs }
  // A test can fire either kind: "scheduled" (the normal 5-hour/weekly reset) or
  // "surprise" (an unscheduled early reset). Each has its own look, sound and text.
  property var testKinds: ({})
  function resetKindOf(a) {
    if (!a) return "scheduled"
    var t = testKinds[a.id]
    if (t && t.at >= Number(a.resetAt || 0)) return t.kind
    return a.resetKind || "scheduled"
  }
  // Fires the whole celebration on one agent's chip: confetti and the flash
  // (animation switch), the sound (sound switch), and a notification.
  // How big a window's celebration is: a session (or daily) reset is the baseline, a
  // weekly one a bit bigger, a monthly one bigger still (the bigger the window, the bigger the win).
  function magnitudeForWindow(win) { return win === "monthly" ? 1.5 : win === "weekly" ? 1.25 : 1 }
  function magnitudeOf(a) {
    if (!a) return 1
    var t = testKinds[a.id]
    if (t && t.at >= Number(a.resetAt || 0)) return t.magnitude
    return Number(a.resetMagnitude || 1)
  }
  // A Test reset button: back to the main view first (the celebration plays on the chips), then
  // fire it on the next frame so the whole animation is visible.
  readonly property var testButtons: [
    { text: "\u25b6  Test session reset", id: "claude", kind: "scheduled", win: "session" },
    { text: "\u25b6  Test weekly reset", id: "claude", kind: "scheduled", win: "weekly" },
    { text: "\u26a1  Test surprise reset", id: "antigravity", kind: "surprise", win: "weekly" }
  ]
  function pressTest(t) {
    leaveSubView()
    Qt.callLater(function() { root.fireTest(t.id, t.kind, t.win) })
  }
  function fireTest(id, kind, win) {
    var surprise = kind === "surprise"
    var window = win || "session"
    var target = id
    var found = false
    for (var i = 0; i < agents.length; i++) if (agents[i].id === id) found = true
    if (!found && agent) target = agent.id           // that tab isn't shown: use the selected tab
    var name = "Agent"
    for (var j = 0; j < rawAgents.length; j++) if (rawAgents[j].id === target) name = rawAgents[j].name
    var now = Date.now()
    var next = Object.assign({}, testResets); next[target] = now
    var kinds = Object.assign({}, testKinds); kinds[target] = { at: now, kind: surprise ? "surprise" : "scheduled", magnitude: magnitudeForWindow(window) }
    flashNow = now
    testKinds = kinds
    testResets = next
    if (resetSound) playTest(surprise ? "jackpot.wav" : "")
    testNotifier.command = ["notify-send", "-a", "Cook Meter", "-t", "8000", "-u", "normal", "-i", "emblem-ok-symbolic",
      "-h", "boolean:suppress-sound:true", "-h", "string:category:presence",
      "-h", "string:image-path:" + root.pluginDir + (surprise ? "/notify/surprise-burst.svg" : "/notify/cash-burst.svg"),
      surprise ? "Antigravity " + window + " reset came early, go cook." : name + " " + window + " reset, go cook.",
      surprise ? "\u26A1 Test: a meter reset before it was due. No announcement found." : "\u{1F4B8} Test celebration"]
    testNotifier.running = true
  }
  readonly property bool anyFlashing: {
    for (var i = 0; i < rawAgents.length; i++) if (isFlashing(rawAgents[i])) return true
    return false
  }
  readonly property int selectedIndex: {
    for (var i = 0; i < agents.length; i++) if (agents[i].id === selectedId) return i
    return 0
  }
  readonly property var agent: agents.length > 0 ? agents[selectedIndex] : null

  // Models section rows. The collector builds the full list (live data first,
  // then models.json): state is "used", "zero" (usable, unused) or
  // "unavailable" (the plan can't use it). `showUnusedModels` (alias
  // `showAllClaudeModels`) turns the dimmed rows off, leaving only used ones.
  readonly property bool showUnusedModels: userSettings.showUnusedModels !== undefined
    ? userSettings.showUnusedModels !== false
    : root.setting("showUnusedModels", root.setting("showAllClaudeModels", true)) !== false
  property bool modelsExpanded: false
  readonly property int modelsCollapsedCount: 8
  function allModelRows(a) {
    var rows = (a && a.models) || []
    return showUnusedModels ? rows : rows.filter(function(m) { return m.state === "used" })
  }
  function modelRowsFor(a) {
    var rows = allModelRows(a)
    return modelsExpanded ? rows : rows.slice(0, modelsCollapsedCount)
  }
  // "removing Dec 14" for a dated notice. Once that date has gone by while the model is still listed, nothing is shown.
  function removingText(r) {
    var v = String((r && r.removing) || "")
    if (v === "") return ""
    var months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
    var full = v.match(/^(\d{4})-(\d{2})-(\d{2})$/), month = v.match(/^(\d{4})-(\d{2})$/)
    if (full) {
      // A date that has passed while the model is still in the agent's live list means the date was wrong (removals keep being
      // extended), so no warning is shown: the live list decides, not a date written down in advance.
      var d = new Date(Number(full[1]), Number(full[2]) - 1, Number(full[3]) + 1)
      return d.getTime() < Date.now() ? "" : "removing " + months[Number(full[2]) - 1] + " " + Number(full[3])
    }
    if (month) return "removing " + months[Number(month[2]) - 1]
    return "removing"
  }

  // Why a tab is gray (it has no meter at all): not installed, not signed in, or no usage source.
  // An agent's own status line, when it has one, already says more and wins.
  // Every gray tab gets exactly one short line saying why: these cover every case the lines above don't.
  function grayReason(a) {
    if (!a || ChipMeters.chipMeters(a).session >= 0) return ""
    if (String(a.status || "") !== "" || String(a.cantRead || "") !== "") return ""
    if (a.usageType && String(a.planNote || "") !== "") return ""   // a catalog agent: its tab note already says how it reports usage
    if (a.installed === false) return "Not installed."
    if (a.signedIn === false) return "Not signed in. Sign in with " + (a.cli || a.name) + " to see limits."
    if (a.id === "claude") return "Claude Code didn't report limits this time; retrying on the next refresh."
    if (a.usageType) return a.name + " doesn't report plan limits."
    return "No usage source: " + a.name + " doesn't report limits here."
  }

  // The one-click fix under a gray tab's reason line (Install / Sign in / Add key), or null. See fixes.js.
  function grayFix(a) { return a ? Fixes.fixFor(a, ChipMeters.chipMeters(a).session < 0) : null }
  function runFix(f) {
    if (!f) return
    if (f.url) Qt.openUrlExternally(f.url)
    else if (root.bar && f.cmd) root.bar.run(Fixes.terminalCommand(f.cmd))
    close()
  }

  // Highest percent across all of an agent's limit meters; -1 when it has none.
  function fullestMeter(a) {
    var top = -1
    var ls = (a && a.limits) || []
    for (var i = 0; i < ls.length; i++) if (ls[i].percent > top) top = ls[i].percent
    return top
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }
  function selectIndex(i) {
    if (agents.length === 0) return
    selectedId = agents[((i % agents.length) + agents.length) % agents.length].id
    daysOpen = false
    modelsExpanded = false
    settingsOpen = false
  }

  // Header buttons, as in the stock panel's hero corner.
  // +  Omarchy's add-subscription flow in a terminal (for the selected tab's provider when it has one).
  // >_ the default agent, exactly as the stock button starts it (`omarchy-agent --pick`).
  // The + button opens a short picker of the agents Omarchy can add an account for; picking one runs Omarchy's own
  // add-account flow for it in a terminal. (It used to jump straight to the selected tab's provider.)
  property bool addOpen: false
  readonly property var addProviders: [{ id: "claude", name: "Claude Code" }, { id: "codex", name: "Codex" }, { id: "grok", name: "Grok" }]
  function toggleAdd() { addOpen = !addOpen; if (addOpen) { squadOpen = false; settingsOpen = false; agentHereOpen = false } }
  function addSubscription(provider) {
    if (!root.bar || !provider) return
    root.bar.run("omarchy-launch-floating-terminal-with-presentation bash " + pluginDir + "/bin/add-account.sh " + provider)
    close()
  }
  // The header >_ button opens its own screen: the same folder picker as CS, then Start runs the default agent in a tiled
  // terminal there (bin/agent-here.sh, in the stock agent window class org.omarchy.agent). The bar's right-click and the
  // keyboard shortcut are Omarchy's own and still start it at once, with no picker.
  property bool agentHereOpen: false
  function toggleAgentHere() {
    agentHereOpen = !agentHereOpen
    if (agentHereOpen) {
      squadOpen = false; addOpen = false; settingsOpen = false
      squadRepo = ""; squadNewName = ""
      if (!repoLister.running) repoLister.running = true
      if (!zenityCheck.running) zenityCheck.running = true
    }
  }
  readonly property bool agentHereReady: squadRepo !== "" || squadNewName !== ""
  function agentHereCommand() {
    var env = squadNewName !== "" ? "AGENT_NEW=" + squadNewName : "AGENT_DIR=" + squadRepo
    return ["omarchy-launch-tui", "--app-id=org.omarchy.agent", "env", env, "bash", pluginDir + "/bin/agent-here.sh"]
  }
  function launchAgentHere() {
    if (!agentHereReady) return
    squadLauncher.command = agentHereCommand()
    squadLauncher.running = true
    close()
  }

  // Squad: pick an installed agent, then Claude Squad (`cs -p <agent>`) opens in a terminal in a git repo
  // folder (bin/squad.sh finds it). If cs isn't installed the picker says how to get it instead.
  property bool squadOpen: false
  property string squadHasCs: "unknown"
  // The folder step: recent repos, a repo picked with Browse, or a new project named in a small dialog.
  property var squadRepos: []
  property string squadRepo: ""
  property string squadNewName: ""
  property bool squadZenity: false
  Process {
    id: repoLister
    command: ["bash", pluginDir + "/bin/squad.sh", "--repos"]
    stdout: StdioCollector {
      onStreamFinished: {
        var list = String(text).split("\n").filter(function(l) { return l.trim() !== "" })
        root.squadRepos = list
        if (root.squadRepo === "" && root.squadNewName === "" && list.length > 0) root.squadRepo = list[0]   // the last one used
      }
    }
  }
  Process { id: zenityCheck; command: ["bash", "-c", "command -v zenity >/dev/null"]; onExited: function(code) { root.squadZenity = code === 0 } }
  Process {
    id: folderBrowser
    command: ["zenity", "--file-selection", "--directory", "--title=Choose a folder", "--filename=" + root.home + "/Projects/"]
    // A folder picked here joins the list (selected, with its check mark), so the pick is visible and Start/Run are ready.
    stdout: StdioCollector { onStreamFinished: { var p = String(text).trim(); if (p !== "") {
      if (root.squadRepos.indexOf(p) < 0) root.squadRepos = [p].concat(root.squadRepos)
      root.squadRepo = p; root.squadNewName = "" } } }
  }
  Process {
    id: nameAsker
    command: ["zenity", "--entry", "--title=New project", "--text=Name for the new project (made in ~/Projects with git set up):"]
    stdout: StdioCollector { onStreamFinished: { var n = String(text).trim(); if (n !== "" && n.indexOf("/") < 0 && n.charAt(0) !== ".") { root.squadNewName = n; root.squadRepo = "" } } }
  }
  Process { id: squadLauncher; running: false }
  function shortPath(p) {
    var s = String(p)
    if (s.indexOf(root.home + "/Projects/") === 0) return s.slice((root.home + "/Projects/").length)
    return s.indexOf(root.home) === 0 ? "~" + s.slice(root.home.length) : s
  }
  Process {
    id: squadCheck
    command: ["bash", "-c", "PATH=$HOME/.local/bin:$PATH command -v cs >/dev/null"]
    onExited: function(code) { root.squadHasCs = code === 0 ? "yes" : "no" }
  }
  function toggleSquad() {
    squadOpen = !squadOpen
    if (squadOpen) { addOpen = false; settingsOpen = false; agentHereOpen = false }
    if (squadOpen) {
      squadRepo = ""; squadNewName = ""
      if (!repoLister.running) repoLister.running = true
      if (!zenityCheck.running) zenityCheck.running = true
      var first = {}
      if (agent && agent.cli) first[agent.id] = true
      squadPicked = first
      if (!squadCheck.running) squadCheck.running = true
    }
  }
  function installSquad() {
    if (root.bar) root.bar.run("omarchy-launch-tui --app-id=org.omarchy.squad bash " + pluginDir + "/bin/squad.sh --install")
    close()
  }
  // The agents ticked in the picker (agent id -> true). Opening the picker ticks the selected tab's agent.
  property var squadPicked: ({})
  readonly property var squadClis: {
    var out = []
    allOrdered.forEach(function(a) { if (squadPicked[a.id] && a.cli) out.push(a.cli) })
    return out
  }
  function toggleSquadAgent(id) {
    var next = Object.assign({}, squadPicked); next[id] = !next[id]
    squadPicked = next
  }
  // Runs `cs -p <agent>` for each ticked agent. squad.sh settles the git repo folder once (pick or create one
  // if there is none), runs the first agent in that terminal and opens a terminal for each of the others.
  readonly property bool squadReady: squadClis.length > 0 && (squadRepo !== "" || squadNewName !== "")
  // The command that opens the ONE Squad window: the folder is handed over through the environment, so squad.sh doesn't ask.
  function squadCommand() {
    var env = squadNewName !== "" ? "SQUAD_NEW=" + squadNewName : "SQUAD_DIR=" + squadRepo
    return ["omarchy-launch-tui", "--app-id=org.omarchy.squad", "env", env, "bash", pluginDir + "/bin/squad.sh"].concat(squadClis)
  }
  function launchSquad() {
    if (!squadReady) return
    squadLauncher.command = squadCommand()
    squadLauncher.running = true
    close()
  }

  function refreshNow() { if (!collector.running) collector.running = true }
  // A window whose reset time has passed is reset: 0%, no hit, no red, until fresh data arrives
  // (bin/expire-resets.mjs does the same in the collector). Then fetch that fresh data.
  function expireResets() {
    var now = Date.now(), changed = false
    function fix(ls) {
      return (ls || []).map(function(l) {
        var t = new Date(String((l && l.resetsAt) || "")).getTime()
        if (!isFinite(t) || t > now || !(Number(l.percent) > 0)) return l
        changed = true
        var c = Object.assign({}, l); delete c.hitAt
        c.percent = 0; c.resetsAt = ""; c.note = "Reset, waiting for fresh data."
        return c
      })
    }
    var next = rawAgents.map(function(a) {
      var b = Object.assign({}, a); b.limits = fix(a.limits)
      if (a.accounts) b.accounts = a.accounts.map(function(x) { var y = Object.assign({}, x); y.limits = fix(x.limits); return y })
      return b
    })
    if (changed) { rawAgents = next; refreshNow() }
  }

  function fmtTokens(n) {
    n = Number(n) || 0
    if (n >= 1e9) return (n / 1e9).toFixed(1) + "B"
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M"
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K"
    return String(Math.round(n))
  }
  function countdown(resetsAt) {
    var ms = new Date(String(resetsAt || "")).getTime()
    if (!isFinite(ms)) return ""
    ms -= nowMs
    if (!(ms > 0)) return "resets now"
    var m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24)
    if (d > 0) return "resets in " + d + "d " + (h % 24) + "h"
    if (h > 0) return "resets in " + h + "h " + (m % 60) + "m"
    return "resets in " + Math.max(1, m) + "m"
  }
  // "Tue Nov 25, 6:00 AM" in local time; empty when there is no reset time.
  function resetClock(resetsAt) {
    var d = new Date(String(resetsAt || ""))
    return isNaN(d.getTime()) ? "" : Qt.formatDateTime(d, "ddd MMM d, h:mm AP")
  }
  function dayLabel(date, isToday) {
    if (isToday) return "Today"
    var p = new Date(date + "T00:00:00")
    return isNaN(p.getTime()) ? date : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][p.getDay()]
  }

  // Hidden on a machine with nothing to show; stays when tabs were hidden by the
  // user so the gear is still reachable to bring them back.
  visible: agents.length > 0 || hiddenAgents.length > 0 || settingsOpen
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  Timer {
    id: autoCloseTimer
    interval: 5000
    repeat: false
    onTriggered: if (root.autoOpened && root.opened) root.close()
  }

  onOpenedChanged: if (!opened) { autoOpened = false; autoCloseTimer.stop(); squadOpen = false; addOpen = false; agentHereOpen = false } else {
    daysOpen = false
    modelsExpanded = false
    settingsOpen = false
    nowMs = Date.now()
    refreshNow()
    Qt.callLater(function() { if (!root.autoOpened) keyCatcher.forceActiveFocus() })
  }

  // ------------------------------------------------------------------ data
  FileView {
    path: root.dataPath
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      try {
        var d = JSON.parse(String(text() || ""))
        root.flashNow = Date.now()
        root.pluginVersion = d && d.version ? String(d.version) : ""
        root.rawAgents = d && Array.isArray(d.agents) ? d.agents : []
        root.dataGeneratedAt = d && Number(d.generatedAt) > 0 ? Number(d.generatedAt) : 0
        root.expireResets()
        // A reset the collector flagged since the last load -> celebrate. The first
        // load only records what is already there (no pop-up when the shell starts).
        var seen = root.lastResetSeen, fresh = []
        root.rawAgents.forEach(function(a) {
          var t = Number(a.resetAt || 0)
          if (root.resetsPrimed && t > Number(seen[a.id] || 0) && Date.now() - t < 8000) fresh.push(a.id)
          if (t > Number(seen[a.id] || 0)) seen[a.id] = t
        })
        root.resetsPrimed = true
        if (fresh.length > 0) Qt.callLater(function() { root.autoCelebrate(fresh[0]) })
      } catch (e) { root.rawAgents = [] }
    }
    onLoadFailed: root.rawAgents = []
  }

  FileView {
    path: (Quickshell.env("XDG_STATE_HOME") || root.home + "/.local/state") + "/omarchy/agent-usage-tabs/settings.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      try { var d = JSON.parse(String(text() || "")); root.userSettings = d && typeof d === "object" && !Array.isArray(d) ? d : ({}); root.pendingOrder = null }
      catch (e) { root.userSettings = ({}) }
    }
    onLoadFailed: root.userSettings = ({})
  }

  Process {
    id: settingsWriter
    running: false
  }

  // Plays the cha-ching once at the chosen volume (the gear's play button).
  Process {
    id: soundTester
    running: false
  }
  Process {
    id: testNotifier
    running: false
  }
  function playTest(clip) {
    var cmd = ["node", root.pluginDir + "/bin/play-sound.mjs", String(root.resetVolume)]
    if (clip) cmd.push(root.pluginDir + "/sounds/" + clip)
    soundTester.command = cmd
    soundTester.running = true
  }

  Process {
    id: collector
    running: false
    command: ["node", root.pluginDir + "/bin/collect.mjs", "--notify", String(root.setting("notifyThreshold", 95)), "--volume", String(root.resetSound ? root.resetVolume : 0)]
  }

  Timer {
    interval: Math.max(60, Number(root.setting("refreshIntervalSec", 300))) * 1000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refreshNow()
  }

  // Ticks only while some chip is flashing, so it costs nothing otherwise.
  Timer {
    interval: 500
    running: root.anyFlashing
    repeat: true
    onTriggered: root.flashNow = Date.now()
  }

  Timer {
    interval: 30000
    running: root.opened
    repeat: true
    onTriggered: { root.nowMs = Date.now(); root.expireResets() }
  }

  // The bar number and chips clear right at a reset even while the panel is closed.
  Timer {
    interval: 30000
    running: true
    repeat: true
    onTriggered: root.expireResets()
  }

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { root.refreshNow(); return "ok" }
    function testAutoOpen(): string { root.autoCelebrate("claude"); root.fireTest("claude"); return "ok" }
    function testSurprise(): string { root.fireTest("antigravity", "surprise"); return "ok" }
    function testSurpriseAutoOpen(): string { root.autoCelebrate("antigravity"); root.fireTest("antigravity", "surprise"); return "ok" }
    // Test hook: press Settings' Test reset button `i` (0 session, 1 weekly, 2 surprise), same path as a click.
    function pressTest(i: string): string { var t = root.testButtons[Number(i)]; if (!t) return "no such button"; root.pressTest(t); return t.win }
    // Test hook: show the angry robot for 8 seconds (only if the gear switch is on).
    function testAngry(): string { root.testAngry = true; testAngryTimer.restart(); return root.robotAngry ? "angry" : "switched off" }
    function testCelebration(): string { root.fireTest("claude"); return "ok" }
    function testWindow(window: string): string { root.fireTest("claude", "scheduled", window); return "ok" }
    function testWindowAutoOpen(window: string): string { root.autoCelebrate("claude"); root.fireTest("claude", "scheduled", window); return "ok" }
    // Test hook: show exactly one screen: "main", "settings", "add", "squad" or "agent" (used to retake the README screenshots).
    function view(name: string): string { root.leaveSubView(); if (name === "settings") root.openSettings(); else if (name === "add") root.toggleAdd(); else if (name === "squad") root.toggleSquad(); else if (name === "agent") root.toggleAgentHere(); return name }
    function settings(): string { if (root.settingsOpen) root.settingsOpen = false; else root.openSettings(); return root.settingsOpen ? "open" : "closed" }
    // Test hook: show the picker as if cs were missing (or present) without running the check.
    function squadPreview(state: string): string { root.squadOpen = true; root.squadHasCs = state; return state }
    // Test hook: select a tab by agent id (used to retake the README screenshots).
    function select(id: string): string { root.selectedId = id; return root.selectedId }
    function add(): string { root.toggleAdd(); return root.addOpen ? "open" : "closed" }
    // Test hooks for the Claude Squad view: set the folder step and read back the command Run would execute.
    function squadSetRepo(p: string): string { root.squadRepo = p; root.squadNewName = ""; return root.squadRepo }
    function squadSetNew(n: string): string { root.squadNewName = n; root.squadRepo = ""; return root.squadNewName }
    function squadCmd(): string { return root.squadReady ? JSON.stringify(root.squadCommand()) : "not ready" }
    function squadState(): string { return JSON.stringify({ open: root.squadOpen, repos: root.squadRepos, repo: root.squadRepo, create: root.squadNewName, cs: root.squadHasCs, zenity: root.squadZenity }) }
    // Test hook for the agent screen (the header terminal button): the command Start would run.
    function agentCmd(): string { return root.agentHereReady ? JSON.stringify(root.agentHereCommand()) : "not ready" }
    function squad(): string { root.toggleSquad(); return root.squadOpen ? "open" : "closed" }
    function resetOrder(): string { root.resetOrder(); return "ok" }
    // Test hook: drop chip `from` as if it were dragged onto chip `to` (same hit-testing as a real drag).
    function dropOnto(from: string, to: string): string {
      var a = chipRepeater.itemAt(Number(from)), b = chipRepeater.itemAt(Number(to))
      if (!a || !b) return "no such chip"
      return "dropped on " + root.dropChip(Number(from), b.x + b.width / 2 - a.x - a.width / 2, b.y + b.height / 2 - a.y - a.height / 2)
    }
    function next(): string { root.selectIndex(root.selectedIndex + 1); return "ok" }
  }

  // A labelled on/off switch. Colors are passed in because an inline component
  // can't rely on reaching the panel's ids.
  component SettingSwitch: Item {
    id: sw
    property string label: ""
    property bool checked: false
    property color foreground: root.foreground
    property color trackColor: root.track
    property color onColor: root.green
    property string fontFamily: root.fontFamily
    signal toggled()
    height: Math.max(swLabel.implicitHeight, Style.space(20)) + Style.space(6)
    opacity: enabled ? 1 : 0.4
    Text {
      id: swLabel
      anchors.verticalCenter: parent.verticalCenter
      width: parent.width - Style.space(52)
      textFormat: Text.PlainText
      text: sw.label
      color: sw.foreground
      font.family: sw.fontFamily
      font.pixelSize: Style.font.body
      wrapMode: Text.WordWrap
    }
    Rectangle {
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      width: Style.space(38)
      height: Style.space(20)
      radius: height / 2
      color: sw.checked ? sw.onColor : sw.trackColor
      border.width: 1
      border.color: Qt.rgba(sw.foreground.r, sw.foreground.g, sw.foreground.b, 0.4)
      Rectangle {
        width: parent.height - Style.space(6)
        height: width
        radius: width / 2
        anchors.verticalCenter: parent.verticalCenter
        x: sw.checked ? parent.width - width - Style.space(3) : Style.space(3)
        color: sw.foreground
      }
    }
    MouseArea {
      anchors.fill: parent
      enabled: sw.enabled
      cursorShape: Qt.PointingHandCursor
      onClicked: sw.toggled()
    }
  }

  // Sound volume: - / + in steps of 10, the level, and a play button to hear it.
  component VolumeRow: Item {
    id: vr
    property int volume: 60
    property color foreground: root.foreground
    property color trackColor: root.track
    property string fontFamily: root.fontFamily
    signal step(int delta)
    signal play()
    height: Style.space(30)
    opacity: enabled ? 1 : 0.4
    Text {
      anchors.verticalCenter: parent.verticalCenter
      textFormat: Text.PlainText
      text: "Sound volume"
      color: vr.foreground
      font.family: vr.fontFamily
      font.pixelSize: Style.font.body
    }
    Row {
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(6)
      Repeater {
        model: [{ glyph: "\u2212", delta: -10 }, { glyph: "+", delta: 10 }]
        Rectangle {
          required property var modelData
          width: Style.space(26); height: Style.space(24); radius: Style.cornerRadius
          color: vr.trackColor
          Text { anchors.centerIn: parent; textFormat: Text.PlainText; text: modelData.glyph; color: vr.foreground; font.family: vr.fontFamily; font.pixelSize: Style.font.body }
          MouseArea { anchors.fill: parent; enabled: vr.enabled; cursorShape: Qt.PointingHandCursor; onClicked: vr.step(modelData.delta) }
        }
      }
      Text {
        width: Style.space(42)
        anchors.verticalCenter: parent.verticalCenter
        horizontalAlignment: Text.AlignHCenter
        textFormat: Text.PlainText
        text: vr.volume + "%"
        color: vr.foreground
        font.family: vr.fontFamily
        font.pixelSize: Style.font.body
        font.bold: true
      }
      Rectangle {
        width: Style.space(26); height: Style.space(24); radius: Style.cornerRadius
        color: vr.trackColor
        Text { anchors.centerIn: parent; textFormat: Text.PlainText; text: "\u25b6"; color: vr.foreground; font.family: vr.fontFamily; font.pixelSize: Style.font.caption }
        MouseArea { anchors.fill: parent; enabled: vr.enabled; cursorShape: Qt.PointingHandCursor; onClicked: vr.play() }
      }
    }
  }

  // One meter row: title and % used, the bar, and the reset countdown.
  component LimitRow: Column {
    id: lr
    property var limit: ({})
    spacing: Style.space(4)

    Item {
      width: parent.width
      height: pctText.implicitHeight
      Text {
        textFormat: Text.PlainText
        text: limit.title
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
      }
      Text {
        id: pctText
        anchors.right: parent.right
        textFormat: Text.PlainText
        text: Math.round(limit.percent * 100) + "% used" + (limit.unsure || root.dataStale ? " · unsure" : "")
        color: root.tintFor(limit.percent, !!limit.unsure || root.dataStale)
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        font.bold: true
      }
    }
    Rectangle {
      width: parent.width
      height: Style.space(10)
      radius: height / 2
      color: root.track
      Rectangle {
        width: Math.max(limit.percent > 0 ? height : 0, parent.width * root.clamp(limit.percent, 0, 1))
        height: parent.height
        radius: height / 2
        color: root.tintFor(limit.percent, !!limit.unsure || root.dataStale)
      }
    }
    Text {
      visible: !!limit.note
      textFormat: Text.PlainText
      text: limit.note || ""
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }
    Text {
      textFormat: Text.PlainText
      text: {
        var c = root.countdown(limit.resetsAt)
        var a = root.resetClock(limit.resetsAt)
        return c !== "" && a !== "" ? c + " · " + a : c
      }
      visible: text !== ""
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }
  }

  // The small tinted square the stock panel uses for its hero-corner buttons (34 wide).
  // The folder step, shared by the CS screen and the agent screen (the header terminal button): recent repos (the last one
  // used preselected), then "+ New project", then "Browse...". It sets root.squadRepo / root.squadNewName.
  component FolderPicker: Column {
    id: fp
    property bool forSquad: true
    spacing: Style.space(14)
    PanelSectionHeader { width: parent.width; text: "FOLDER" }
    Flow {
      width: parent.width
      spacing: Style.space(6)
      Repeater {
        model: root.squadRepos
        Rectangle {
          id: repoChip
          required property string modelData
          readonly property bool on: root.squadRepo === modelData
          width: repoLabel.implicitWidth + Style.space(22)
          height: repoLabel.implicitHeight + Style.space(14)
          radius: Style.cornerRadius
          color: on ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.22)
                    : (repoArea.containsMouse ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.1) : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.06))
          border.width: on ? 1 : 0
          border.color: Color.accent
          Text {
            id: repoLabel
            anchors.centerIn: parent
            textFormat: Text.PlainText
            text: (repoChip.on ? "\u2713 " : "") + root.shortPath(repoChip.modelData)
            color: repoChip.on ? Color.accent : root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            font.bold: repoChip.on
          }
          MouseArea { id: repoArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: { root.squadRepo = repoChip.modelData; root.squadNewName = "" } }
          PanelToolTip { visible: repoArea.containsMouse; text: repoChip.modelData; fontFamily: root.fontFamily }
        }
      }
      // A new project: asks for a name in a small dialog; it is made in ~/Projects with git set up.
      Rectangle {
        id: newChip
        visible: root.squadZenity
        readonly property bool on: root.squadNewName !== ""
        width: newLabel.implicitWidth + Style.space(22)
        height: newLabel.implicitHeight + Style.space(14)
        radius: Style.cornerRadius
        color: on ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.22) : (newArea.containsMouse ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.1) : "transparent")
        border.width: 1
        border.color: on ? Color.accent : root.soft(root.foreground, 0.3)
        Text {
          id: newLabel
          anchors.centerIn: parent
          textFormat: Text.PlainText
          text: newChip.on ? "\u2713 New: " + root.squadNewName : "+ New project"
          color: newChip.on ? Color.accent : root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
        }
        MouseArea { id: newArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: { if (!nameAsker.running) nameAsker.running = true } }
        PanelToolTip { visible: newArea.containsMouse; text: "Make a new project in ~/Projects, with git set up"; fontFamily: root.fontFamily }
      }
      // Browse: any other folder, through a normal folder chooser.
      Rectangle {
        id: browseChip
        visible: root.squadZenity
        width: browseLabel.implicitWidth + Style.space(22)
        height: browseLabel.implicitHeight + Style.space(14)
        radius: Style.cornerRadius
        color: browseArea.containsMouse ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.1) : "transparent"
        border.width: 1
        border.color: root.soft(root.foreground, 0.3)
        Text {
          id: browseLabel
          anchors.centerIn: parent
          textFormat: Text.PlainText
          text: "Browse..."
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
        }
        MouseArea { id: browseArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: { if (!folderBrowser.running) folderBrowser.running = true } }
        PanelToolTip { visible: browseArea.containsMouse; text: fp.forSquad ? "Pick any other folder (a plain folder is git-initialized after you confirm)" : "Pick any other folder"; fontFamily: root.fontFamily }
      }
    }
    Text {
      visible: root.squadRepos.length === 0 && root.squadRepo === "" && root.squadNewName === ""
      width: parent.width
      textFormat: Text.PlainText
      wrapMode: Text.WordWrap
      text: "No git repos found in ~/Projects yet. Make a new project or browse to a folder."
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }
  }
  component HeaderButton: Rectangle {
    id: hb
    property string glyph: ""
    property string tip: ""
    signal clicked()
    implicitWidth: Style.space(34)
    implicitHeight: implicitWidth
    radius: Style.cornerRadius
    color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, hbArea.containsMouse ? 0.12 : 0.05)
    border.width: hbArea.containsMouse ? Math.max(1, Style.hoverBorderWidth) : 0
    border.color: root.soft(Color.accent, 0.8)
    Text {
      anchors.centerIn: parent
      textFormat: Text.PlainText
      text: hb.glyph
      color: hbArea.containsMouse ? Color.accent : root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.heading
    }
    MouseArea {
      id: hbArea
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onClicked: hb.clicked()
    }
    PanelToolTip { visible: hbArea.containsMouse; text: hb.tip; fontFamily: root.fontFamily }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    // Angry robot (angry eyes, the theme's red) while the default agent is at 100%; back by itself at the reset.
    text: root.robotAngry ? "\u{f169d}" : "\u{f16a3}"
    // The default agent's number beside the icon, colored like its chip (green, amber from 60%, red above 85%).
    labelText: root.barValue >= 0 ? Math.round(root.barValue * 100) + "%" : ""
    slotSize: Style.bar.iconSlot * (root.barValue >= 0 ? 2 : 1)
    active: root.barValue >= 0
    activeColor: root.robotAngry ? Color.urgent : root.meterColorFor(root.barValue, root.lightBar)
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.MiddleButton) root.selectIndex(root.selectedIndex + 1)
      else root.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: root.autoOpened ? null : keyCatcher
    // An automatic (reset) open must never take the keyboard: override the
    // panel's exclusive focus prime with none. A manual open is unchanged.
    WlrLayershell.keyboardFocus: root.autoOpened ? WlrKeyboardFocus.None
      : (panel.open ? (panel.focusPrimed ? WlrKeyboardFocus.OnDemand : WlrKeyboardFocus.Exclusive) : WlrKeyboardFocus.None)
    contentWidth: panel.fittedContentWidth(Style.space(520))
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(660))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent

      // Pointing at the auto-opened panel means the user wants it: keep it open.
      HoverHandler {
        onHoveredChanged: if (hovered && root.autoOpened) autoCloseTimer.stop()
      }
      onMoveRequested: function(dx, dy) {
        if (dx !== 0) root.selectIndex(root.selectedIndex + dx)
        if (dy !== 0) flick.contentY = root.clamp(flick.contentY + dy * Style.space(56), 0, Math.max(0, flick.contentHeight - flick.height))
      }
      onActivateRequested: root.daysOpen = !root.daysOpen
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) { if (t === "r" || t === "R") root.refreshNow() }

      Flickable {
        id: flick
        anchors.top: parent.top
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: column
          width: flick.width
          spacing: Style.space(12)

          // ---------------- Panel header, above the tabs: the title on the left and the
          // add-subscription, default-agent and settings buttons on the right (like the stock hero corner).
          Item {
            id: topHeader
            width: parent.width
            height: Style.space(34)
            // A sub-view (Claude Squad, or add an account): a back button and the title, instead of the usual title and buttons.
            Row {
              visible: root.subView
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(10)
              HeaderButton { glyph: "\u2190"; tip: "Back"; onClicked: root.leaveSubView() }
              Text {
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.PlainText
                text: root.addOpen ? "Add an account" : (root.settingsOpen ? "Settings" : (root.agentHereOpen ? "Start " + root.defaultAgentName : "Claude Squad"))
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.title
                font.bold: true
              }
            }
            Text {
              visible: !root.subView
              anchors.verticalCenter: parent.verticalCenter
              textFormat: Text.PlainText
              text: "Agents"
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.title
              font.bold: true
            }
            Row {
              visible: !root.subView
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(6)
              HeaderButton { glyph: "\u{f0415}"; tip: "Add a subscription"; onClicked: root.toggleAdd() }
              HeaderButton { glyph: "\u{f07b7}"; tip: "Start the default agent in a folder"; onClicked: root.toggleAgentHere() }
              HeaderButton { glyph: "CS"; tip: "Claude Squad"; onClicked: root.toggleSquad() }
              Rectangle {
              id: gearButton
              width: Style.space(34)
              height: Style.space(34)
              radius: Style.cornerRadius
              color: root.settingsOpen ? root.track : "transparent"
              border.width: root.settingsOpen ? 1 : 0
              border.color: root.foreground
              Text {
                anchors.centerIn: parent
                textFormat: Text.PlainText
                text: "\uf013"
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.title
              }
              MouseArea {
                id: gearHover
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: root.openSettings()
              }
              PanelToolTip { visible: gearHover.containsMouse; text: "Settings"; fontFamily: root.fontFamily }
            }
            }
          }

          // ---------------- Handoff note question: asked once, the first time a session nears its limit. Nothing has been written.
          Rectangle {
            id: handoffCard
            visible: root.handoffUndecided && root.handoffPending !== null && !root.subView
            width: parent.width
            height: visible ? handoffCol.implicitHeight + Style.space(24) : 0
            radius: Style.cornerRadius
            color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.06)
            border.width: 1
            border.color: root.soft(Color.accent, 0.5)
            Column {
              id: handoffCol
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.top: parent.top
              anchors.margins: Style.space(12)
              spacing: Style.space(8)
              Text {
                width: parent.width
                textFormat: Text.PlainText
                text: "Write a handoff note?"
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                font.bold: true
              }
              Text {
                width: parent.width
                textFormat: Text.PlainText
                wrapMode: Text.WordWrap
                text: (root.handoffPending ? root.handoffPending.trigger.agent : "An agent") + " is near its session limit. Cook Meter can write handoff/HANDOFF.md in "
                  + (root.handoffPending ? root.shortPath(root.handoffPending.repo) : "your repo") + " (what you were working on, from git and CLAUDE.md) and add a line to AGENTS.md telling agents to read it. Nothing is written until you allow it."
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
              Row {
                spacing: Style.space(8)
                Repeater {
                  model: [{ t: "Allow", a: "allow", main: true }, { t: "Not now", a: "dismiss", main: false }, { t: "Never", a: "never", main: false }]
                  Rectangle {
                    id: hbtn
                    required property var modelData
                    width: hbtnLabel.implicitWidth + Style.space(24)
                    height: hbtnLabel.implicitHeight + Style.space(12)
                    radius: Style.cornerRadius
                    color: modelData.main ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, hbtnArea.containsMouse ? 0.3 : 0.18)
                                          : (hbtnArea.containsMouse ? Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.1) : "transparent")
                    border.width: modelData.main ? 0 : 1
                    border.color: root.soft(root.foreground, 0.3)
                    Text {
                      id: hbtnLabel
                      anchors.centerIn: parent
                      textFormat: Text.PlainText
                      text: hbtn.modelData.t
                      color: hbtn.modelData.main ? Color.accent : root.foreground
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.bodySmall
                      font.bold: hbtn.modelData.main
                    }
                    MouseArea { id: hbtnArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: root.answerHandoff(hbtn.modelData.a) }
                  }
                }
              }
            }
          }

          // ---------------- Add-a-subscription picker (opened by the + button above): choose which agent to add an account for.
          Column {
            visible: root.addOpen
            width: parent.width
            spacing: Style.space(8)
            Text {
              textFormat: Text.PlainText
              text: "Add an account for:"
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }
            Flow {
              width: parent.width
              spacing: Style.space(6)
              Repeater {
                model: root.addProviders
                Rectangle {
                  id: addPick
                  required property var modelData
                  width: addPickLabel.implicitWidth + Style.space(22)
                  height: addPickLabel.implicitHeight + Style.space(14)
                  radius: Style.cornerRadius
                  color: addPickArea.containsMouse ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.16) : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.06)
                  Text {
                    id: addPickLabel
                    anchors.centerIn: parent
                    textFormat: Text.PlainText
                    text: addPick.modelData.name
                    color: addPickArea.containsMouse ? Color.accent : root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                  }
                  MouseArea { id: addPickArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: root.addSubscription(addPick.modelData.id) }
                }
              }
            }
            Text {
              width: parent.width
              textFormat: Text.PlainText
              wrapMode: Text.WordWrap
              text: "Adds another login for one of these agents. You'll be asked to name it."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }
          }

          // ---------------- Agent view (the >_ header button): pick the folder, then Start runs the default agent there.
          Column {
            id: agentHereView
            visible: root.agentHereOpen
            width: parent.width
            spacing: Style.space(14)
            FolderPicker { width: parent.width; forSquad: false }
            Rectangle {
              id: startTile
              readonly property bool ready: root.agentHereReady
              width: startLabel.implicitWidth + Style.space(28)
              height: startLabel.implicitHeight + Style.space(14)
              radius: Style.cornerRadius
              opacity: ready ? 1 : 0.4
              color: startArea.containsMouse && ready ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.3) : Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.15)
              Text {
                id: startLabel
                anchors.centerIn: parent
                textFormat: Text.PlainText
                text: "Start " + root.defaultAgentName
                color: Color.accent
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
                font.bold: true
              }
              MouseArea { id: startArea; anchors.fill: parent; enabled: startTile.ready; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: root.launchAgentHere() }
              PanelToolTip { visible: startArea.containsMouse; text: "Opens the default agent in a tiled terminal in this folder"; fontFamily: root.fontFamily }
            }
          }

          // ---------------- Claude Squad view (the CS header button): replaces the panel contents with just the Squad
          // options: pick the agents, pick the folder, Run. The Back button in the header returns to the normal view.
          Column {
            id: squadView
            visible: root.squadOpen
            width: parent.width
            spacing: Style.space(14)

        // cs isn't installed: say so, with a one-click install (it runs in a terminal so you see it).
        Row {
          visible: root.squadHasCs === "no"
          width: parent.width
          spacing: Style.space(10)
          Text {
            anchors.verticalCenter: parent.verticalCenter
            width: parent.width - installTile.width - Style.space(10)
            textFormat: Text.PlainText
            wrapMode: Text.WordWrap
            text: "Squad needs Claude Squad (cs), plus tmux and git."
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
          Rectangle {
            id: installTile
            width: installLabel.implicitWidth + Style.space(22)
            height: installLabel.implicitHeight + Style.space(14)
            radius: Style.cornerRadius
            color: installArea.containsMouse ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.14) : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.05)
            Text {
              id: installLabel
              anchors.centerIn: parent
              textFormat: Text.PlainText
              text: "Install Claude Squad"
              color: installArea.containsMouse ? Color.accent : root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              font.bold: true
            }
            MouseArea { id: installArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: root.installSquad() }
            PanelToolTip { visible: installArea.containsMouse; text: "Opens a terminal and runs the Claude Squad install script"; fontFamily: root.fontFamily }
          }
        }

            Column {
              visible: root.squadHasCs === "yes"
              width: parent.width
              spacing: Style.space(14)

              PanelSectionHeader { width: parent.width; text: "AGENTS" }
            Flow {
              width: parent.width
              spacing: Style.space(6)
              Repeater {
                model: root.allOrdered.filter(function(a) { return a.installed !== false && !!a.cli })
                Rectangle {
                  id: pick
                  required property var modelData
                  readonly property bool on: !!root.squadPicked[modelData.id]
                  width: pickLabel.implicitWidth + Style.space(22)
                  height: pickLabel.implicitHeight + Style.space(14)
                  radius: Style.cornerRadius
                  color: on ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.22)
                            : (pickArea.containsMouse ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.1) : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.05))
                  border.width: on ? 1 : 0
                  border.color: Color.accent
                  Text {
                    id: pickLabel
                    anchors.centerIn: parent
                    textFormat: Text.PlainText
                    text: (pick.on ? "\u2713 " : "") + pick.modelData.name
                    color: pick.on ? Color.accent : root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                    font.bold: pick.on
                  }
                  MouseArea { id: pickArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: root.toggleSquadAgent(pick.modelData.id) }
                }
              }
            }

              FolderPicker { width: parent.width }

            Rectangle {
              id: runTile
              readonly property bool ready: root.squadReady
              width: runLabel.implicitWidth + Style.space(28)
              height: runLabel.implicitHeight + Style.space(14)
              radius: Style.cornerRadius
              opacity: ready ? 1 : 0.4
              color: runArea.containsMouse && ready ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.3) : Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.15)
              Text {
                id: runLabel
                anchors.centerIn: parent
                textFormat: Text.PlainText
                text: "Run" + (root.squadClis.length > 0 ? " " + root.squadClis.length + (root.squadClis.length === 1 ? " agent" : " agents") : "")
                color: Color.accent
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
                font.bold: true
              }
              MouseArea { id: runArea; anchors.fill: parent; enabled: runTile.ready; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: root.launchSquad() }
              PanelToolTip { visible: runArea.containsMouse; text: "Opens one Claude Squad window in a git repo folder, with a session started for each agent"; fontFamily: root.fontFamily }
            }
            }
          }

          // ---------------- Tabs: full names, wrap rather than truncate
          Flow {
            visible: !root.subView
            width: parent.width
            spacing: Style.space(9)

            Repeater {
              id: chipRepeater
              model: root.agents

              Rectangle {
                id: chip
                required property var modelData
                required property int index
                readonly property bool selected: index === root.selectedIndex
                readonly property bool flashing: root.isFlashing(modelData)
                readonly property bool surprise: root.resetKindOf(modelData) === "surprise"
                readonly property real magnitude: root.magnitudeOf(modelData)
                readonly property color flashColor: surprise ? (root.lightPanel ? "#b8860b" : "#fbbc05") : root.green
                // True for the first 3 s after the collector flags a reset.
                readonly property bool celebrating: root.resetTimeOf(modelData) > 0 && root.flashNow - root.resetTimeOf(modelData) < (surprise ? 4800 : 3000)
                // Outer border = session meter, inner fill = weekly meter
                // (an agent with one meter uses it for both). Gray = no data.
                readonly property var meters: ChipMeters.chipMeters(modelData)
                readonly property color gray: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.3)
                readonly property bool unsure: root.unsureReason(modelData) !== ""
                readonly property color sessionTint: flashing ? flashColor : (meters.session < 0 ? gray : root.tintFor(meters.session, unsure))
                readonly property color weeklyTint: flashing ? flashColor : (meters.weekly < 0 ? gray : root.tintFor(meters.weekly, unsure))
                width: tabLabel.implicitWidth + Style.space(22)
                height: tabLabel.implicitHeight + Style.space(14)
                radius: Style.cornerRadius
                color: "transparent"
                border.width: 1
                border.color: root.soft(sessionTint, selected ? 0.85 : 0.5)

                // The weekly meter fills the inside. The selected chip adds a
                // foreground ring around that fill, so selection never depends
                // on a color that might match the meter colors.
                Rectangle {
                  anchors.fill: parent
                  anchors.margins: Style.space(3)
                  radius: Math.max(0, chip.radius - 1)
                  color: Qt.rgba(chip.weeklyTint.r, chip.weeklyTint.g, chip.weeklyTint.b, chip.flashing ? 0.7 : (chip.selected ? 0.34 : 0.16))
                  border.width: chip.selected ? 1 : 0
                  border.color: root.soft(root.foreground, 0.7)
                }

                Text {
                  id: tabLabel
                  anchors.centerIn: parent
                  textFormat: Text.PlainText
                  text: modelData.name
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                  font.bold: parent.selected
                }
                // Default-agent marker: a small accent dot on the first chip when it is Omarchy's default.
                Rectangle {
                  visible: chip.index === 0 && root.isDefaultAgent(chip.modelData)
                  anchors.top: parent.top
                  anchors.right: parent.right
                  anchors.topMargin: -Style.space(3)
                  anchors.rightMargin: -Style.space(3)
                  width: Style.space(10)
                  height: width
                  radius: width / 2
                  color: Color.accent
                  border.width: 2
                  border.color: root.panelBackground
                  z: 4
                }
                // Drag a chip onto another to reorder; the order is saved. The chip follows the pointer
                // (a transform, so the Flow keeps its layout) and settles where it is dropped.
                transform: Translate { x: chipDrag.active ? chipDrag.activeTranslation.x : 0; y: chipDrag.active ? chipDrag.activeTranslation.y : 0 }
                z: chipDrag.active ? 10 : 0
                opacity: chipDrag.active ? 0.85 : 1
                DragHandler {
                  id: chipDrag
                  target: null
                  cursorShape: Qt.ClosedHandCursor
                  // activeTranslation is already back at 0 when `active` turns false, so keep the last value.
                  property real lastDx: 0
                  property real lastDy: 0
                  onActiveTranslationChanged: if (active) { lastDx = activeTranslation.x; lastDy = activeTranslation.y }
                  onActiveChanged: {
                    if (active) { lastDx = 0; lastDy = 0; return }
                    root.dropChip(chip.index, lastDx, lastDy)
                  }
                }
                MouseArea {
                  id: chipArea
                  anchors.fill: parent
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onClicked: root.selectIndex(index)
                }
                PanelToolTip {
                  visible: chipArea.containsMouse && chip.index === 0 && root.isDefaultAgent(chip.modelData)
                  text: "Default agent: the shortcut and right-click start " + chip.modelData.name
                  fontFamily: root.fontFamily
                }

                // Reset celebration: a ~3 s burst of confetti and sparkles that
                // starts when the collector flags this agent (resetAt) and
                // plays once. Turn it off in the gear settings.
                Item {
                  id: confetti
                  anchors.centerIn: parent
                  width: 1
                  height: 1
                  z: 5
                  readonly property bool active: root.resetAnimation && chip.celebrating
                  property real t: 0
                  visible: t > 0 && t < 1
                  onActiveChanged: if (active) { t = 0; confettiAnim.restart() }
                  NumberAnimation { id: confettiAnim; target: confetti; property: "t"; from: 0; to: 1; duration: chip.surprise ? 4800 : 3000 }

                  // Surprise only: two expanding gold shockwave rings.
                  Repeater {
                    model: chip.surprise ? 2 : 0
                    Rectangle {
                      required property int index
                      readonly property real tt: Math.max(0, Math.min(1, (confetti.t - index * 0.16) / 0.5))
                      anchors.centerIn: parent
                      width: Style.space(18) + tt * Style.space(270)
                      height: width
                      radius: width / 2
                      color: "transparent"
                      border.width: Math.max(1, Style.space(4) * (1 - tt))
                      border.color: root.gold
                      opacity: tt > 0 && tt < 1 ? (1 - tt) * 0.9 : 0
                    }
                  }

                  Repeater {
                    model: Math.round((chip.surprise ? 80 : 28) * chip.magnitude)
                    Item {
                      required property int index
                      readonly property real ang: index * 2.399963 // golden angle spreads them evenly
                      readonly property real speed: (Style.space(60) + ((index * 37) % 70) * Style.space(1)) * (chip.surprise ? 1.8 : 1) * (1 + (chip.magnitude - 1) * 0.8)
                      readonly property real e: 1 - Math.pow(1 - confetti.t, 2)
                      readonly property bool sparkle: index % 4 === 0
                      x: Math.cos(ang) * speed * e
                      y: Math.sin(ang) * speed * e * 0.8 + Style.space(70) * confetti.t * confetti.t
                      rotation: index * 41 + confetti.t * 360 * (index % 2 ? 1 : -1)
                      opacity: confetti.t < 0.6 ? 1 : Math.max(0, (1 - confetti.t) / 0.4)
                      Rectangle {
                        visible: !parent.sparkle
                        anchors.centerIn: parent
                        width: Style.space(5 + index % 3)
                        height: Style.space(8 + index % 4)
                        radius: 1
                        color: (chip.surprise ? root.surpriseConfetti : root.scheduledConfetti)[index % (chip.surprise ? 10 : 6)]
                      }
                      Text {
                        visible: parent.sparkle
                        anchors.centerIn: parent
                        textFormat: Text.PlainText
                        text: "\u2726"
                        color: (chip.surprise ? root.surpriseSparkles : root.scheduledSparkles)[index % 3]
                        font.pixelSize: Style.font.title
                      }
                    }
                  }
                }
              }
            }
          }

          Text {
            visible: root.agents.length === 0 && !root.settingsOpen && !root.subView
            width: parent.width
            topPadding: Style.space(24)
            text: "No supported agent CLIs found."
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            horizontalAlignment: Text.AlignHCenter
          }

          // ---------------- Header: name + plan, with the settings gear at the right
          Item {
            id: headerRow
            visible: !root.subView
            width: parent.width
            height: headerName.implicitHeight

            Row {
              visible: root.showDetail
              spacing: Style.space(10)
              anchors.verticalCenter: parent.verticalCenter
              Text {
                id: headerName
                textFormat: Text.PlainText
                text: root.agent ? root.agent.name : ""
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.title
                font.bold: true
              }
              Text {
                textFormat: Text.PlainText
                anchors.baseline: parent.children[0].baseline
                text: root.agent && root.agent.plan ? root.agent.plan : ""
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
              }
            }
            Text {
              visible: root.settingsOpen
              anchors.verticalCenter: parent.verticalCenter
              textFormat: Text.PlainText
              text: "Settings"
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.title
              font.bold: true
            }
          }

          // ---------------- Settings view: replaces the agent details while open
          Column {
            id: settingsView
            visible: root.settingsOpen
            width: parent.width
            spacing: Style.space(8)

            PanelSectionHeader { width: parent.width; text: "DISPLAY" }
            SettingSwitch {
              width: parent.width
              label: "Hide agents that aren't installed"
              checked: root.hideUninstalled
              onToggled: root.writeSetting(["hideUninstalledAgents", String(!root.hideUninstalled)])
            }
            SettingSwitch {
              width: parent.width
              label: "Show unused models"
              checked: root.showUnusedModels
              onToggled: root.writeSetting(["showUnusedModels", String(!root.showUnusedModels)])
            }

            PanelSectionHeader { width: parent.width; text: "ALERTS" }
            SettingSwitch {
              width: parent.width
              label: "Write a handoff note near the limit"
              checked: root.handoffNote
              onToggled: root.writeSetting(["handoffNote", String(!root.handoffNote)])
            }
            SettingSwitch {
              width: parent.width
              label: "Angry robot when the default agent is out"
              checked: root.angryRobot
              onToggled: root.writeSetting(["angryRobot", String(!root.angryRobot)])
            }

            PanelSectionHeader { width: parent.width; text: "RESET CELEBRATION" }
            SettingSwitch {
              width: parent.width
              label: "Reset animation"
              checked: root.resetAnimation
              onToggled: root.writeSetting(["resetAnimation", String(!root.resetAnimation)])
            }
            SettingSwitch {
              width: parent.width
              label: "Open panel on reset"
              checked: root.autoOpenOnReset
              onToggled: root.writeSetting(["autoOpenOnReset", String(!root.autoOpenOnReset)])
            }
            SettingSwitch {
              width: parent.width
              label: "Reset sound"
              checked: root.resetSound
              onToggled: root.writeSetting(["resetSound", String(!root.resetSound)])
            }
            VolumeRow {
              width: parent.width
              enabled: root.resetSound
              volume: root.resetVolume
              onStep: function(delta) { root.writeSetting(["volume", String(Math.max(0, Math.min(100, root.resetVolume + delta)))]) }
              onPlay: root.playTest()
            }
            // Replays each kind of celebration on demand.
            Flow {
              width: parent.width
              spacing: Style.space(8)
              Repeater {
                model: root.testButtons
                Rectangle {
                  required property var modelData
                  width: testLabel.implicitWidth + Style.space(24)
                  height: testLabel.implicitHeight + Style.space(14)
                  radius: Style.cornerRadius
                  color: testArea.containsMouse ? root.track : "transparent"
                  border.width: 1
                  border.color: root.foreground
                  Text {
                    id: testLabel
                    anchors.centerIn: parent
                    textFormat: Text.PlainText
                    text: modelData.text
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                  }
                  MouseArea {
                    id: testArea
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.pressTest(modelData)
                  }
                }
              }
            }

            PanelSectionHeader { width: parent.width; text: "TABS" }
            // One switch per agent, two to a row to keep the menu short. Reorder by dragging the chips.
            Flow {
              width: parent.width
              spacing: Style.space(16)
              Repeater {
                model: root.allOrdered
                SettingSwitch {
                  required property var modelData
                  width: (settingsView.width - Style.space(16)) / 2
                  label: modelData.name + (modelData.installed === false ? " (not installed)" : "")
                  // Only an installed agent can be hidden by choice; an uninstalled
                  // one follows "Hide agents that aren't installed".
                  enabled: modelData.installed !== false
                  checked: root.isShownTab(modelData)
                  onToggled: root.writeSetting(["hidden", modelData.id, String(root.isShownTab(modelData))])
                }
              }
            }
            // Restores the default order: Claude Code, Antigravity, Grok, Codex, and the rest.
            Rectangle {
              width: resetOrderLabel.implicitWidth + Style.space(24)
              height: resetOrderLabel.implicitHeight + Style.space(14)
              radius: Style.cornerRadius
              color: resetOrderArea.containsMouse ? root.track : "transparent"
              border.width: 1
              border.color: root.foreground
              Text {
                id: resetOrderLabel
                anchors.centerIn: parent
                textFormat: Text.PlainText
                text: "Reset order"
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
              }
              MouseArea { id: resetOrderArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: root.resetOrder() }
              PanelToolTip { visible: resetOrderArea.containsMouse; text: "Back to Claude Code, Antigravity, Grok, Codex, and the rest"; fontFamily: root.fontFamily }
            }
            Text {
              width: parent.width
              textFormat: Text.PlainText
              text: "Drag a chip to reorder; the first tab becomes Omarchy's default agent. A tab you hide stays hidden until you show it again. Agents you install later appear automatically, at the end."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }
            Text {
              visible: root.pluginVersion !== ""
              width: parent.width
              textFormat: Text.PlainText
              text: "Cook Meter v" + root.pluginVersion
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }
          }

          // A small red-flag note when this tab's data couldn't be read or didn't
          // match what's expected. Details are in collector.log.
          Text {
            visible: root.showDetail && String(root.agent.dataWarning || "") !== ""
            width: parent.width
            textFormat: Text.PlainText
            text: "\u26a0 Data looks wrong - details in collector.log"
            color: root.amber
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }

          // Plan / free-tier note: what the agent's own tool reports, text from models.json.
          Text {
            visible: root.showDetail && String(root.agent.planNote || "") !== ""
            width: parent.width
            textFormat: Text.PlainText
            text: root.agent ? String(root.agent.planNote || "") : ""
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }

          // What this tab cannot read, said plainly (only while it has no meters of its own to show).
          Text {
            visible: root.showDetail && String(root.agent.cantRead || "") !== ""
            width: parent.width
            textFormat: Text.PlainText
            text: root.agent ? String(root.agent.cantRead || "") : ""
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }

          // One-line status, never an error card.
          Text {
            visible: root.showDetail && String(root.agent.status || "") !== ""
            width: parent.width
            textFormat: Text.PlainText
            text: root.agent ? String(root.agent.status || "") : ""
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }

          // An unsure tab says why it isn't green.
          Text {
            visible: root.showDetail && root.unsureReason(root.agent) !== ""
            width: parent.width
            textFormat: Text.PlainText
            text: "Unsure: " + root.unsureReason(root.agent)
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }

          // A gray tab says why it has no data.
          Text {
            visible: root.showDetail && root.grayReason(root.agent) !== ""
            width: parent.width
            textFormat: Text.PlainText
            text: root.grayReason(root.agent)
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }

          // ...and one small button that goes straight to the fix (styled like the Install Claude Squad tile).
          Rectangle {
            id: fixTile
            readonly property var fix: root.grayFix(root.agent)
            visible: root.showDetail && fix !== null
            width: fixLabel.implicitWidth + Style.space(22)
            height: fixLabel.implicitHeight + Style.space(14)
            radius: Style.cornerRadius
            color: fixArea.containsMouse ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.14) : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.05)
            Text {
              id: fixLabel
              anchors.centerIn: parent
              textFormat: Text.PlainText
              text: fixTile.fix ? fixTile.fix.label : ""
              color: fixArea.containsMouse ? Color.accent : root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              font.bold: true
            }
            MouseArea { id: fixArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: root.runFix(fixTile.fix) }
            PanelToolTip { visible: fixArea.containsMouse && fixTile.fix !== null; text: fixTile.fix ? fixTile.fix.tip : ""; fontFamily: root.fontFamily }
          }

          PanelSeparator { foreground: root.foreground; visible: root.showDetail }

          // ---------------- Limits
          Column {
            visible: root.showDetail && !root.hasAccounts && (root.agent.limits || []).length > 0
            width: parent.width
            spacing: Style.space(10)

            PanelSectionHeader { width: parent.width; text: "LIMITS" }

            Repeater {
              model: root.agent ? (root.agent.limits || []) : []

              LimitRow {
                required property var modelData
                limit: modelData
                width: column.width
              }            }
          }

          // ---------------- Accounts: one block per account, active one marked
          Column {
            visible: root.showDetail && root.hasAccounts
            width: parent.width
            spacing: Style.space(12)

            PanelSectionHeader { width: parent.width; text: "ACCOUNTS" }

            Repeater {
              model: root.hasAccounts ? root.agent.accounts : []

              Column {
                id: acct
                required property var modelData
                required property int index
                width: column.width
                spacing: Style.space(8)

                PanelSeparator { foreground: root.foreground; visible: acct.index > 0 }

                Item {
                  width: parent.width
                  height: Math.max(acctName.implicitHeight, activeTag.implicitHeight)
                  Row {
                    spacing: Style.space(8)
                    anchors.verticalCenter: parent.verticalCenter
                    Text {
                      id: acctName
                      textFormat: Text.PlainText
                      text: acct.modelData.label
                      color: root.foreground
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.body
                      font.bold: true
                    }
                    Text {
                      anchors.baseline: acctName.baseline
                      textFormat: Text.PlainText
                      text: acct.modelData.plan
                      color: root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                    }
                  }
                  Text {
                    id: activeTag
                    visible: !!acct.modelData.active
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    textFormat: Text.PlainText
                    text: "ACTIVE"
                    color: root.green
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    font.bold: true
                  }
                }

                Repeater {
                  model: acct.modelData.limits || []
                  LimitRow {
                    required property var modelData
                    limit: modelData
                    width: column.width
                  }
                }
                Text {
                  visible: (acct.modelData.limits || []).length === 0
                  textFormat: Text.PlainText
                  text: "No limits reported for this account."
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }
              }
            }
          }

          // ---------------- Banked limit resets: only when the account has them
          Item {
            visible: root.showDetail && !!root.agent.resets && Number(root.agent.resets.left) > 0
            width: parent.width
            height: visible ? resetsLabel.implicitHeight : 0
            Text {
              id: resetsLabel
              textFormat: Text.PlainText
              text: "Resets"
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
            }
            Text {
              anchors.right: parent.right
              textFormat: Text.PlainText
              text: {
                var r = root.agent && root.agent.resets ? root.agent.resets : null
                if (!r) return ""
                var t = r.left + " left"
                var d = new Date(String(r.expiresAt || ""))
                if (!isNaN(d.getTime()))
                  t += " · use by " + ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()] + " " + d.getDate()
                return t
              }
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              font.bold: true
            }
          }

          // ---------------- Models: every model this agent can use. Unused ones
          // are dimmed with a 0; ones the plan can't use say "unavailable" (never 0).
          Column {
            visible: root.showDetail && root.allModelRows(root.agent).length > 0
            width: parent.width
            spacing: Style.space(6)

            PanelSectionHeader {
              width: parent.width
              text: "MODELS" + (root.agent && root.agent.modelScope ? " · " + String(root.agent.modelScope).toUpperCase() : "")
            }

            Repeater {
              model: root.modelRowsFor(root.agent)

              Item {
                id: modelRow
                required property var modelData
                readonly property string badge: root.removingText(modelData)
                width: column.width
                height: Math.max(modelName.implicitHeight, modelRight.implicitHeight) + Style.space(2)
                opacity: modelData.state === "used" ? 1 : 0.4

                Text {
                  id: modelName
                  width: parent.width - modelRight.implicitWidth - modelBadge.implicitWidth - Style.space(modelBadge.visible ? 22 : 12)
                  textFormat: Text.PlainText
                  text: modelData.name
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  wrapMode: Text.WrapAnywhere
                }
                Text {
                  id: modelBadge
                  visible: modelRow.badge !== ""
                  anchors.left: modelName.left
                  anchors.leftMargin: Math.min(modelName.contentWidth, modelName.width) + Style.space(8)
                  anchors.verticalCenter: modelName.verticalCenter
                  textFormat: Text.PlainText
                  text: modelRow.badge
                  color: root.amber
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }
                Text {
                  id: modelRight
                  anchors.right: parent.right
                  textFormat: Text.PlainText
                  text: modelData.state === "unavailable" ? "unavailable" : root.fmtTokens(modelData.total)
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  font.italic: modelData.state === "unavailable"
                }
                MouseArea { id: modelHover; anchors.fill: parent; hoverEnabled: true; acceptedButtons: Qt.NoButton }
                PanelToolTip {
                  visible: modelHover.containsMouse && (modelData.state === "used" || !!modelData.tip)
                  fontFamily: root.fontFamily
                  text: (modelData.tip ? modelData.tip + (modelData.state === "used" ? "\n" : "") : "") + (modelData.state !== "used" ? "" : "In " + root.fmtTokens(modelData.input) + " · out " + root.fmtTokens(modelData.output) + " · cache read " + root.fmtTokens(modelData.cacheRead) + " · cache write " + root.fmtTokens(modelData.cacheWrite))
                }
              }
            }

            // Long lists (Devin, OpenCode) stay short until you ask for the rest.
            Item {
              visible: root.allModelRows(root.agent).length > root.modelsCollapsedCount
              width: parent.width
              height: moreLabel.implicitHeight + Style.space(6)
              Text {
                id: moreLabel
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.PlainText
                text: root.modelsExpanded ? "▾ Show fewer" : "▸ " + (root.allModelRows(root.agent).length - root.modelsCollapsedCount) + " more models"
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
              MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.modelsExpanded = !root.modelsExpanded }
            }
          }

          // ---------------- Tokens by day: collapsible, closed by default,
          // today's total stays visible in the header either way.
          Column {
            visible: root.showDetail && root.agent.hasTokens !== false
            width: parent.width
            spacing: Style.space(6)

            PanelSeparator { foreground: root.foreground }

            Item {
              width: parent.width
              height: dayHeader.implicitHeight + Style.space(10)

              Text {
                id: dayHeader
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.PlainText
                text: (root.daysOpen ? "▾ " : "▸ ") + "TOKENS BY DAY"
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                font.bold: true
              }
              Text {
                anchors.verticalCenter: parent.verticalCenter
                anchors.right: parent.right
                textFormat: Text.PlainText
                text: "Today " + root.fmtTokens(root.agent ? root.agent.today : 0)
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                font.bold: true
              }
              MouseArea {
                anchors.fill: parent
                cursorShape: Qt.PointingHandCursor
                onClicked: root.daysOpen = !root.daysOpen
              }
            }

            Column {
              id: dayList
              visible: root.daysOpen
              width: parent.width
              spacing: Style.space(4)

              readonly property var days: root.agent ? (root.agent.days || []) : []
              readonly property real peak: {
                var p = 0
                for (var i = 0; i < days.length; i++) p = Math.max(p, Number(days[i].tokens) || 0)
                return p
              }

              Repeater {
                model: parent.days

                Item {
                  required property var modelData
                  required property int index
                  readonly property bool isToday: index === dayList.days.length - 1
                  width: column.width
                  height: Style.space(20)

                  Text {
                    id: dName
                    width: Style.space(48)
                    anchors.verticalCenter: parent.verticalCenter
                    textFormat: Text.PlainText
                    text: root.dayLabel(modelData.date, isToday)
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                    font.bold: isToday
                  }
                  Rectangle {
                    anchors.verticalCenter: parent.verticalCenter
                    x: dName.width + Style.space(6)
                    width: Math.max(0, parent.width - dName.width - dTotal.width - Style.space(18)) * (dayList.peak > 0 ? (Number(modelData.tokens) || 0) / dayList.peak : 0)
                    height: Style.space(6)
                    radius: height / 2
                    color: root.foreground
                    opacity: 0.55
                  }
                  Text {
                    id: dTotal
                    width: Style.space(56)
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    horizontalAlignment: Text.AlignRight
                    textFormat: Text.PlainText
                    text: root.fmtTokens(modelData.tokens)
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                    font.bold: isToday
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
