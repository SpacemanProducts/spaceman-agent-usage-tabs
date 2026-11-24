import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "chip-meters.js" as ChipMeters
import "tab-order.js" as TabOrder
import "fixes.js" as Fixes
import "usage-colors.js" as UsageColors

// Cook Meter (plugin id spaceman.agent-usage-tabs). Display only: bin/collect.mjs writes data.json, this file
// watches it. Written from scratch; shares no code or state with other plugins.
Panel {
  id: root
  moduleName: "spaceman.agent-usage-tabs"
  ipcTarget: "spaceman.agent-usage-tabs"
  manageIpc: false
  Commons.Translations { id: strings; directory: Qt.resolvedUrl("i18n") }

  // Everything follows the active Omarchy theme live: text, background and border come from the
  // theme's popup colors, icons from its accent, meter colors from usage-colors.js palettes that
  // adapt to each surface. The only fixed colors left are the celebration palettes below, which
  // have a dark-background and a light-background variant.
  readonly property color foreground: Color.popups.text
  readonly property color panelBackground: Color.popups.background
  // Secondary text: the text color pulled toward the background (works on dark and light themes).
  readonly property color dim: Qt.tint(foreground, Qt.rgba(panelBackground.r, panelBackground.g, panelBackground.b, 0.4))
  readonly property color track: Style.selectedFillFor(foreground, Color.accent)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  function safeTooltipText(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  }
  function pluginText(key) { return strings.t(key) }

  // Meter colors: green < 60%, amber 60-85%, red > 85%. Each surface gets its own
  // palette from usage-colors.js, which picks the bright or deep set for the
  // theme's background and adjusts any color that wouldn't read (>= 4.5:1).
  readonly property var panelUsage: UsageColors.palette(panelBackground, Color.background)
  readonly property var barUsage: UsageColors.palette(Color.bar.background, Color.background)
  readonly property bool lightPanel: panelUsage.light
  readonly property bool lightBar: barUsage.light
  readonly property color green: panelUsage.low
  readonly property color amber: panelUsage.mid
  readonly property color red: panelUsage.high
  function soft(c, a) { return Qt.rgba(c.r, c.g, c.b, a) }
  function meterColorFor(p, pal) { return UsageColors.forLevel(p, pal || panelUsage) }
  function meterColor(p) { return meterColorFor(p, panelUsage) }
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
  readonly property string antigravitySurprisePath: (Quickshell.env("XDG_STATE_HOME") || home + "/.local/state") + "/omarchy/agent-usage-tabs/antigravity-surprise.json"
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
  property var antigravitySurpriseState: null
  property double detectedSurpriseAt: 0
  property bool detectedSurpriseWhileOpen: false
  // Opens the panel on this agent's tab for a reset, without stealing focus.
  // If the user already has the panel open, it only switches to that tab.
  function autoCelebrate(id) {
    if (!autoOpenOnReset) return
    var shown = false
    for (var i = 0; i < agents.length; i++) if (agents[i].id === id) shown = true
    if (!shown) return                               // that tab is hidden: respect it
    selectedId = id; daysOpen = false; modelsExpanded = false; settingsOpen = false; welcomeOpen = false
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
  // The bar robot looks angry (theme red) while the default agent has a limit used up.
  readonly property bool angryRobot: userSettings.angryRobot !== undefined
    ? userSettings.angryRobot !== false : root.setting("angryRobot", true) !== false
  property bool testAngry: false   // set for 8 s by the testAngry IPC hook, to check the look in the real bar
  readonly property bool robotAngry: angryRobot && (Math.max(barSession, barWeekly) >= 1 || testAngry)
  Timer { id: testAngryTimer; interval: 8000; onTriggered: root.testAngry = false }
  readonly property bool resetAnimation: userSettings.resetAnimation !== undefined
    ? userSettings.resetAnimation !== false : root.setting("resetAnimation", true) !== false
  // Start launches the default agent with its skip-permissions flag (on by default).
  readonly property bool skipPermissions: userSettings.skipPermissions !== undefined
    ? userSettings.skipPermissions !== false : root.setting("skipPermissions", true) !== false
  // Settings (the gear), + (add an account), >_ (start the default agent), CS (Claude Squad), C (Constance)
  // and the first-run welcome each open as their own screen: the chips and usage are hidden and the header has a
  // Back button. Only one is open at a time.
  property bool welcomeOpen: false
  property bool settingsLoaded: false
  readonly property bool subView: squadOpen || addOpen || settingsOpen || agentHereOpen || constanceOpen || welcomeOpen
  function leaveSubView() { squadOpen = false; addOpen = false; settingsOpen = false; agentHereOpen = false; constanceOpen = false; welcomeOpen = false }
  function openSettings() { settingsOpen = true; squadOpen = false; addOpen = false; agentHereOpen = false; constanceOpen = false; welcomeOpen = false }
  // The welcome screen opens on the first panel open after install (and again on later opens until its
  // "Got it" button writes welcomeDismissed). Auto-opened reset panels never trigger it.
  function maybeShowWelcome() {
    if (!settingsLoaded || userSettings.welcomeDismissed === true) return
    if (!opened || autoOpened || subView) return
    squadOpen = false; addOpen = false; settingsOpen = false; agentHereOpen = false; constanceOpen = false
    welcomeOpen = true
  }
  function dismissWelcome() { writeSetting(["welcomeDismissed", "true"]); welcomeOpen = false }
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
    var before = agents.length > 0 ? agents[0].id : ""
    var after = TabOrder.moveTo(vis, id, toVisibleIndex)
    saveOrder(TabOrder.mergeVisible(allIds(), after))
    // A drop into the first spot makes that tab the default agent: select it
    // right away so the details and the bar switch with the order.
    var sel = TabOrder.selectAfterDrop(before, after)
    if (sel !== "") selectedId = sel
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
  // The bar icon mirrors the agent's tab chip: chipMeters gives the same
  // session and weekly readings the chip's borders color from, and each takes
  // the chip's tint — the outside border's session color and the inside
  // fill's weekly color. The percentage and the button's active state (its
  // underline) wear the border color; the robot wears the inside color. The
  // tint rule is the chip's own (tintFor: unsure readings never go green),
  // picked for the bar's lightness. -1 means the agent reports nothing.
  readonly property var barMeters: ChipMeters.chipMeters(barAgent)
  readonly property real barSession: barMeters.session
  readonly property real barWeekly: barMeters.weekly
  readonly property bool barHasData: barSession >= 0 || barWeekly >= 0
  readonly property bool barUnsure: root.unsureReason(barAgent) !== ""
  function barTintFor(p) { return barUnsure && p < 0.6 ? root.unsureColor : root.meterColorFor(p, root.barUsage) }
  readonly property color barSessionColor: barSession >= 0 ? barTintFor(barSession) : root.barForeground
  readonly property color barRobotColor: barWeekly >= 0 ? barTintFor(barWeekly) : root.barForeground
  // The tooltip names the agent the bar represents and shows both numbers.
  readonly property string barTooltip: !barAgent ? "No agent selected"
    : "Bar shows " + defaultAgentName + (barHasData
      ? " — session " + (barSession >= 0 ? Math.round(barSession * 100) + "%" : "not reported")
        + " · weekly " + (barWeekly >= 0 ? Math.round(barWeekly * 100) + "%" : "not reported")
      : " — no limits reported")
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
  function checkAntigravitySurprise() {
    var s = antigravitySurpriseState
    if (!s || Number(s.at) <= 0 || Number(s.playedAt) === Number(s.at)) return
    if (Number(s.clickedAt) === Number(s.at)) {
      playAntigravitySurprise(Number(s.at), true)
      return
    }
    if (detectedSurpriseAt === Number(s.at) && detectedSurpriseWhileOpen)
      playAntigravitySurprise(Number(s.at), false)
  }
  function playAntigravitySurprise(at, fromClick) {
    var s = antigravitySurpriseState
    if (!s || Number(s.at) !== at || Number(s.playedAt) === at) return
    if (!fromClick && (!opened || detectedSurpriseAt !== at || !detectedSurpriseWhileOpen)) return
    selectedId = "antigravity"
    daysOpen = false; modelsExpanded = false; settingsOpen = false; welcomeOpen = false
    if (fromClick && !opened) {
      autoOpened = true
      open()
      autoCloseTimer.restart()
    }
    var agent = null
    for (var i = 0; i < rawAgents.length; i++) if (rawAgents[i].id === "antigravity") agent = rawAgents[i]
    var now = Date.now()
    flashNow = now
    var times = Object.assign({}, testResets); times.antigravity = now; testResets = times
    var kinds = Object.assign({}, testKinds)
    kinds.antigravity = { at: now, kind: "surprise", magnitude: Number(agent && agent.resetMagnitude) || 1 }
    testKinds = kinds
    var updated = Object.assign({}, s); updated.playedAt = at; antigravitySurpriseState = updated
    surpriseStateWriter.command = ["node", pluginDir + "/bin/antigravity-surprise.mjs", "played", String(at)]
    surpriseStateWriter.running = true
    if (resetSound) playTest("jackpot.wav")
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
    welcomeOpen = false
  }

  // Header buttons, as in the stock panel's hero corner.
  // +  Omarchy's add-subscription flow in a terminal (for the selected tab's provider when it has one).
  // >_ the default agent, exactly as the stock button starts it (`omarchy-agent --pick`).
  // The + button opens a short picker of the agents Omarchy can add an account for; picking one runs Omarchy's own
  // add-account flow for it in a terminal. (It used to jump straight to the selected tab's provider.)
  property bool addOpen: false
  readonly property var addProviders: [{ id: "claude", name: "Claude Code" }, { id: "codex", name: "Codex" }, { id: "grok", name: "Grok" }]
  function toggleAdd() { addOpen = !addOpen; if (addOpen) { squadOpen = false; settingsOpen = false; agentHereOpen = false; constanceOpen = false; welcomeOpen = false } }
  function addSubscription(provider) {
    if (!root.bar || !provider) return
    root.bar.run("omarchy-launch-floating-terminal-with-presentation bash " + pluginDir + "/bin/add-account.sh " + provider)
    close()
  }
  // The header >_ button opens its own screen: the same folder picker as CS, then Start runs the default agent in a tiled
  // terminal there (bin/agent-here.sh, in the stock agent window class org.omarchy.agent). The bar's right-click and the
  // keyboard shortcut are Omarchy's own and still start it at once, with no picker.
  property bool agentHereOpen: false
  property var folderUsageRecords: []
  property double folderUsageRefreshedAt: 0
  property var folderPins: []
  property var folderRestored: []
  property var hiddenFolderTimes: ({})
  property bool folderPreferencesReady: false
  readonly property bool folderPreferenceBusy: folderPreferenceAction.running
  property bool showHiddenFolders: false
  property var folderPickerEntries: []
  property var folderPickerByFolder: ({})
  property var folderPickerGroups: ({})
  property bool folderPickerReady: false
  property bool folderPickerScanQueued: false
  property string folderPickerScanKey: ""
  function folderActivityByPath() {
    var latest = ({})
    var now = Date.now(), cutoff = now - 7 * 86400000
    if (folderUsageRefreshedAt <= 0 || folderUsageRefreshedAt > now + 60000 || now - folderUsageRefreshedAt > 7 * 86400000) return latest
    folderUsageRecords.forEach(function(record) {
      if (!record || typeof record !== "object" || typeof record.folder !== "string") return
      var at = Number(record.time)
      if (!isFinite(at) || at < cutoff || at > now + 60000) return
      latest[record.folder] = Math.max(Number(latest[record.folder]) || 0, at)
    })
    return latest
  }
  function folderPickerEntry(folder) { return folderPickerByFolder[folder] || null }
  function folderIsPinned(folder) {
    var entry = folderPickerEntry(folder)
    return entry ? !!entry.pinned : folderPins.indexOf(folder) >= 0
  }
  function folderManualHidden(entry) {
    return !!entry && isFinite(Number(entry.hiddenAt)) && Number(entry.activity || 0) <= Number(entry.hiddenAt)
  }
  function folderDefaultHidden(entry) {
    if (!entry) return true
    if (entry.keep) return false
    if (entry.system) return !(entry.pinned || entry.picked || entry.restored)
    return !(entry.pinned || entry.picked || entry.project || entry.restored)
  }
  function folderEntryVisible(entry) { return !!entry && !folderManualHidden(entry) && !folderDefaultHidden(entry) }
  function folderCandidates() {
    var folders = squadRepos.slice()
    function add(folder) {
      if (typeof folder === "string" && folder.charAt(0) === "/" && folders.indexOf(folder) < 0) folders.push(folder)
    }
    Object.keys(folderActivityByPath()).forEach(add)
    folderUsageRecords.forEach(function(record) { if (record && typeof record === "object") add(record.folder) })
    folderPins.forEach(add)
    root.folderRestored.forEach(add)
    Object.keys(hiddenFolderTimes).forEach(add)
    return folders
  }
  function refreshFolderPickerScan(force) {
    var candidates = folderCandidates()
    var key = candidates.join("\n")
    if (folderPickerScan.running) {
      if (force || key !== folderPickerScanKey) folderPickerScanQueued = true
      return
    }
    if (!force && folderPickerReady && key === folderPickerScanKey) return
    folderPickerScanKey = key
    folderPickerScan.command = ["python3", pluginDir + "/bin/folder-picker.py", "scan", "--keep", root.pluginDir, "--keep", root.home].concat(candidates)
    folderPickerScan.running = true
  }
  function ensureVisibleStartFolder() {
    if (!agentHereOpen || squadNewName !== "" || squadRepo === home) return
    if (squadRepo !== "" && (squadRepos.indexOf(squadRepo) >= 0 || folderPickerByFolder[squadRepo])) return
    var folders = startFolderRepos()
    squadRepo = folders.length ? folders[0] : home
  }
  function startFolderRepos() {
    if (!folderPickerReady) return []
    var ranked = []
    folderPickerEntries.forEach(function(entry, index) {
      if (entry.folder === root.home) return
      if (folderEntryVisible(entry)) ranked.push({ entry: entry, index: index })
    })
    ranked.sort(function(a, b) {
      var aPinned = !!a.entry.pinned, bPinned = !!b.entry.pinned
      if (aPinned !== bPinned) return aPinned ? -1 : 1
      var recent = Number(b.entry.activity || 0) - Number(a.entry.activity || 0)
      return recent || a.index - b.index || a.entry.folder.localeCompare(b.entry.folder)
    })
    return ranked.map(function(item) { return item.entry.folder })
  }
  function hiddenFolderRepos() {
    if (!folderPickerReady) return []
    var ranked = []
    folderPickerEntries.forEach(function(entry, index) {
      if (entry.folder === root.home) return
      if (!folderEntryVisible(entry)) ranked.push({ entry: entry, index: index })
    })
    ranked.sort(function(a, b) {
      var recent = Number(b.entry.activity || 0) - Number(a.entry.activity || 0)
      return recent || a.index - b.index || a.entry.folder.localeCompare(b.entry.folder)
    })
    return ranked.map(function(item) { return item.entry.folder })
  }
  function runFolderPreferenceAction(args) {
    if (!folderPreferencesReady || folderPreferenceAction.running) return
    folderPreferenceAction.command = ["python3", pluginDir + "/bin/folder-preferences.py"].concat(args)
    folderPreferenceAction.running = true
  }
  function toggleFolderPin(folder) {
    runFolderPreferenceAction([folderIsPinned(folder) ? "unpin" : "pin", folder])
  }
  function hideFolder(folder) {
    var entry = folderPickerEntry(folder)
    var activity = entry ? Number(entry.activity || 0) : Number(folderActivityByPath()[folder]) || 0
    runFolderPreferenceAction(["hide", folder, String(activity)])
  }
  function restoreFolder(folder) {
    runFolderPreferenceAction(["restore", folder])
  }
  function folderUsageEntries(folder) {
    if (folderUsageRefreshedAt <= 0 || folderUsageRefreshedAt > Date.now() + 60000 || Date.now() - folderUsageRefreshedAt > 7 * 86400000) return []
    var totals = ({})
    folderUsageRecords.forEach(function(record) {
      if (!record || typeof record !== "object") return
      var group = root.folderPickerGroups[record.folder]
      if ((group === undefined ? record.folder : group) !== folder) return
      var id = String(record.agent || "")
      var amount = Number(record.amount), unit = id === "copilot" ? "AIC" : "tokens"
      if (!rawAgents.some(function(a) { return a.id === id }) || !isFinite(amount) || amount <= 0 || record.unit !== unit) return
      if (!totals[id]) totals[id] = { amount: 0, unit: unit }
      totals[id].amount += amount
    })
    var order = rawAgents.map(function(a) { return a.id })
    var ids = Object.keys(totals)
    var first = barAgent ? barAgent.id : ""
    ids.sort(function(a, b) {
      if (a === b) return 0
      if (a === first) return -1
      if (b === first) return 1
      if (a === "copilot") return -1
      if (b === "copilot") return 1
      var ai = order.indexOf(a), bi = order.indexOf(b)
      return (ai < 0 ? order.length : ai) - (bi < 0 ? order.length : bi) || a.localeCompare(b)
    })
    return ids.map(function(id) {
      var amount = totals[id].amount, unit = totals[id].unit
      var name = id
      for (var i = 0; i < rawAgents.length; i++) if (rawAgents[i].id === id) { name = rawAgents[i].name || id; break }
      var shortNames = { claude: "Claude", codex: "Codex", copilot: "Copilot", grok: "Grok", devin: "Devin", opencode: "OpenCode" }
      if (shortNames[id]) name = shortNames[id]
      var value
      if (unit === "AIC") value = (amount < 10 ? amount.toFixed(2) : amount.toFixed(1)).replace(/\.?0+$/, "")
      else if (amount >= 1000000) value = (amount / 1000000).toFixed(1).replace(/\.0$/, "") + "M"
      else if (amount >= 1000) value = (amount / 1000).toFixed(1).replace(/\.0$/, "") + "k"
      else value = String(Math.round(amount))
      return { id: id, text: name + " " + value + (unit === "AIC" ? " AIC" : "") }
    })
  }
  function refreshFolderUsage() {
    if (!folderUsageRefresh.running) folderUsageRefresh.running = true
    if (!folderPreferencesRead.running) folderPreferencesRead.running = true
    refreshFolderPickerScan(true)
  }
  function toggleAgentHere() {
    agentHereOpen = !agentHereOpen
    if (agentHereOpen) {
      squadOpen = false; addOpen = false; settingsOpen = false; constanceOpen = false; welcomeOpen = false
      squadRepo = ""; squadNewName = ""
      if (!repoLister.running) repoLister.running = true
      if (!zenityCheck.running) zenityCheck.running = true
      refreshFolderUsage()
    }
  }
  readonly property bool agentHereReady: squadRepo !== "" || squadNewName !== "" || agentHereOpen
  function agentHereCommand() {
    var env = squadNewName !== "" ? "AGENT_NEW=" + squadNewName : "AGENT_DIR=" + (squadRepo !== "" ? squadRepo : root.home)
    return ["omarchy-launch-tui", "--app-id=org.omarchy.agent", "env", env, "bash", pluginDir + "/bin/agent-here.sh"]
  }
  // Start runs the launcher through bin/launch-wait.sh, which confirms a window of the agent app-id really appeared (on any
  // workspace). The panel closes only then; if it fails, the reason shows in the panel instead of nothing happening.
  property string agentHereError: ""
  property bool agentHereStarting: false
  function launchAgentHere() {
    if (!agentHereReady || agentLauncher.running) return
    agentHereError = ""
    agentHereStarting = true
    agentLauncher.command = ["bash", pluginDir + "/bin/launch-wait.sh", "org.omarchy.agent", "12"].concat(agentHereCommand())
    agentLauncher.running = true
  }
  Process {
    id: agentLauncher
    running: false
    stderr: StdioCollector { id: agentLauncherErr }
    onExited: function(code) {
      root.agentHereStarting = false
      if (code === 0) root.close()
      else root.agentHereError = String(agentLauncherErr.text).trim() || ("The terminal didn't open (exit " + code + ").")
    }
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
        root.refreshFolderPickerScan(true)
        root.ensureVisibleStartFolder()
      }
    }
  }
  Process {
    id: folderUsageRefresh
    command: ["python3", pluginDir + "/bin/folder-usage.py"]
    stderr: StdioCollector { id: folderUsageRefreshErr }
    onExited: function(code) {
      if (code !== 0) console.warn("usage-tabs: folder usage refresh failed: " + String(folderUsageRefreshErr.text).trim())
    }
  }
  Process {
    id: folderPreferencesRead
    command: ["python3", pluginDir + "/bin/folder-preferences.py", "list"]
    stdout: StdioCollector { id: folderPreferencesOutput }
    stderr: StdioCollector { id: folderPreferencesReadErr }
    onExited: function(code) {
      if (code !== 0) {
        root.folderPreferencesReady = false
        console.warn("usage-tabs: folder preferences couldn't be read: " + String(folderPreferencesReadErr.text).trim())
        return
      }
      try {
        var data = JSON.parse(String(folderPreferencesOutput.text || ""))
        if (!data || !Array.isArray(data.pinned) || !data.hidden || typeof data.hidden !== "object" || Array.isArray(data.hidden))
          throw new Error("invalid preferences")
        if (data.pinned.some(function(folder) { return typeof folder !== "string" || folder.charAt(0) !== "/" }))
          throw new Error("invalid pinned folder path")
        var hidden = ({})
        Object.keys(data.hidden).forEach(function(folder) {
          var at = Number(data.hidden[folder])
          if (folder.charAt(0) !== "/" || !isFinite(at) || at < 0) throw new Error("invalid hidden folder")
          hidden[folder] = at
        })
        var restored = []
        if (data.restored !== undefined) {
          if (!Array.isArray(data.restored)) throw new Error("invalid restored folders")
          data.restored.forEach(function(folder) {
            if (typeof folder !== "string" || folder.charAt(0) !== "/") throw new Error("invalid restored folder path")
            if (restored.indexOf(folder) < 0) restored.push(folder)
          })
        }
        root.folderPins = data.pinned
        root.folderRestored = restored
        root.hiddenFolderTimes = hidden
        root.folderPreferencesReady = true
        root.refreshFolderPickerScan(true)
        root.ensureVisibleStartFolder()
      } catch (e) {
        root.folderPreferencesReady = false
        console.warn("usage-tabs: folder preferences couldn't be parsed: " + String(e))
      }
    }
  }
  Process {
    id: folderPreferenceAction
    command: []
    running: false
    stderr: StdioCollector { id: folderPreferenceActionErr }
    onExited: function(code) {
      if (code !== 0) console.warn("usage-tabs: folder preference update failed: " + String(folderPreferenceActionErr.text).trim())
      else if (!folderPreferencesRead.running) folderPreferencesRead.running = true
    }
  }
  Process {
    id: folderPickerScan
    command: []
    running: false
    stdout: StdioCollector { id: folderPickerScanOut }
    stderr: StdioCollector { id: folderPickerScanErr }
    onExited: function(code) {
      root.folderPickerScanQueued = false
      if (code !== 0) {
        console.warn("usage-tabs: folder picker scan failed: " + String(folderPickerScanErr.text).trim())
      } else {
        try {
          var data = JSON.parse(String(folderPickerScanOut.text || ""))
          if (!data || !Array.isArray(data.folders)) throw new Error("invalid folder picker scan")
          var entries = [], byFolder = ({}), groups = ({})
          data.folders.forEach(function(entry) {
            if (!entry || typeof entry.folder !== "string" || entry.folder.charAt(0) !== "/") return
            entries.push(entry)
            byFolder[entry.folder] = entry
            groups[entry.folder] = entry.folder
            ;(entry.sources || []).forEach(function(source) { if (typeof source === "string") groups[source] = entry.folder })
          })
          root.folderPickerEntries = entries
          root.folderPickerByFolder = byFolder
          root.folderPickerGroups = groups
          root.folderPickerReady = true
          root.ensureVisibleStartFolder()
        } catch (e) {
          root.folderPickerReady = false
          console.warn("usage-tabs: folder picker scan couldn't be parsed: " + String(e))
        }
      }
      if (root.folderPickerScanQueued) root.refreshFolderPickerScan(true)
    }
  }
  FileView {
    path: (Quickshell.env("XDG_STATE_HOME") || root.home + "/.local/state") + "/omarchy/agent-usage-tabs/folder-usage.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      try {
        var data = JSON.parse(String(text() || ""))
        root.folderUsageRecords = Array.isArray(data.records) ? data.records : []
        root.folderUsageRefreshedAt = Number(data.refreshedAt) || 0
        root.refreshFolderPickerScan(true)
        root.ensureVisibleStartFolder()
      } catch (e) {
        root.folderUsageRecords = []
        root.folderUsageRefreshedAt = 0
        root.refreshFolderPickerScan(true)
        root.ensureVisibleStartFolder()
      }
    }
    onLoadFailed: { root.folderUsageRecords = []; root.folderUsageRefreshedAt = 0; root.refreshFolderPickerScan(true) }
  }
  Process { id: zenityCheck; command: ["bash", "-c", "command -v zenity >/dev/null"]; onExited: function(code) { root.squadZenity = code === 0 } }
  Process {
    id: folderBrowser
    command: ["zenity", "--file-selection", "--directory", "--title=Choose a folder", "--filename=" + root.home + "/Projects/"]
    // A folder picked here joins the list (selected, with its check mark), so the pick is visible and Start/Run are ready.
    stdout: StdioCollector { onStreamFinished: { var p = String(text).trim(); if (p !== "") {
      if (root.squadRepos.indexOf(p) < 0) root.squadRepos = [p].concat(root.squadRepos)
      root.squadRepo = p; root.squadNewName = ""
      root.refreshFolderPickerScan(true)
      root.ensureVisibleStartFolder() } } }
  }
  Process {
    id: nameAsker
    command: ["zenity", "--entry", "--title=New project", "--text=Name for the new project (made in ~/Projects with git set up):"]
    stdout: StdioCollector { onStreamFinished: { var n = String(text).trim(); if (n !== "" && n.indexOf("/") < 0 && n.charAt(0) !== ".") { root.squadNewName = n; root.squadRepo = "" } } }
  }
  // Same rule as Start: the panel closes only after the Claude Squad window really opened, else it shows why.
  property string squadError: ""
  property bool squadStarting: false
  Process {
    id: squadLauncher
    running: false
    stderr: StdioCollector { id: squadLauncherErr }
    onExited: function(code) {
      root.squadStarting = false
      if (code === 0) root.close()
      else root.squadError = String(squadLauncherErr.text).trim() || ("The terminal didn't open (exit " + code + ").")
    }
  }
  function shortPath(p) {
    var s = String(p)
    if (s.indexOf(root.home + "/Projects/") === 0) return s.slice((root.home + "/Projects/").length)
    return s.indexOf(root.home) === 0 ? "~" + s.slice(root.home.length) : s
  }
  function folderName(p) {
    var s = String(p).replace(/\/+$/, "")
    return s === "" || s === "/" ? s : s.slice(s.lastIndexOf("/") + 1)
  }
  Process {
    id: squadCheck
    command: ["bash", "-c", "PATH=$HOME/.local/bin:$PATH command -v cs >/dev/null"]
    onExited: function(code) { root.squadHasCs = code === 0 ? "yes" : "no" }
  }
  function toggleSquad() {
    squadOpen = !squadOpen
    if (squadOpen) { addOpen = false; settingsOpen = false; agentHereOpen = false; constanceOpen = false; welcomeOpen = false }
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
    if (!squadReady || squadLauncher.running) return
    squadError = ""
    squadStarting = true
    squadLauncher.command = ["bash", pluginDir + "/bin/launch-wait.sh", "org.omarchy.squad", "20"].concat(squadCommand())
    squadLauncher.running = true
  }

  // Constance (the C button): the owner gives her a goal; bin/constance.mjs runs her in the background as Claude Code
  // (Opus) on his paid plan, hands routine pieces to free agents under their limits, reviews what comes back and
  // reports. This screen shows the goal box, every agent and what it is working on, her pace, Stop, and the log.
  // She keeps working with the panel closed; the job file lets her pick up after a shell restart (recover, at load).
  property bool constanceOpen: false
  property bool constanceTyping: false
  // The pointer is over the log: mouse drags select text there instead of scrolling the panel.
  property bool constanceLogPointing: false
  // Copy to the clipboard with wl-copy (the text is one argument, so nothing is run through a shell).
  function copyText(t) { Quickshell.execDetached(["wl-copy", "--", String(t)]) }
  // Copy all: the whole log.jsonl, not just the entries shown, with practice prompts in full.
  function copyConstanceLog() {
    Quickshell.execDetached(["bash", "-c", 'node "$1" log | wl-copy', "copy-log", pluginDir + "/bin/constance.mjs"])
  }
  onConstanceOpenChanged: if (!constanceOpen) { goalArea.focus = false; constanceTyping = false }
  property var constance: ({ goal: null, jobs: [], agents: [], pace: null, log: [], practice: true, queue: [], signals: [] })
  property string constanceError: ""
  // Practice mode (on by default for now): she plans and logs every handoff prompt but launches nothing.
  readonly property bool constancePractice: userSettings.constancePractice !== undefined
    ? userSettings.constancePractice !== false : root.setting("constancePractice", true) !== false
  // The model she is actually running on (Opus unless the plan made her drop to a fallback).
  readonly property string constanceModel: {
    var m = root.constance.goal && root.constance.goal.model ? String(root.constance.goal.model) : "opus"
    return m.charAt(0).toUpperCase() + m.slice(1)
  }
  readonly property bool constanceActive: !!constance.goal && (constance.goal.status === "running" || constance.goal.status === "paused")
  function toggleConstance() {
    constanceOpen = !constanceOpen
    if (constanceOpen) {
      squadOpen = false; addOpen = false; settingsOpen = false; agentHereOpen = false; welcomeOpen = false
      constanceError = ""
      if (!repoLister.running) repoLister.running = true
      if (!zenityCheck.running) zenityCheck.running = true
      refreshConstance()
    }
  }
  function refreshConstance() { if (!constanceReader.running) constanceReader.running = true }
  function startConstance(goal) {
    var text = String(goal || "").trim()
    if (text === "" || constanceStarter.running) return
    constanceError = ""
    var where = squadNewName !== "" ? ["--new", squadNewName] : ["--dir", squadRepo !== "" ? squadRepo : root.home]
    constanceStarter.command = ["node", pluginDir + "/bin/constance.mjs", "start", "--goal", text].concat(where)
    constanceStarter.running = true
  }
  function stopConstance() { constanceStopper.running = true }
  // Her state dir (same one constance.mjs uses): the Keep going button drops keep-going.json here,
  // naming the window that paused her; pace() honors it until that window resets.
  readonly property string constanceDir: (Quickshell.env("XDG_STATE_HOME") || home + "/.local/state") + "/omarchy/agent-usage-tabs/constance"
  function keepConstanceGoing() {
    var p = constance.pace
    if (!p || p.mode !== "stop" || !p.title) return
    var payload = JSON.stringify({ title: p.title, resetsAt: p.until === undefined ? null : p.until, at: Date.now() })
    Quickshell.execDetached(["bash", "-c", 'mkdir -p "$1" && printf "%s" "$2" > "$1/keep-going.json"', "_", constanceDir, payload])
  }
  function constanceAgentName(id) {
    for (var i = 0; i < rawAgents.length; i++) if (rawAgents[i].id === id) return rawAgents[i].name || id
    return id
  }
  // The job an agent is running right now, or null.
  function constanceJobOf(id) {
    var js = constance.jobs || []
    for (var i = 0; i < js.length; i++) if (js[i].agent === id && js[i].status === "running") return js[i]
    return null
  }
  // One row per running or held copy of a multi-copy agent (Devin 1..10), so each worker
  // is tracked separately instead of collapsing into a single agent row.
  function constanceCopyRows(a) {
    var rows = [], js = constance.jobs || []
    for (var i = 0; i < js.length; i++) {
      var j = js[i]
      if (j.agent !== a.id || !j.worker || (j.status !== "running" && j.status !== "waiting" && j.status !== "held")) continue
      rows.push({ id: a.id, worker: j.worker, job: j, available: true, reason: "", account: (j.account && j.account.label) || a.account || "", resetsAt: null, blockTitle: null })
    }
    return rows
  }
  // "Devin copies: 3 of 10 running · 2 held: machine busy: load 7.1 on 8 cores (starts under 6.4)".
  function constanceCopiesLine(c) {
    if (!c) return ""
    var line = constanceAgentName(c.agent) + " copies: " + c.running + " of " + c.limit + " running"
    if (c.held > 0) line += " · " + c.held + " held: " + c.heldReason
    return line
  }
  function constanceGoalLine() {
    var g = constance.goal
    if (!g) return ""
    var st = { running: "Working on", paused: "Paused on", done: "Done", stopped: "Stopped", failed: "Couldn't finish" }[g.status] || g.status
    return st + ": " + g.text
  }
  function constanceLogLine(e) {
    var who = e.agent ? (e.worker || constanceAgentName(e.agent)) + (e.account ? " (" + e.account + ")" : "") : ""
    var head = { goal: "Goal", handoff: "Job " + e.job + " → " + who, practice: "Practice job " + e.job + " → " + who + (e.reason ? " (" + e.reason + ")" : ""),
                 returned: "Job " + e.job + " back from " + who, held: "Job " + e.job + " → " + who + " (held)", model: "Model",
                 review: "Job " + e.job + (e.verdict === "accept" ? " accepted" : " sent back"), report: "Report", paused: "Paused",
                 signal: "Signal", queue: "Queue",
                 resumed: "Resumed", stopped: "Stopped", failed: "Failed", note: "Note" }[e.kind] || e.kind
    var line = Qt.formatDateTime(new Date(Number(e.at)), "h:mm AP") + "  " + head + (e.text ? ": " + e.text : "")
    if (e.kind === "practice") line += "\n" + String(e.prompt || "")   // the whole handoff prompt, so the owner can check it
    return line
  }
  // Constance's own row: the model she runs on and her session/weekly percentages (from her pace
  // windows), instead of a pace-mode word.
  function constanceClaudeLine() {
    var p = root.constance.pace, parts = []
    if (p && p.windows) for (var i = 0; i < p.windows.length; i++) parts.push(p.windows[i].title + " " + Math.round(Number(p.windows[i].used) * 100) + "%")
    if (parts.length) return "Claude Code (" + root.constanceModel + ") — " + parts.join(" · ")
    return "Claude Code (" + root.constanceModel + ")" + (p && p.mode && p.mode !== "normal" ? " — " + p.mode + " pace" : "")
  }
  // The agent list split for display: Constance herself, agents she can use right now (free agents
  // plus anyone holding a running job), agents waiting on a limit to reset, and the rest.
  readonly property var constanceGroups: {
    var me = null, ready = [], waiting = [], cant = []
    var list = root.constance.agents || []
    for (var i = 0; i < list.length; i++) {
      var a = list[i]
      if (a.reason === "not installed") continue
      if (a.id === "claude") { me = a; continue }
      if (root.constanceJobOf(a.id) || a.available) {
        var rows = root.constanceCopyRows(a)
        if (rows.length) { for (var k = 0; k < rows.length; k++) ready.push(rows[k]) }
        else ready.push(a)
      }
      else if (/of a limit|hit its limit/.test(String(a.reason))) waiting.push(a)
      else cant.push(a)
    }
    return { me: me, ready: ready, waiting: waiting, cant: cant }
  }
  property bool constanceCantOpen: false   // "Can't use" starts collapsed with a count

  // ---- The at-a-glance board (bin/constance-board.mjs, constance-checklist.mjs, constance-goalqueue.mjs):
  // the checklist, the goal queue, one card per job, the Now line, history, and the log folded away.
  readonly property var constanceBoard: constance.board || ({ checklist: { items: [], done: 0, total: 0, line: "" }, cards: [], now: "", history: [], goalQueue: { goals: [], paused: "" } })
  readonly property var constanceGoalQueue: constanceBoard.goalQueue || ({ goals: [], paused: "" })
  // Live clock for running cards' elapsed time (ticks only while her screen is open).
  property real constanceNow: Date.now()
  Timer { interval: 1000; running: root.constanceOpen && root.opened; repeat: true; triggeredOnStart: true; onTriggered: root.constanceNow = Date.now() }
  function constanceTook(ms) {
    if (typeof ms !== "number" || !(ms >= 0)) return ""
    var s = Math.round(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24)
    if (d) return d + "d " + (h % 24) + "h"
    if (h) return h + "h " + (m % 60) + "m"
    if (m) return m + "m"
    return s + "s"
  }
  // A card's time: elapsed while running (live), how long it took once over, or how long it has waited.
  function constanceCardTime(c) {
    if (c.status === "running" && c.startedAt) return root.constanceTook(root.constanceNow - c.startedAt)
    if (c.startedAt && c.endedAt) return root.constanceTook(c.endedAt - c.startedAt)
    if ((c.status === "queued" || c.status === "held") && c.createdAt) return "waiting " + root.constanceTook(root.constanceNow - c.createdAt)
    return ""
  }
  function constanceStatusColor(st) {
    if (st === "running") return Color.accent
    if (st === "in review") return root.amber
    if (st === "merged" || st === "done") return root.green
    if (st === "sent back" || st === "conflict" || st === "problem") return root.red
    return root.dim
  }
  // Card / checklist detail: one card open at a time, its full prompt and report fetched on click.
  property var constanceCardOpen: null
  property var constanceJobDetail: null
  function openConstanceCard(id) {
    if (root.constanceCardOpen === id) { root.constanceCardOpen = null; root.constanceJobDetail = null; return }
    root.constanceCardOpen = id; root.constanceJobDetail = null
    if (id === null || id === undefined) return
    constanceJobReader.command = ["node", root.pluginDir + "/bin/constance.mjs", "job", String(id)]
    constanceJobReader.running = true
  }
  function constanceJobReport(d) {
    if (!d) return "Loading…"
    var parts = []
    if (d.summary) parts.push("Report from " + (d.worker || root.constanceAgentName(d.agent)) + ":\n" + d.summary)
    if (d.commit) parts.push("Commit: " + d.commit)
    if (d.reviewNote) parts.push("Her review: " + d.reviewNote)
    if (d.mergeError) parts.push("Merge: " + d.mergeError)
    if (d.heldReason && d.status === "held") parts.push("Held: " + d.heldReason)
    if (!parts.length) parts.push(d.status === "running" ? "No report yet: it is still running." : "No report.")
    return parts.join("\n\n")
  }
  Process {
    id: constanceJobReader
    stdout: StdioCollector {
      onStreamFinished: { try { var d = JSON.parse(String(text || "")); if (d && d.id === root.constanceCardOpen) root.constanceJobDetail = d } catch (e) {} }
    }
  }
  // Goal queue commands (add, rm, edit, move, next). One at a time; any refusal shows as her error line.
  property bool constanceAddingGoal: false   // the goal box while she works: "+ Add a goal"
  property string constanceEditId: ""        // a queued goal being edited in the goal box
  function constanceGoals(args) {
    if (constanceGoalsRunner.running) return
    root.constanceError = ""
    constanceGoalsRunner.command = ["node", root.pluginDir + "/bin/constance.mjs", "goals"].concat(args)
    constanceGoalsRunner.running = true
  }
  function constanceWhere() { return root.squadNewName !== "" ? ["--new", root.squadNewName] : ["--dir", root.squadRepo !== "" ? root.squadRepo : root.home] }
  // The goal box's button: start now when she's free, queue it while she works, or save an edit.
  function submitConstanceGoal() {
    var text = String(goalArea.text || "").trim()
    if (text === "") return
    if (root.constanceEditId !== "") { root.constanceGoals(["edit", root.constanceEditId, "--goal", text].concat(root.constanceWhere())); return }
    if (root.constanceActive) { root.constanceGoals(["add", "--goal", text].concat(root.constanceWhere())); return }
    root.startConstance(text)
  }
  function editQueuedGoal(g) {
    root.constanceEditId = g.id
    root.constanceAddingGoal = true
    goalArea.text = g.text
    root.squadNewName = ""; root.squadRepo = g.dir
  }
  function cancelGoalEdit() { root.constanceEditId = ""; root.constanceAddingGoal = false; goalArea.text = "" }
  Process {
    id: constanceGoalsRunner
    stderr: StdioCollector { id: constanceGoalsErr }
    onExited: function(code) {
      if (code !== 0) root.constanceError = String(constanceGoalsErr.text).trim() || ("That didn't work (exit " + code + ").")
      else {
        var sub = constanceGoalsRunner.command[3]
        if (sub === "add" || sub === "edit") { goalArea.text = ""; root.constanceEditId = ""; root.constanceAddingGoal = false }
      }
      root.refreshConstance()
    }
  }
  // The raw log: folded away by default, filtered by job, worker and kind.
  property bool constanceLogOpen: false
  property string constanceLogJob: ""
  property string constanceLogWorker: ""
  property string constanceLogKind: ""
  property bool constanceHistoryAll: false
  function constanceLogWho(e) { return e.agent ? (e.worker || root.constanceAgentName(e.agent)) : "" }
  readonly property var constanceLogFilters: {
    var jobs = [], workers = [], kinds = [], log = root.constance.log || []
    for (var i = 0; i < log.length; i++) {
      var e = log[i]
      if (e.job !== undefined && e.job !== null && jobs.indexOf(String(e.job)) < 0) jobs.push(String(e.job))
      var w = root.constanceLogWho(e)
      if (w && workers.indexOf(w) < 0) workers.push(w)
      if (e.kind && kinds.indexOf(e.kind) < 0) kinds.push(e.kind)
    }
    jobs.sort(function(a, b) { return Number(a) - Number(b) }); workers.sort(); kinds.sort()
    return { jobs: jobs, workers: workers, kinds: kinds }
  }
  readonly property var constanceLogShown: {
    var out = [], log = root.constance.log || []
    for (var i = log.length - 1; i >= 0 && out.length < 40; i--) {
      var e = log[i]
      if (root.constanceLogJob !== "" && String(e.job) !== root.constanceLogJob) continue
      if (root.constanceLogWorker !== "" && root.constanceLogWho(e) !== root.constanceLogWorker) continue
      if (root.constanceLogKind !== "" && e.kind !== root.constanceLogKind) continue
      out.push(e)
    }
    return out
  }
  function constanceHistoryLine(h) {
    var when = h.startedAt ? Qt.formatDateTime(new Date(Number(h.startedAt)), "MMM d, h:mm AP") : ""
    var parts = [when, h.outcome || "", (h.jobs || 0) + (h.jobs === 1 ? " job" : " jobs") + (h.merged ? " (" + h.merged + " merged)" : "")]
    if (h.itemsTotal > 1) parts.push(h.itemsDone + " of " + h.itemsTotal + " items")
    if (h.tokensText) parts.push(h.tokensText + " tokens")
    if (h.took !== null && h.took !== undefined) parts.push(root.constanceTook(h.took))
    if (h.practice) parts.push("practice")
    return parts.filter(function(p) { return p !== "" }).join(" · ")
  }
  Process {
    id: constanceReader
    command: ["node", root.pluginDir + "/bin/constance.mjs", "status"]
    stdout: StdioCollector {
      onStreamFinished: { try { var d = JSON.parse(String(text || "")); if (d && typeof d === "object") root.constance = d } catch (e) {} }
    }
  }
  Process {
    id: constanceStarter
    running: false
    stderr: StdioCollector { id: constanceStarterErr }
    onExited: function(code) {
      if (code !== 0) root.constanceError = String(constanceStarterErr.text).trim() || ("Constance couldn't start (exit " + code + ").")
      else goalArea.text = ""
      root.refreshConstance()
    }
  }
  Process {
    id: constanceStopper
    command: ["node", root.pluginDir + "/bin/constance.mjs", "stop"]
    running: false
    onExited: root.refreshConstance()
  }
  // At load (a shell restart): if she was on a goal and her driver isn't running, pick it back up.
  Process { id: constanceRecover; command: ["node", root.pluginDir + "/bin/constance.mjs", "recover"]; running: true }
  Timer { interval: 3000; running: root.constanceOpen && root.opened; repeat: true; triggeredOnStart: true; onTriggered: root.refreshConstance() }

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

  onOpenedChanged: if (!opened) { autoOpened = false; autoCloseTimer.stop(); squadOpen = false; addOpen = false; agentHereOpen = false; constanceOpen = false; welcomeOpen = false; settingsLoaded = false; goalArea.focus = false; constanceTyping = false } else {
    daysOpen = false
    modelsExpanded = false
    settingsOpen = false
    nowMs = Date.now()
    refreshNow()
    Qt.callLater(function() { if (!root.autoOpened) keyCatcher.forceActiveFocus() })
    Qt.callLater(root.maybeShowWelcome)
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
        var firstOrdinaryReset = ""
        root.rawAgents.forEach(function(a) {
          var t = Number(a.resetAt || 0)
          if (root.resetsPrimed && t > Number(seen[a.id] || 0) && Date.now() - t < 8000) {
            fresh.push(a.id)
            if (a.id === "antigravity" && a.resetKind === "surprise") {
              root.detectedSurpriseAt = t
              root.detectedSurpriseWhileOpen = root.opened
            } else if (firstOrdinaryReset === "") firstOrdinaryReset = a.id
          }
          if (t > Number(seen[a.id] || 0)) seen[a.id] = t
        })
        root.resetsPrimed = true
        if (root.detectedSurpriseAt > 0 && root.detectedSurpriseWhileOpen) Qt.callLater(root.checkAntigravitySurprise)
        if (firstOrdinaryReset !== "") Qt.callLater(function() { root.autoCelebrate(firstOrdinaryReset) })
      } catch (e) { root.rawAgents = [] }
    }
    onLoadFailed: root.rawAgents = []
  }

  FileView {
    path: root.antigravitySurprisePath
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      try { root.antigravitySurpriseState = JSON.parse(String(text() || "")) }
      catch (e) { root.antigravitySurpriseState = null }
      Qt.callLater(root.checkAntigravitySurprise)
    }
    onLoadFailed: root.antigravitySurpriseState = null
  }

  FileView {
    path: (Quickshell.env("XDG_STATE_HOME") || root.home + "/.local/state") + "/omarchy/agent-usage-tabs/settings.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      try { var d = JSON.parse(String(text() || "")); root.userSettings = d && typeof d === "object" && !Array.isArray(d) ? d : ({}); root.pendingOrder = null }
      catch (e) { root.userSettings = ({}) }
      root.settingsLoaded = true
      Qt.callLater(root.maybeShowWelcome)
    }
    onLoadFailed: { root.userSettings = ({}); root.settingsLoaded = true; Qt.callLater(root.maybeShowWelcome) }
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
    id: surpriseStateWriter
    running: false
    onExited: function(code) { if (code !== 0) console.warn("usage-tabs: couldn't mark Antigravity's surprise celebration as played") }
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
    function view(name: string): string { root.leaveSubView(); if (name === "settings") root.openSettings(); else if (name === "add") root.toggleAdd(); else if (name === "squad") root.toggleSquad(); else if (name === "agent") root.toggleAgentHere(); else if (name === "constance") root.toggleConstance(); else if (name === "welcome") root.welcomeOpen = true; return name }
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
    // Test hook: pick a folder and press Start, through the same function the button calls.
    function agentStart(p: string): string { root.agentHereOpen = true; root.squadRepo = p; root.squadNewName = ""; root.launchAgentHere(); return "started" }
    function agentCmd(): string { return root.agentHereReady ? JSON.stringify(root.agentHereCommand()) : "not ready" }
    function folderPickerState(): string { return JSON.stringify({ ready: root.folderPickerReady, visible: root.startFolderRepos(), hidden: root.hiddenFolderRepos(), entries: root.folderPickerEntries }) }
    function squad(): string { root.toggleSquad(); return root.squadOpen ? "open" : "closed" }
    function constance(): string { root.toggleConstance(); return root.constanceOpen ? "open" : "closed" }
    // Test hook: save an image of the panel's contents alone (no other window can appear in it).
    function shot(file: string): string { column.grabToImage(function(r) { r.saveToFile(file) }); return file }
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
  // A small "Copy" chip: copies `text` (or runs onCopy) and says "Copied" for a moment.
  component CopyChip: Rectangle {
    id: chip
    property string label: "Copy"
    property string tip: "Copy this entry"
    signal copy()
    property bool done: false
    width: chipLabel.implicitWidth + Style.space(14)
    height: chipLabel.implicitHeight + Style.space(6)
    radius: Style.cornerRadius
    color: chipArea.containsMouse ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.1) : "transparent"
    border.width: 1
    border.color: root.soft(root.foreground, 0.3)
    Text {
      id: chipLabel
      anchors.centerIn: parent
      textFormat: Text.PlainText
      text: chip.done ? "Copied" : chip.label
      color: chip.done ? root.green : root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }
    Timer { id: chipReset; interval: 1500; onTriggered: chip.done = false }
    MouseArea { id: chipArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: { chip.copy(); chip.done = true; chipReset.restart() } }
    PanelToolTip { visible: chipArea.containsMouse; text: chip.tip; fontFamily: root.fontFamily }
  }
  // A small button on Constance's board (reorder, edit, remove, start next). `on` marks a picked filter.
  component MiniChip: Rectangle {
    id: mc
    property string label: ""
    property string tip: ""
    property bool on: false
    property color tint: root.foreground
    signal clicked()
    width: mcLabel.implicitWidth + Style.space(12)
    height: mcLabel.implicitHeight + Style.space(6)
    radius: Style.cornerRadius
    color: mc.on ? root.soft(Color.accent, 0.22) : (mcArea.containsMouse ? root.soft(Color.accent, 0.1) : "transparent")
    border.width: 1
    border.color: mc.on ? root.soft(Color.accent, 0.8) : root.soft(root.foreground, 0.3)
    Text {
      id: mcLabel
      anchors.centerIn: parent
      textFormat: Text.PlainText
      text: mc.label
      color: mc.on ? Color.accent : mc.tint
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }
    MouseArea { id: mcArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: mc.clicked() }
    PanelToolTip { visible: mcArea.containsMouse && mc.tip !== ""; text: mc.tip; fontFamily: root.fontFamily }
  }
  // One row of log filters: "Job: All 16 17 18".
  component LogFilterRow: Flow {
    id: lfr
    property string title: ""
    property var values: []
    property string picked: ""
    property var labelFor: function(v) { return v }
    signal pick(string v)
    width: parent.width
    spacing: Style.space(6)
    visible: values.length > 1
    Text { textFormat: Text.PlainText; text: lfr.title; color: root.dim; font.family: root.fontFamily; font.pixelSize: Style.font.caption; height: Style.font.caption * 1.25 + Style.space(6); verticalAlignment: Text.AlignVCenter }
    MiniChip { label: "All"; on: lfr.picked === ""; onClicked: lfr.pick("") }
    Repeater {
      model: lfr.values
      MiniChip { required property var modelData; label: lfr.labelFor(modelData); on: lfr.picked === String(modelData); onClicked: lfr.pick(lfr.picked === String(modelData) ? "" : String(modelData)) }
    }
  }
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

  // One agent row on Constance's screen: dot, name, and what she can do with it right now. A waiting
  // agent's reason is followed by when its fullest limit resets; a running job shows the task.
  component ConstanceAgentRow: Item {
    id: car
    required property var modelData
    readonly property var job: modelData && modelData.job ? modelData.job : (modelData && modelData.id ? root.constanceJobOf(modelData.id) : null)
    readonly property bool me: modelData && modelData.id === "claude"
    width: parent.width
    height: Math.max(cName.implicitHeight, cWhat.implicitHeight)
    Rectangle {
      id: cDot
      anchors.left: parent.left
      anchors.verticalCenter: cName.verticalCenter
      width: Style.space(8); height: width; radius: width / 2
      color: job ? (job.status === "held" ? root.dim : Color.accent) : (me ? Color.accent : (modelData.available ? root.green : root.unsureColor))
    }
    Text {
      id: cName
      anchors.left: cDot.right
      anchors.leftMargin: Style.space(8)
      anchors.top: parent.top
      width: Style.space(130)
      textFormat: Text.PlainText
      elide: Text.ElideRight
      text: (me ? "Constance" : (modelData.worker || root.constanceAgentName(modelData.id))) + (modelData.account ? " (" + modelData.account + ")" : "")
      color: modelData.available || job || me ? root.foreground : root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      font.bold: !!job || me
    }
    Text {
      id: cWhat
      anchors.left: cName.right
      anchors.leftMargin: Style.space(8)
      anchors.right: parent.right
      anchors.top: parent.top
      textFormat: Text.PlainText
      wrapMode: Text.WordWrap
      maximumLineCount: 2
      elide: Text.ElideRight
      text: job ? (job.status === "held" ? "Held (" + (job.heldReason || "waiting for room") + ") · Job " + job.id + ": " + job.task : "Job " + job.id + ": " + job.task)
        : me ? root.constanceClaudeLine()
        : (modelData.available ? "free: " : "")
          + (modelData.resetsAt ? (modelData.blockTitle ? modelData.blockTitle + ": " : "") + modelData.reason + " · " + root.countdown(modelData.resetsAt)
                                : modelData.reason)
      color: job ? root.foreground : root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
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
  component FolderUsageLine: Item {
    id: usageLine
    property var entries: []
    property bool active: true
    readonly property real lineHeight: Style.font.caption * 1.25
    implicitHeight: active ? lineHeight * 2 : 0
    height: implicitHeight
    visible: active
    Text {
      y: 0
      width: usageLine.width
      height: usageLine.lineHeight
      visible: usageLine.entries.length > 0
      textFormat: Text.PlainText
      text: usageLine.entries.length ? usageLine.entries[0].text : ""
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      font.bold: true
      elide: Text.ElideRight
      maximumLineCount: 1
    }
    Text {
      y: usageLine.lineHeight
      width: usageLine.width
      height: usageLine.lineHeight
      visible: usageLine.entries.length > 1
      textFormat: Text.PlainText
      text: usageLine.entries.slice(1).map(function(item) { return item.text }).join(" · ")
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption * 0.85
      fontSizeMode: Text.HorizontalFit
      minimumPixelSize: Style.font.caption * 0.65
      wrapMode: Text.NoWrap
      maximumLineCount: 1
      elide: Text.ElideNone
    }
  }
  component FolderActionButton: Rectangle {
    id: folderAction
    property string glyph: ""
    property string tip: ""
    property bool emphasized: false
    property bool available: true
    readonly property bool hovered: folderActionArea.containsMouse
    signal triggered()
    width: Style.space(18)
    height: width
    radius: Style.cornerRadius
    color: hovered ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.16) : "transparent"
    Text {
      anchors.centerIn: parent
      textFormat: Text.PlainText
      text: folderAction.glyph
      color: folderAction.emphasized ? Color.accent : root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }
    MouseArea {
      id: folderActionArea
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: folderAction.available ? Qt.PointingHandCursor : Qt.ArrowCursor
      onClicked: if (folderAction.available) folderAction.triggered()
    }
    PanelToolTip { visible: folderAction.hovered; text: folderAction.tip; fontFamily: root.fontFamily }
  }
  component FolderPicker: Column {
    id: fp
    property bool forSquad: true
    // Constance's folder row: only the picked folder stands out (green border, check and name);
    // every other chip stays plain, pins included.
    property bool plainOthers: false
    readonly property real folderGridSpacing: Style.space(8)
    readonly property real folderChipWidth: Math.max(0, Math.floor((width - folderGridSpacing) / 2))
    readonly property real folderNameRowHeight: Style.font.bodySmall * 1.25 + Style.space(12)
    readonly property real folderChipHeight: Style.font.bodySmall * 1.25 + Style.font.caption * 2.5 + Style.space(14)
    spacing: Style.space(14)
    PanelSectionHeader { width: parent.width; text: "FOLDER" }
    Flow {
      width: parent.width
      spacing: fp.forSquad ? Style.space(6) : fp.folderGridSpacing
      Rectangle {
        id: homeChip
        visible: !fp.forSquad
        readonly property bool on: root.squadRepo === root.home && root.squadNewName === ""
        width: fp.folderChipWidth
        height: fp.folderNameRowHeight
        radius: Style.cornerRadius
        color: homeArea.containsMouse ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.08)
                                      : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.04)
        border.width: 1
        border.color: on ? root.soft(Color.accent, 0.5) : root.soft(root.foreground, 0.3)
        Text {
          id: homeLabel
          anchors.left: parent.left
          anchors.leftMargin: Style.space(10)
          anchors.verticalCenter: parent.verticalCenter
          textFormat: Text.PlainText
          text: "No project"
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
        }
        MouseArea { id: homeArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: { root.squadRepo = root.home; root.squadNewName = "" } }
        PanelToolTip { visible: homeArea.containsMouse; text: "Start in your home folder (~), without a project folder"; fontFamily: root.fontFamily }
      }
      Repeater {
        model: fp.forSquad ? root.squadRepos : root.startFolderRepos()
        Rectangle {
          id: repoChip
          required property string modelData
          readonly property var usageItems: root.folderUsageEntries(modelData)
          readonly property bool on: root.squadRepo === modelData
          readonly property bool pinned: root.folderIsPinned(modelData)
          width: fp.forSquad ? repoLabel.implicitWidth + Style.space(22) : fp.folderChipWidth
          height: fp.forSquad ? repoContent.implicitHeight + Style.space(14) : fp.folderChipHeight
          radius: Style.cornerRadius
          color: fp.forSquad
            ? (fp.plainOthers
                ? (on ? Qt.rgba(root.green.r, root.green.g, root.green.b, 0.14)
                      : repoArea.containsMouse ? Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.07)
                      : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.04))
                : (on ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.22)
                      : pinned ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.12)
                      : (repoArea.containsMouse ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.1) : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.06))))
            : (repoHover.hovered ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.08) : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.05))
          border.width: fp.forSquad ? (fp.plainOthers ? (on ? 2 : 1) : (pinned ? 2 : (on ? 1 : 0))) : (on ? 1 : 0)
          border.color: fp.forSquad ? (fp.plainOthers ? (on ? root.green : root.soft(root.foreground, 0.3)) : (on || pinned ? Color.accent : root.soft(root.foreground, 0.3))) : root.soft(Color.accent, 0.5)
          Column {
            id: repoContent
            anchors.centerIn: parent
            width: parent.width - Style.space(12)
            spacing: Style.space(4)
            Text {
              id: repoLabel
              width: parent.width - (!fp.forSquad && repoHover.hovered ? Style.space(40) : (!fp.forSquad && repoChip.pinned ? Style.space(22) : 0))
              horizontalAlignment: fp.forSquad ? Text.AlignHCenter : Text.AlignLeft
              textFormat: Text.PlainText
              text: fp.forSquad ? ((repoChip.on ? "\u2713 " : "") + root.shortPath(repoChip.modelData)) : root.folderName(repoChip.modelData)
              color: fp.forSquad && repoChip.on ? (fp.plainOthers ? root.green : Color.accent) : root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              font.bold: fp.forSquad && repoChip.on
              fontSizeMode: fp.forSquad ? Text.FixedSize : Text.HorizontalFit
              minimumPixelSize: fp.forSquad ? Style.font.bodySmall : Style.font.caption * 0.75
              wrapMode: fp.forSquad ? Text.WordWrap : Text.NoWrap
              maximumLineCount: fp.forSquad ? 0 : 1
              elide: fp.forSquad ? Text.ElideRight : Text.ElideNone
            }
            FolderUsageLine { width: parent.width; entries: repoChip.usageItems; active: !fp.forSquad }
          }
          HoverHandler { id: repoHover }
          MouseArea { id: repoArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: { root.squadRepo = repoChip.modelData; root.squadNewName = "" } }
          Row {
            id: repoControls
            anchors.top: parent.top
            anchors.right: parent.right
            anchors.margins: Style.space(4)
            spacing: Style.space(2)
            visible: !fp.forSquad && (repoHover.hovered || repoChip.pinned)
            FolderActionButton {
              id: repoPinAction
              glyph: repoChip.pinned ? "󰐃" : "󰤱"
              tip: repoChip.pinned ? root.pluginText("picker.unpin") : root.pluginText("picker.pin")
              emphasized: false
              available: root.folderPreferencesReady && !root.folderPreferenceBusy
              onTriggered: root.toggleFolderPin(repoChip.modelData)
            }
            FolderActionButton {
              id: repoHideAction
              glyph: "󰛑"
              tip: root.pluginText("picker.hide")
              available: root.folderPreferencesReady && !root.folderPreferenceBusy
              onTriggered: root.hideFolder(repoChip.modelData)
              visible: repoHover.hovered
            }
          }
          PanelToolTip {
            visible: repoHover.hovered && !repoPinAction.hovered && !repoHideAction.hovered
            text: root.safeTooltipText(repoChip.modelData)
            fontFamily: root.fontFamily
          }
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
    Rectangle {
      id: hiddenFoldersToggle
      visible: !fp.forSquad && root.hiddenFolderRepos().length > 0
      width: parent.width
      height: Style.space(32)
      radius: Style.cornerRadius
      color: root.showHiddenFolders ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.1) : "transparent"
      border.width: 1
      border.color: root.soft(root.foreground, 0.3)
      Text {
        anchors.centerIn: parent
        textFormat: Text.PlainText
        text: (root.showHiddenFolders ? "\u2304 " : "\u203a ") + root.pluginText("picker.hiddenFolders").arg(root.hiddenFolderRepos().length)
        color: root.showHiddenFolders ? Color.accent : root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
      }
      MouseArea {
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        onClicked: root.showHiddenFolders = !root.showHiddenFolders
      }
    }
    Flow {
      width: parent.width
      visible: !fp.forSquad && root.showHiddenFolders
      spacing: fp.folderGridSpacing
      Repeater {
        model: root.hiddenFolderRepos()
        Rectangle {
          id: hiddenRepoChip
          required property string modelData
          readonly property var usageItems: root.folderUsageEntries(modelData)
          readonly property bool on: root.squadRepo === modelData
          width: fp.folderChipWidth
          height: fp.folderChipHeight
          radius: Style.cornerRadius
          color: hiddenRepoHover.hovered ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.06)
                                         : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.04)
          border.width: on ? 1 : 0
          border.color: root.soft(Color.accent, 0.5)
          Column {
            anchors.centerIn: parent
            width: parent.width - Style.space(12)
            spacing: Style.space(4)
            Text {
              width: parent.width - hiddenRepoControls.implicitWidth - Style.space(12)
              horizontalAlignment: Text.AlignLeft
              textFormat: Text.PlainText
              text: root.folderName(hiddenRepoChip.modelData)
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              fontSizeMode: Text.HorizontalFit
              minimumPixelSize: Style.font.caption * 0.75
              wrapMode: Text.NoWrap
              maximumLineCount: 1
              elide: Text.ElideNone
            }
            FolderUsageLine { width: parent.width; entries: hiddenRepoChip.usageItems; active: true }
          }
          HoverHandler { id: hiddenRepoHover }
          MouseArea {
            id: hiddenRepoChipMouse
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: { root.squadRepo = hiddenRepoChip.modelData; root.squadNewName = "" }
          }
          Row {
            id: hiddenRepoControls
            anchors.top: parent.top
            anchors.right: parent.right
            anchors.margins: Style.space(4)
            spacing: Style.space(2)
            Rectangle {
              id: hiddenRepoRestoreAction
              readonly property bool hovered: hiddenRepoRestoreArea.containsMouse
              readonly property bool available: root.folderPreferencesReady && !root.folderPreferenceBusy
              implicitWidth: hiddenRepoRestoreText.implicitWidth + Style.space(14)
              height: Style.space(22)
              radius: Style.cornerRadius
              color: hiddenRepoRestoreArea.containsMouse ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.16)
                     : Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.08)
              border.width: 1
              border.color: root.soft(Color.accent, 0.5)
              Text {
                id: hiddenRepoRestoreText
                anchors.centerIn: parent
                textFormat: Text.PlainText
                text: root.pluginText("picker.restoreButton")
                color: Color.accent
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
              MouseArea {
                id: hiddenRepoRestoreArea
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: hiddenRepoRestoreAction.available ? Qt.PointingHandCursor : Qt.ArrowCursor
                onClicked: if (hiddenRepoRestoreAction.available) root.restoreFolder(hiddenRepoChip.modelData)
              }
              PanelToolTip { visible: hiddenRepoRestoreAction.hovered; text: root.pluginText("picker.restore"); fontFamily: root.fontFamily }
            }
          }
          PanelToolTip {
            visible: !hiddenRepoRestoreAction.hovered && hiddenRepoHover.hovered
            text: root.safeTooltipText(hiddenRepoChip.modelData)
            fontFamily: root.fontFamily
          }
        }
      }
    }
  }
  component HeaderButton: Rectangle {
    id: hb
    property string glyph: ""
    property string tip: ""
    property bool bold: false
    property bool lit: false     // something is running behind it (Constance on a goal): the glyph shows in the accent
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
      color: hbArea.containsMouse || hb.lit ? Color.accent : root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.heading
      font.bold: hb.bold
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
    // Two readings, two colors, mirroring the agent's tab chip: the built-in
    // label draws the percentage and the button's active state draws its
    // underline — both in the session (chip border) color — while the robot
    // glyph takes the weekly (chip inside) color. labelText gives the label
    // the same metrics, spacing and vertical centering it always had.
    iconComponent: Component {
      OpticalGlyph {
        implicitWidth: Style.bar.iconCanvas
        implicitHeight: Style.bar.iconCanvas
        text: root.robotAngry ? "\u{f169d}" : "\u{f16a3}"
        fontFamily: root.fontFamily
        fontSize: Style.bar.iconFont
        paintedSize: Style.bar.iconSize
        color: root.barRobotColor
      }
    }
    labelText: root.barSession >= 0 ? Math.round(root.barSession * 100) + "%" : ""
    slotSize: Style.bar.iconSlot * (root.barHasData ? 2 : 1)
    active: root.barHasData
    activeColor: root.barSessionColor
    tooltipText: root.barTooltip
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
      blocked: root.constanceTyping   // the goal box owns the keys while it has focus

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
        acceptedButtons: root.constanceLogPointing ? Qt.NoButton : Qt.LeftButton
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
                text: root.welcomeOpen ? "Welcome" : (root.addOpen ? "Add an account" : (root.settingsOpen ? "Settings" : (root.agentHereOpen ? "Start " + root.defaultAgentName : (root.constanceOpen ? "Constance" : "Claude Squad"))))
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
              HeaderButton { glyph: "C"; bold: true; tip: root.constanceActive ? "Constance (working)" : "Constance: give her a goal"; lit: root.constanceActive; onClicked: root.toggleConstance() }
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
              Column {
                anchors.centerIn: parent
                spacing: 0
                Text {
                  id: startLabel
                  textFormat: Text.PlainText
                  text: (root.agentHereStarting ? "Starting " : "Start ") + root.defaultAgentName
                  color: Color.accent
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                  font.bold: true
                }
                Text {
                  visible: root.skipPermissions
                  textFormat: Text.PlainText
                  text: "no prompts"
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }
              }
              MouseArea { id: startArea; anchors.fill: parent; enabled: startTile.ready; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: root.launchAgentHere() }
              PanelToolTip { visible: startArea.containsMouse; text: "Opens the default agent in a tiled terminal in this folder"; fontFamily: root.fontFamily }
            }
            Text {
              visible: root.agentHereStarting || root.agentHereError !== ""
              width: parent.width
              textFormat: Text.PlainText
              wrapMode: Text.WordWrap
              text: root.agentHereStarting ? "Opening the terminal..." : root.agentHereError
              color: root.agentHereStarting ? root.dim : root.red
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
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
            Text {
              visible: root.squadStarting || root.squadError !== ""
              width: parent.width
              textFormat: Text.PlainText
              wrapMode: Text.WordWrap
              text: root.squadStarting ? "Opening the terminal..." : root.squadError
              color: root.squadStarting ? root.dim : root.red
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }
            }
          }

          // ---------------- Constance view (the C header button): the goal box and folder while she is free; the goal,
          // her pace and Stop while she works; every agent and what it is on; and the log of every handoff and result.
          Column {
            id: constanceView
            visible: root.constanceOpen
            width: parent.width
            spacing: Style.space(14)

            Column {
              visible: !root.constanceActive || root.constanceAddingGoal || root.constanceEditId !== ""
              width: parent.width
              spacing: Style.space(10)
              PanelSectionHeader { width: parent.width; text: root.constanceEditId !== "" ? "EDIT A QUEUED GOAL" : (root.constanceActive ? "ADD A GOAL TO HER QUEUE" : "GOAL") }
              Rectangle {
                id: goalBox
                width: parent.width
                readonly property real vPad: Style.space(9)
                // The real line height (measured), so twelve lines fit exactly before it scrolls.
                readonly property real lineH: goalArea.contentHeight / Math.max(1, goalArea.lineCount)
                // About three lines tall, growing with the text up to about twelve lines; past that it scrolls
                // inside the box. There is no line or length limit: the whole goal is kept and sent.
                height: Math.max(lineH * 3, Math.min(lineH * 12, goalArea.contentHeight)) + vPad * 2
                radius: Style.cornerRadius
                color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, goalArea.activeFocus ? 0.07 : 0.045)
                border.width: 1
                border.color: goalArea.activeFocus ? Color.accent : root.soft(root.foreground, 0.3)
                clip: true
                Flickable {
                  id: goalFlick
                  anchors.fill: parent
                  anchors.margins: goalBox.vPad
                  clip: true
                  contentWidth: width
                  boundsBehavior: Flickable.StopAtBounds
                  ScrollBar.vertical: ScrollBar { policy: goalFlick.contentHeight > goalFlick.height + 1 ? ScrollBar.AlwaysOn : ScrollBar.AlwaysOff }
                  // Attached so the view follows the cursor while typing or after a paste.
                  TextArea.flickable: TextArea {
                    id: goalArea
                    padding: 0
                    rightPadding: goalFlick.contentHeight > goalFlick.height + 1 ? Style.space(10) : 0
                    background: null
                    wrapMode: TextEdit.Wrap
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                    placeholderText: "Tell her once, in plain words: e.g. add a dark mode switch"
                    placeholderTextColor: root.dim
                    activeFocusOnPress: true
                    onActiveFocusChanged: root.constanceTyping = activeFocus
                    Keys.onPressed: function(event) { if (event.key === Qt.Key_V && (event.modifiers & Qt.ControlModifier)) { event.accepted = true; goalArea.paste() } }
                    Keys.onEscapePressed: { goalArea.focus = false; keyCatcher.forceActiveFocus() }
                    // Enter makes a new line; Ctrl+Enter hands it to her (the button always works).
                    Keys.onReturnPressed: function(event) { if (event.modifiers & Qt.ControlModifier) { event.accepted = true; root.submitConstanceGoal() } }
                  }
                }
                TapHandler { acceptedButtons: Qt.LeftButton | Qt.RightButton | Qt.MiddleButton; onPressedChanged: if (pressed) goalArea.forceActiveFocus() }
              }
              FolderPicker { width: parent.width; plainOthers: true }
              Row {
                width: parent.width
                spacing: Style.space(10)
                Rectangle {
                  id: goTile
                  readonly property bool ready: goalArea.text.trim() !== "" && !constanceStarter.running && !constanceGoalsRunner.running
                  width: parent.width - practiceToggle.width - parent.spacing
                  height: goLabel.implicitHeight + Style.space(20)
                  radius: Style.cornerRadius
                  opacity: ready ? 1 : 0.4
                  color: goArea.containsMouse && ready ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.3) : Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.18)
                  border.width: 1
                  border.color: root.soft(Color.accent, ready ? 0.9 : 0.4)
                  Text {
                    id: goLabel
                    anchors.centerIn: parent
                    textFormat: Text.PlainText
                    text: constanceStarter.running ? "Starting..." : (root.constanceEditId !== "" ? "Save changes" : (root.constanceActive ? "Add to queue" : "Give it to Constance"))
                    color: Color.accent
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                    font.bold: true
                  }
                  MouseArea { id: goArea; anchors.fill: parent; enabled: goTile.ready; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: root.submitConstanceGoal() }
                  PanelToolTip { visible: goArea.containsMouse; text: root.constanceActive || root.constanceEditId !== "" ? "Queued goals start by themselves, in order, when the one before ends well. Ctrl+Enter works too." : "She plans it, hands pieces to free agents under their limits, reviews everything and reports here. Ctrl+Enter works too."; fontFamily: root.fontFamily }
                }
                Item {
                  id: practiceToggle
                  width: pracText.implicitWidth + Style.space(10) + Style.space(38)
                  height: Math.max(goTile.height, Style.space(24))
                  Text {
                    id: pracText
                    anchors.left: parent.left
                    anchors.verticalCenter: parent.verticalCenter
                    textFormat: Text.PlainText
                    text: "Practice"
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                  }
                  Rectangle {
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    width: Style.space(38)
                    height: Style.space(20)
                    radius: height / 2
                    color: root.constancePractice ? root.green : root.track
                    border.width: 1
                    border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.4)
                    Rectangle {
                      width: parent.height - Style.space(6)
                      height: width
                      radius: width / 2
                      anchors.verticalCenter: parent.verticalCenter
                      x: root.constancePractice ? parent.width - width - Style.space(3) : Style.space(3)
                      color: root.foreground
                    }
                  }
                  MouseArea {
                    id: pracArea
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.writeSetting(["constancePractice", String(!root.constancePractice)])
                  }
                  PanelToolTip { visible: pracArea.containsMouse; text: "Dry run, on for now: she plans and writes every handoff prompt to the log, but launches nothing and changes no files"; fontFamily: root.fontFamily }
                }
              }
              Text {
                visible: root.constanceAddingGoal || root.constanceEditId !== ""
                textFormat: Text.PlainText
                text: "Cancel"
                color: Color.accent
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.cancelGoalEdit() }
              }
            }
            Text {
              visible: root.constanceError !== ""
              width: parent.width
              textFormat: Text.PlainText
              wrapMode: Text.WordWrap
              text: root.constanceError
              color: root.red
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }

            // The current (or last) goal: what she is on, her pace, and Stop.
            Column {
              visible: !!root.constance.goal
              width: parent.width
              spacing: Style.space(6)
              Item {
                width: parent.width
                height: Math.max(goalLine.implicitHeight, Math.max(keepTile.visible ? keepTile.height : 0, stopTile.visible ? stopTile.height : 0))
                Text {
                  id: goalLine
                  anchors.left: parent.left
                  anchors.right: actRow.left
                  anchors.rightMargin: Style.space(10)
                  anchors.verticalCenter: parent.verticalCenter
                  textFormat: Text.PlainText
                  wrapMode: Text.WordWrap
                  maximumLineCount: 3
                  elide: Text.ElideRight
                  text: root.constanceGoalLine()
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                  font.bold: true
                }
                Row {
                  id: actRow
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  spacing: Style.space(8)
                  Rectangle {
                    id: keepTile
                    visible: !!root.constance.goal && root.constance.goal.status === "paused" && !!root.constance.pace && root.constance.pace.mode === "stop" && !!root.constance.pace.title
                    width: keepLabel.implicitWidth + Style.space(24)
                    height: keepLabel.implicitHeight + Style.space(14)
                    radius: Style.cornerRadius
                    color: root.soft(root.green, keepArea.containsMouse ? 0.3 : 0.15)
                    Text {
                      id: keepLabel
                      anchors.centerIn: parent
                      textFormat: Text.PlainText
                      text: "Keep going"
                      color: root.green
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.bodySmall
                      font.bold: true
                    }
                    MouseArea { id: keepArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: root.keepConstanceGoing() }
                    PanelToolTip { visible: keepArea.containsMouse; text: "Resume her now even though a limit paused her; she keeps delegating and only stops at the last few percent before the reset, until that window resets"; fontFamily: root.fontFamily }
                  }
                  Rectangle {
                    id: stopTile
                    visible: root.constanceActive
                    width: stopLabel.implicitWidth + Style.space(24)
                    height: stopLabel.implicitHeight + Style.space(14)
                    radius: Style.cornerRadius
                    color: root.soft(root.red, stopArea.containsMouse ? 0.3 : 0.15)
                    Text {
                      id: stopLabel
                      anchors.centerIn: parent
                      textFormat: Text.PlainText
                      text: constanceStopper.running ? "Stopping..." : "Stop"
                      color: root.red
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.bodySmall
                      font.bold: true
                    }
                    MouseArea { id: stopArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: root.stopConstance() }
                    PanelToolTip { visible: stopArea.containsMouse; text: "Halts Constance and every job she handed out, at once"; fontFamily: root.fontFamily }
                  }
                }
              }
              Text {
                visible: text !== ""
                width: parent.width
                textFormat: Text.PlainText
                wrapMode: Text.WordWrap
                text: root.constance.goal ? (root.constance.goal.status === "paused" ? String(root.constance.goal.pauseReason || "")
                  : (root.constanceActive && root.constance.pace ? "Her pace: " + root.constance.pace.reason : "")) + "  " + root.shortPath(root.constance.goal.dir) : ""
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
            }

            // Now: one plain sentence of what is happening ("Devin 2 is on fixing the guard; 2 jobs waiting for review.").
            Text {
              visible: text !== ""
              width: parent.width
              textFormat: Text.PlainText
              wrapMode: Text.WordWrap
              text: root.constanceBoard.now || ""
              color: root.constance.goal && root.constance.goal.needsOwner && !root.constanceActive ? root.amber : root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
            }

            // The goal checklist: its items, ticked as their jobs merge, with a progress bar.
            Column {
              visible: root.constanceBoard.checklist && root.constanceBoard.checklist.total > 0
              width: parent.width
              spacing: Style.space(6)
              Item {
                width: parent.width
                height: checkHeader.implicitHeight
                PanelSectionHeader { id: checkHeader; anchors.left: parent.left; text: "CHECKLIST" }
                Text {
                  anchors.right: parent.right
                  anchors.verticalCenter: checkHeader.verticalCenter
                  textFormat: Text.PlainText
                  text: root.constanceBoard.checklist.line || ""
                  color: root.constanceBoard.checklist.done === root.constanceBoard.checklist.total ? root.green : root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  font.bold: true
                }
              }
              Rectangle {
                width: parent.width
                height: Style.space(6)
                radius: height / 2
                color: root.track
                Rectangle {
                  width: parent.width * (root.constanceBoard.checklist.total ? root.constanceBoard.checklist.done / root.constanceBoard.checklist.total : 0)
                  height: parent.height
                  radius: height / 2
                  color: root.green
                  Behavior on width { NumberAnimation { duration: 400; easing.type: Easing.OutCubic } }
                }
              }
              Repeater {
                model: root.constanceBoard.checklist.items || []
                Item {
                  required property var modelData
                  readonly property bool done: modelData.state === "done"
                  width: parent.width
                  height: Math.max(checkBox.height, checkText.implicitHeight)
                  Rectangle {
                    id: checkBox
                    anchors.left: parent.left
                    anchors.top: parent.top
                    anchors.topMargin: Style.space(1)
                    width: Style.space(14); height: width
                    radius: Style.space(3)
                    color: parent.done ? root.green : "transparent"
                    border.width: 1
                    border.color: parent.done ? root.green : root.constanceStatusColor(modelData.state === "review" ? "in review" : modelData.state === "working" ? "running" : modelData.state)
                    Text { anchors.centerIn: parent; visible: parent.parent.done; textFormat: Text.PlainText; text: "✓"; color: root.panelBackground; font.family: root.fontFamily; font.pixelSize: Style.font.caption; font.bold: true }
                  }
                  Text {
                    id: checkText
                    anchors.left: checkBox.right
                    anchors.leftMargin: Style.space(8)
                    anchors.right: parent.right
                    textFormat: Text.PlainText
                    wrapMode: Text.WordWrap
                    maximumLineCount: 3
                    elide: Text.ElideRight
                    text: modelData.text + (({ working: "  · working", review: "  · in review", problem: "  · merge conflict" })[modelData.state] || "") + (modelData.by === "constance" ? "  · by Constance" : "")
                    color: parent.done ? root.dim : root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                  }
                }
              }
            }

            // The goal queue: goals waiting their turn, each with its folder. Reorder, edit, remove; she starts
            // the next one by herself when a goal ends well, and stops here when one ends needing the owner.
            Column {
              visible: root.constanceGoalQueue.goals.length > 0 || root.constanceActive
              width: parent.width
              spacing: Style.space(6)
              Item {
                width: parent.width
                height: Math.max(queueHeader.implicitHeight, queueActions.height)
                PanelSectionHeader { id: queueHeader; anchors.left: parent.left; anchors.verticalCenter: parent.verticalCenter; text: "GOAL QUEUE" + (root.constanceGoalQueue.goals.length ? " (" + root.constanceGoalQueue.goals.length + ")" : "") }
                Row {
                  id: queueActions
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  spacing: Style.space(6)
                  MiniChip {
                    visible: !root.constanceActive && root.constanceGoalQueue.goals.length > 0
                    label: "Start next"
                    tint: root.green
                    tip: "Start the first queued goal now" + (root.constanceGoalQueue.paused ? " (the queue stopped for you)" : "")
                    onClicked: root.constanceGoals(["next"])
                  }
                  MiniChip {
                    visible: root.constanceActive && !root.constanceAddingGoal && root.constanceEditId === ""
                    label: "+ Add a goal"
                    tip: "Line up another goal, with its own folder; it starts when this one ends well"
                    onClicked: { root.constanceAddingGoal = true; goalArea.forceActiveFocus() }
                  }
                }
              }
              Text {
                visible: root.constanceGoalQueue.paused !== "" && root.constanceGoalQueue.goals.length > 0
                width: parent.width
                textFormat: Text.PlainText
                wrapMode: Text.WordWrap
                text: "Stopped for you: " + root.constanceGoalQueue.paused + ". Start next when you're ready."
                color: root.amber
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
              Text {
                visible: root.constanceGoalQueue.goals.length === 0
                width: parent.width
                textFormat: Text.PlainText
                wrapMode: Text.WordWrap
                text: "Nothing queued. Add goals while she works; each starts by itself when the one before ends well."
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
              Repeater {
                model: root.constanceGoalQueue.goals
                Item {
                  id: qRow
                  required property var modelData
                  required property int index
                  width: parent.width
                  height: Math.max(qText.implicitHeight + qDir.implicitHeight + Style.space(2), qBtns.height)
                  Text {
                    id: qNum
                    anchors.left: parent.left
                    anchors.top: parent.top
                    width: Style.space(18)
                    textFormat: Text.PlainText
                    text: (qRow.index + 1) + "."
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                  }
                  Text {
                    id: qText
                    anchors.left: qNum.right
                    anchors.right: qBtns.left
                    anchors.rightMargin: Style.space(8)
                    anchors.top: parent.top
                    textFormat: Text.PlainText
                    wrapMode: Text.WordWrap
                    maximumLineCount: 2
                    elide: Text.ElideRight
                    text: String(modelData.text).replace(/\s*\n\s*/g, "  ")
                    color: root.constanceEditId === modelData.id ? Color.accent : root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                  }
                  Text {
                    id: qDir
                    anchors.left: qText.left
                    anchors.right: qText.right
                    anchors.top: qText.bottom
                    anchors.topMargin: Style.space(2)
                    textFormat: Text.PlainText
                    elide: Text.ElideMiddle
                    text: root.shortPath(modelData.dir)
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                  }
                  Row {
                    id: qBtns
                    anchors.right: parent.right
                    anchors.top: parent.top
                    spacing: Style.space(4)
                    MiniChip { label: "↑"; tip: "Move up"; opacity: qRow.index > 0 ? 1 : 0.35; onClicked: if (qRow.index > 0) root.constanceGoals(["move", qRow.modelData.id, "up"]) }
                    MiniChip { label: "↓"; tip: "Move down"; opacity: qRow.index < root.constanceGoalQueue.goals.length - 1 ? 1 : 0.35; onClicked: if (qRow.index < root.constanceGoalQueue.goals.length - 1) root.constanceGoals(["move", qRow.modelData.id, "down"]) }
                    MiniChip { label: "Edit"; tip: "Change its text or folder in the goal box"; on: root.constanceEditId === qRow.modelData.id; onClicked: root.editQueuedGoal(qRow.modelData) }
                    MiniChip { label: "✕"; tint: root.red; tip: "Remove it from the queue"; onClicked: { if (root.constanceEditId === qRow.modelData.id) root.cancelGoalEdit(); root.constanceGoals(["rm", qRow.modelData.id]) } }
                  }
                }
              }
            }

            // The job board: one compact card per job (and per task she queued for this project). Click a card
            // for its full prompt and report.
            Column {
              visible: (root.constanceBoard.cards || []).length > 0
              width: parent.width
              spacing: Style.space(6)
              PanelSectionHeader { width: parent.width; text: "JOBS" }
              Flow {
                id: cardFlow
                width: parent.width
                spacing: Style.space(6)
                readonly property real half: Math.floor((width - spacing) / 2)
                Repeater {
                  model: root.constanceBoard.cards || []
                  Rectangle {
                    id: jobCard
                    required property var modelData
                    readonly property bool open: modelData.id !== null && root.constanceCardOpen === modelData.id
                    readonly property color tint: root.constanceStatusColor(modelData.status)
                    width: open ? cardFlow.width : cardFlow.half
                    height: cardCol.implicitHeight + Style.space(14)
                    radius: Style.cornerRadius
                    color: cardArea.containsMouse && modelData.id !== null ? root.soft(Color.accent, 0.08) : root.soft(root.foreground, 0.04)
                    border.width: 1
                    border.color: open ? root.soft(Color.accent, 0.7) : root.soft(jobCard.tint, modelData.status === "running" ? 0.7 : 0.3)
                    MouseArea {
                      id: cardArea
                      anchors.fill: parent
                      enabled: jobCard.modelData.id !== null
                      hoverEnabled: true
                      cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                      onClicked: root.openConstanceCard(jobCard.modelData.id)
                    }
                    Column {
                      id: cardCol
                      anchors.left: parent.left
                      anchors.right: parent.right
                      anchors.top: parent.top
                      anchors.margins: Style.space(7)
                      spacing: Style.space(3)
                      Item {
                        width: parent.width
                        height: Math.max(cardWho.implicitHeight, cardPill.height)
                        Text {
                          id: cardWho
                          anchors.left: parent.left
                          anchors.right: cardPill.left
                          anchors.rightMargin: Style.space(6)
                          anchors.verticalCenter: parent.verticalCenter
                          textFormat: Text.PlainText
                          elide: Text.ElideRight
                          text: (jobCard.modelData.id !== null ? "#" + jobCard.modelData.id + "  " : "") + jobCard.modelData.worker
                          color: root.foreground
                          font.family: root.fontFamily
                          font.pixelSize: Style.font.caption
                          font.bold: true
                        }
                        Rectangle {
                          id: cardPill
                          anchors.right: parent.right
                          anchors.verticalCenter: parent.verticalCenter
                          width: pillText.implicitWidth + Style.space(10)
                          height: pillText.implicitHeight + Style.space(2)
                          radius: height / 2
                          color: root.soft(jobCard.tint, 0.18)
                          Text { id: pillText; anchors.centerIn: parent; textFormat: Text.PlainText; text: jobCard.modelData.status; color: jobCard.tint; font.family: root.fontFamily; font.pixelSize: Style.font.caption }
                        }
                      }
                      Text {
                        width: parent.width
                        textFormat: Text.PlainText
                        wrapMode: Text.WordWrap
                        maximumLineCount: jobCard.open ? 4 : 2
                        elide: Text.ElideRight
                        text: jobCard.modelData.title
                        color: root.foreground
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                      }
                      Text {
                        width: parent.width
                        textFormat: Text.PlainText
                        elide: Text.ElideRight
                        text: [root.constanceCardTime(jobCard.modelData), jobCard.modelData.tokensText,
                               jobCard.modelData.items && jobCard.modelData.items.length ? "item " + jobCard.modelData.items.join(", ") : "",
                               jobCard.modelData.files.length ? jobCard.modelData.files.join(", ") : "read-only"].filter(function(p) { return p !== "" }).join(" · ")
                        color: root.dim
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                      }
                      Text {
                        visible: text !== ""
                        width: parent.width
                        textFormat: Text.PlainText
                        elide: Text.ElideRight
                        text: jobCard.modelData.result || ""
                        color: jobCard.modelData.status === "conflict" || jobCard.modelData.status === "sent back" ? root.red : root.dim
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                      }
                      // Opened: the full prompt and report, selectable, with Copy.
                      Item {
                        visible: jobCard.open
                        width: parent.width
                        height: visible ? detailText.contentHeight + Style.space(6) : 0
                        TextEdit {
                          id: detailText
                          anchors.left: parent.left
                          anchors.right: detailCopy.left
                          anchors.rightMargin: Style.space(8)
                          anchors.top: parent.top
                          anchors.topMargin: Style.space(6)
                          readOnly: true
                          selectByMouse: true
                          textFormat: TextEdit.PlainText
                          wrapMode: TextEdit.Wrap
                          text: jobCard.open ? root.constanceJobReport(root.constanceJobDetail) + (root.constanceJobDetail && root.constanceJobDetail.prompt ? "\n\nPrompt:\n" + root.constanceJobDetail.prompt : "") : ""
                          color: root.foreground
                          selectionColor: root.soft(Color.accent, 0.35)
                          selectedTextColor: root.foreground
                          font.family: root.fontFamily
                          font.pixelSize: Style.font.caption
                          onActiveFocusChanged: root.constanceTyping = activeFocus
                          Keys.onEscapePressed: { detailText.deselect(); detailText.focus = false; keyCatcher.forceActiveFocus() }
                        }
                        CopyChip {
                          id: detailCopy
                          anchors.right: parent.right
                          anchors.top: parent.top
                          anchors.topMargin: Style.space(6)
                          tip: "Copy the report and full prompt"
                          onCopy: root.copyText(detailText.text)
                        }
                      }
                    }
                  }
                }
              }
              // Token totals (bin/constance-tokens.mjs): this goal by agent, and today.
              Text {
                visible: text !== ""
                width: parent.width
                textFormat: Text.PlainText
                wrapMode: Text.WordWrap
                text: (root.constance.tokens && root.constance.tokens.line) ? "Tokens: " + root.constance.tokens.line : ""
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
            }

            // History: past goals over the days, newest first.
            Column {
              visible: (root.constanceBoard.history || []).length > 0
              width: parent.width
              spacing: Style.space(6)
              PanelSectionHeader { width: parent.width; text: "HISTORY" }
              Repeater {
                model: (root.constanceBoard.history || []).slice(0, root.constanceHistoryAll ? 30 : 5)
                Item {
                  required property var modelData
                  readonly property color tint: modelData.outcome === "done" ? root.green : (modelData.outcome === "needs you" || modelData.outcome === "couldn't finish" ? root.amber : root.dim)
                  width: parent.width
                  height: histGoal.implicitHeight + histLine.implicitHeight + Style.space(2)
                  Rectangle { id: histDot; anchors.left: parent.left; anchors.verticalCenter: histGoal.verticalCenter; width: Style.space(8); height: width; radius: width / 2; color: parent.tint }
                  Text {
                    id: histGoal
                    anchors.left: histDot.right
                    anchors.leftMargin: Style.space(8)
                    anchors.right: parent.right
                    textFormat: Text.PlainText
                    elide: Text.ElideRight
                    text: String(modelData.text || "").split("\n")[0]
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                  }
                  Text {
                    id: histLine
                    anchors.left: histGoal.left
                    anchors.right: parent.right
                    anchors.top: histGoal.bottom
                    anchors.topMargin: Style.space(2)
                    textFormat: Text.PlainText
                    elide: Text.ElideRight
                    text: root.constanceHistoryLine(modelData) + (modelData.dir ? " · " + root.shortPath(modelData.dir) : "")
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                  }
                }
              }
              Text {
                visible: (root.constanceBoard.history || []).length > 5
                textFormat: Text.PlainText
                text: root.constanceHistoryAll ? "Show less" : "Show all " + root.constanceBoard.history.length
                color: Color.accent
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.constanceHistoryAll = !root.constanceHistoryAll }
              }
            }

            // The raw log, folded away by default; filters by job, worker and kind. Newest entry on top.
            Item {
              width: parent.width
              height: Math.max(logHeader.implicitHeight, copyAllChip.height)
              PanelSectionHeader {
                id: logHeader
                anchors.left: parent.left; anchors.right: copyAllChip.left; anchors.rightMargin: Style.space(8); anchors.verticalCenter: parent.verticalCenter
                text: (root.constanceLogOpen ? "▾ " : "▸ ") + "LOG" + ((root.constance.log || []).length ? " (" + (root.constance.log || []).length + ")" : "")
                MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.constanceLogOpen = !root.constanceLogOpen }
              }
              CopyChip {
                id: copyAllChip
                visible: (root.constance.log || []).length > 0
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                label: "Copy all"
                tip: "Copy the whole log as text, every practice prompt in full"
                onCopy: root.copyConstanceLog()
              }
            }
            Column {
              visible: root.constanceLogOpen
              width: parent.width
              spacing: Style.space(4)
              LogFilterRow { title: "Job"; values: root.constanceLogFilters.jobs; picked: root.constanceLogJob; labelFor: function(v) { return "#" + v }; onPick: function(v) { root.constanceLogJob = v } }
              LogFilterRow { title: "Worker"; values: root.constanceLogFilters.workers; picked: root.constanceLogWorker; onPick: function(v) { root.constanceLogWorker = v } }
              LogFilterRow { title: "Kind"; values: root.constanceLogFilters.kinds; picked: root.constanceLogKind; onPick: function(v) { root.constanceLogKind = v } }
            }
            Text {
              visible: root.constanceLogOpen && root.constanceLogShown.length === 0
              width: parent.width
              textFormat: Text.PlainText
              text: (root.constance.log || []).length ? "Nothing matches those filters." : "Nothing yet. Every task she hands out, and what comes back, shows here."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }
            Column {
              visible: root.constanceLogOpen
              width: parent.width
              spacing: Style.space(6)
              HoverHandler { onHoveredChanged: root.constanceLogPointing = hovered }
              Repeater {
                model: root.constanceLogOpen ? root.constanceLogShown : []
                // Each entry is selectable text (drag to select, Ctrl+C copies) with its own Copy
                // chip. Long entries show their first lines until "Show all"; Copy always has it all.
                Item {
                  id: logEntry
                  required property var modelData
                  readonly property string full: root.constanceLogLine(modelData)
                  readonly property int maxLines: modelData.kind === "report" ? 30 : (modelData.kind === "practice" ? 40 : 4)
                  readonly property real cap: maxLines * logText.font.pixelSize * 1.4
                  readonly property bool tall: logText.contentHeight > cap + 1
                  property bool expanded: false
                  width: parent.width
                  height: Math.max(entryCopy.height, logClip.height + (tall ? moreLabel.implicitHeight + Style.space(2) : 0))
                  Item {
                    id: logClip
                    anchors.left: parent.left
                    anchors.right: entryCopy.left
                    anchors.rightMargin: Style.space(8)
                    height: logEntry.tall && !logEntry.expanded ? logEntry.cap : logText.contentHeight
                    clip: true
                    TextEdit {
                      id: logText
                      width: parent.width
                      readOnly: true
                      selectByMouse: true
                      persistentSelection: false
                      textFormat: TextEdit.PlainText
                      wrapMode: TextEdit.Wrap
                      text: logEntry.full
                      color: logEntry.modelData.kind === "report" || logEntry.modelData.kind === "review" ? root.foreground : root.dim
                      selectionColor: root.soft(Color.accent, 0.35)
                      selectedTextColor: root.foreground
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      // While it has focus the panel's own keys (tabs, close) wait; Escape hands them back.
                      onActiveFocusChanged: root.constanceTyping = activeFocus
                      Keys.onEscapePressed: { logText.deselect(); logText.focus = false; keyCatcher.forceActiveFocus() }
                    }
                  }
                  Text {
                    id: moreLabel
                    visible: logEntry.tall
                    anchors.top: logClip.bottom
                    anchors.topMargin: Style.space(2)
                    textFormat: Text.PlainText
                    text: logEntry.expanded ? "Show less" : "Show all"
                    color: Color.accent
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: logEntry.expanded = !logEntry.expanded }
                  }
                  CopyChip {
                    id: entryCopy
                    anchors.right: parent.right
                    anchors.top: parent.top
                    tip: logEntry.modelData.kind === "practice" ? "Copy this entry with its full prompt" : "Copy this entry"
                    onCopy: root.copyText(logEntry.full)
                  }
                }
              }
            }

            // Agents in three groups: who she can use now, who is waiting on a limit to reset (with
            // when), and who can't be used at all — collapsed to a count until asked.
            Column {
              width: parent.width
              spacing: Style.space(8)
              PanelSectionHeader { width: parent.width; text: "AGENTS" }
              // Copies: how many run of how many allowed, why any are held, and the owner's limit (− / +).
              Repeater {
                model: root.constance.copies || []
                Item {
                  required property var modelData
                  width: parent.width
                  height: Math.max(copiesText.implicitHeight, copiesStep.height)
                  Text {
                    id: copiesText
                    anchors.left: parent.left
                    anchors.right: copiesStep.left
                    anchors.rightMargin: Style.space(8)
                    anchors.verticalCenter: parent.verticalCenter
                    textFormat: Text.PlainText
                    wrapMode: Text.WordWrap
                    text: root.constanceCopiesLine(modelData)
                    color: modelData.held > 0 ? root.foreground : root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                  }
                  Row {
                    id: copiesStep
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: Style.space(6)
                    Repeater {
                      model: [{ glyph: "\u2212", delta: -1 }, { glyph: "+", delta: 1 }]
                      Rectangle {
                        required property var modelData
                        width: Style.space(22); height: Style.space(20); radius: Style.cornerRadius
                        color: root.track
                        Text { anchors.centerIn: parent; textFormat: Text.PlainText; text: modelData.glyph; color: root.foreground; font.family: root.fontFamily; font.pixelSize: Style.font.caption }
                        MouseArea {
                          id: stepArea
                          anchors.fill: parent
                          hoverEnabled: true
                          cursorShape: Qt.PointingHandCursor
                          onClicked: root.writeSetting(["maxCopies", String(Math.max(1, Math.min(10, Number(copiesStep.parent.modelData.limit) + modelData.delta)))])
                        }
                        PanelToolTip { visible: stepArea.containsMouse; text: "Most copies she may run at once (1–10; 10 is Devin's published limit). New copies start one at a time, only when the machine's load and free memory allow."; fontFamily: root.fontFamily }
                      }
                    }
                  }
                }
              }
              ConstanceAgentRow {
                visible: !!root.constanceGroups.me
                modelData: root.constanceGroups.me || ({ id: "claude" })
              }

              PanelSectionHeader { width: parent.width; text: "READY" }
              Repeater {
                model: root.constanceGroups.ready
                ConstanceAgentRow { }
              }
              Text {
                visible: root.constanceGroups.ready.length === 0
                width: parent.width
                textFormat: Text.PlainText
                text: "none"
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }

              PanelSectionHeader { width: parent.width; text: "WAITING ON LIMITS" }
              Repeater {
                model: root.constanceGroups.waiting
                ConstanceAgentRow { }
              }
              Text {
                visible: root.constanceGroups.waiting.length === 0
                width: parent.width
                textFormat: Text.PlainText
                text: "none"
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }

              Item {
                width: parent.width
                height: cantHead.implicitHeight + Style.space(4)
                Text {
                  id: cantHead
                  textFormat: Text.PlainText
                  text: "CAN'T USE (" + root.constanceGroups.cant.length + ") " + (root.constanceCantOpen ? "▾" : "▸")
                  color: Qt.darker(root.foreground, 1.4)
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  font.bold: true
                  topPadding: Math.ceil(Style.font.caption * 0.15)
                }
                MouseArea {
                  anchors.fill: parent
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onClicked: root.constanceCantOpen = !root.constanceCantOpen
                }
              }
              Column {
                visible: root.constanceCantOpen && root.constanceGroups.cant.length > 0
                width: parent.width
                spacing: Style.space(4)
                Repeater {
                  model: root.constanceGroups.cant
                  ConstanceAgentRow { }
                }
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

          // ---------------- Welcome view: the first-run screen, three tips and a dismiss button.
          // Shows on the first panel open after install until "Got it" writes welcomeDismissed.
          Column {
            id: welcomeView
            visible: root.welcomeOpen
            width: parent.width
            spacing: Style.space(14)
            Column {
              width: parent.width
              spacing: Style.space(6)
              Text {
                textFormat: Text.PlainText
                text: "Cook Meter watches your AI coding agents so you know exactly when you can go cook."
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                wrapMode: Text.WordWrap
                width: parent.width
              }
              Text {
                textFormat: Text.PlainText
                text: "Three things worth knowing:"
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
              }
            }
            Repeater {
              model: [
                { n: "1", t: "One glance is enough — the bar number and each tab's chip colors are the session and weekly meters: green under 60%, amber to 85%, red above. A reset plays a cha-ching and flashes the chip." },
                { n: "2", t: "Click any tab for its limits, models and tokens by day. Drag chips to reorder; the gear holds the switches, and CS / C run Claude Squad and Constance." },
                { n: "3", t: "Only installed agents get a tab, and only plan limits, usage and resets are shown — never credit balances or spend. Logins are read-only; nothing is sent anywhere but each vendor's own endpoint." }
              ]
              delegate: Rectangle {
                required property var modelData
                width: parent.width
                height: welcomeTipText.implicitHeight + Style.space(20)
                radius: Style.cornerRadius
                color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.05)
                Row {
                  anchors.fill: parent
                  anchors.margins: Style.space(10)
                  spacing: Style.space(10)
                  Rectangle {
                    width: Style.space(22); height: width; radius: width / 2
                    color: Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.2)
                    border.width: 1; border.color: root.soft(Color.accent, 0.6)
                    Text {
                      anchors.centerIn: parent
                      textFormat: Text.PlainText
                      text: modelData.n
                      color: Color.accent
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.bodySmall
                      font.bold: true
                    }
                  }
                  Text {
                    id: welcomeTipText
                    width: parent.width - Style.space(52)
                    textFormat: Text.PlainText
                    text: modelData.t
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                    wrapMode: Text.WordWrap
                    anchors.verticalCenter: parent.verticalCenter
                  }
                }
              }
            }
            Rectangle {
              width: parent.width
              height: welcomeGoLabel.implicitHeight + Style.space(20)
              radius: Style.cornerRadius
              color: welcomeGoArea.containsMouse ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.3) : Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.18)
              border.width: 1
              border.color: root.soft(Color.accent, 0.9)
              Text {
                id: welcomeGoLabel
                anchors.centerIn: parent
                textFormat: Text.PlainText
                text: "Got it"
                color: Color.accent
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                font.bold: true
              }
              MouseArea { id: welcomeGoArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: root.dismissWelcome() }
            }
          }

          // ---------------- Settings view: replaces the agent details while open
          Column {
            id: settingsView
            visible: root.settingsOpen
            width: parent.width
            spacing: Style.space(8)

            PanelSectionHeader { width: parent.width; text: "START" }
            SettingSwitch {
              width: parent.width
              label: "Skip permission prompts"
              checked: root.skipPermissions
              onToggled: root.writeSetting(["skipPermissions", String(!root.skipPermissions)])
            }

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
              label: "Angry robot when a limit is used up"
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
