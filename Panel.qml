import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons
import qs.Ui
import "chip-meters.js" as ChipMeters

// Cook Meter (plugin id spaceman.agent-usage-tabs). Display only: bin/collect.mjs writes data.json, this file
// watches it. Written from scratch; shares no code or state with other plugins.
Panel {
  id: root
  moduleName: "spaceman.agent-usage-tabs"
  ipcTarget: "spaceman.agent-usage-tabs"
  manageIpc: false

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property color track: Style.selectedFillFor(foreground, Color.accent)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  // Meter colors: green < 60%, amber 60-85%, red > 85%.
  readonly property color green: "#4caf50"
  readonly property color amber: "#f2a900"
  readonly property color red: "#e5484d"
  function meterColor(p) { return p > 0.85 ? red : (p >= 0.6 ? amber : green) }

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
  readonly property bool resetAnimation: userSettings.resetAnimation !== undefined
    ? userSettings.resetAnimation !== false : root.setting("resetAnimation", true) !== false
  readonly property bool showDetail: !!agent && !settingsOpen
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
  readonly property var defaultOrder: ["claude", "antigravity", "grok", "codex", "copilot", "cursor", "opencode", "kimi", "kiro", "devin", "amp", "hermes"]
  // `tabOrder` is a comma-separated list of agent ids. Ids it omits keep their
  // default position after the listed ones, so no tab can be hidden by it.
  readonly property var agents: {
    var wanted = String(root.setting("tabOrder", "")).toLowerCase().split(",")
      .map(function(x) { return x.trim() }).filter(function(x) { return x !== "" })
    var order = []
    wanted.concat(defaultOrder).forEach(function(id) { if (order.indexOf(id) < 0) order.push(id) })
    var known = {}
    rawAgents.forEach(function(a) { if (isShownTab(a)) known[a.id] = a })
    var out = []
    order.forEach(function(id) { if (known[id]) { out.push(known[id]); delete known[id] } })
    rawAgents.forEach(function(a) { if (known[a.id]) out.push(a) })
    return out
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
    testNotifier.command = ["notify-send", "-a", "Cook Meter", "-u", "normal", "-i", "emblem-ok-symbolic",
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
  // Highest session-window usage across every agent that reports one (-1: none).
  readonly property real topSession: {
    var top = -1
    for (var i = 0; i < agents.length; i++) {
      var ls = agents[i].limits || []
      for (var j = 0; j < ls.length; j++)
        if (/session/i.test(String(ls[j].title)) && ls[j].percent > top) top = ls[j].percent
    }
    return top
  }

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
  // "removing Dec 14" for a dated notice; "past removal date" when that date has
  // gone by but the model is still listed.
  function removingText(r) {
    var v = String((r && r.removing) || "")
    if (v === "") return ""
    var months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
    var full = v.match(/^(\d{4})-(\d{2})-(\d{2})$/), month = v.match(/^(\d{4})-(\d{2})$/)
    if (full) {
      var d = new Date(Number(full[1]), Number(full[2]) - 1, Number(full[3]) + 1)
      return d.getTime() < Date.now() ? "past removal date" : "removing " + months[Number(full[2]) - 1] + " " + Number(full[3])
    }
    if (month) return "removing " + months[Number(month[2]) - 1]
    return "removing"
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
  function refreshNow() { if (!collector.running) collector.running = true }

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

  onOpenedChanged: if (!opened) { autoOpened = false; autoCloseTimer.stop() } else {
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
      try { var d = JSON.parse(String(text() || "")); root.userSettings = d && typeof d === "object" && !Array.isArray(d) ? d : ({}) }
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
    onTriggered: root.nowMs = Date.now()
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
    function testCelebration(): string { root.fireTest("claude"); return "ok" }
    function testWindow(window: string): string { root.fireTest("claude", "scheduled", window); return "ok" }
    function testWindowAutoOpen(window: string): string { root.autoCelebrate("claude"); root.fireTest("claude", "scheduled", window); return "ok" }
    function settings(): string { root.settingsOpen = !root.settingsOpen; return root.settingsOpen ? "open" : "closed" }
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

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "󱚣"
    // Like the battery: a number beside the icon, amber from 60%, red above 85%.
    labelText: root.topSession >= 0 ? Math.round(root.topSession * 100) + "%" : ""
    slotSize: Style.bar.iconSlot * (root.topSession >= 0 ? 2 : 1)
    active: root.topSession >= 0.6
    activeColor: root.meterColor(root.topSession)
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
        anchors.fill: parent
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

          // ---------------- Tabs: full names, wrap rather than truncate
          Flow {
            width: parent.width
            spacing: Style.space(6)

            Repeater {
              model: root.agents

              Rectangle {
                id: chip
                required property var modelData
                required property int index
                readonly property bool selected: index === root.selectedIndex
                readonly property bool flashing: root.isFlashing(modelData)
                readonly property bool surprise: root.resetKindOf(modelData) === "surprise"
                readonly property real magnitude: root.magnitudeOf(modelData)
                readonly property color flashColor: surprise ? "#fbbc05" : root.green
                // True for the first 3 s after the collector flags a reset.
                readonly property bool celebrating: root.resetTimeOf(modelData) > 0 && root.flashNow - root.resetTimeOf(modelData) < (surprise ? 4800 : 3000)
                // Outer border = session meter, inner fill = weekly meter
                // (an agent with one meter uses it for both). Gray = no data.
                readonly property var meters: ChipMeters.chipMeters(modelData)
                readonly property color gray: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.45)
                readonly property color sessionTint: flashing ? flashColor : (meters.session < 0 ? gray : root.meterColor(meters.session))
                readonly property color weeklyTint: flashing ? flashColor : (meters.weekly < 0 ? gray : root.meterColor(meters.weekly))
                width: tabLabel.implicitWidth + Style.space(22)
                height: tabLabel.implicitHeight + Style.space(14)
                radius: Style.cornerRadius
                color: "transparent"
                border.width: selected ? 2 : 1
                border.color: sessionTint

                // The weekly meter fills the inside. The selected chip adds a
                // foreground ring around that fill, so selection never depends
                // on a color that might match the meter colors.
                Rectangle {
                  anchors.fill: parent
                  anchors.margins: Style.space(3)
                  radius: Math.max(0, chip.radius - 1)
                  color: Qt.rgba(chip.weeklyTint.r, chip.weeklyTint.g, chip.weeklyTint.b, chip.flashing ? 0.7 : (chip.selected ? 0.55 : 0.32))
                  border.width: chip.selected ? 1 : 0
                  border.color: root.foreground
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
                MouseArea {
                  anchors.fill: parent
                  cursorShape: Qt.PointingHandCursor
                  onClicked: root.selectIndex(index)
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
                      border.color: "#ffd700"
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
                        color: (chip.surprise ? ["#ffd700", "#ff3b30", "#ff9500", "#ffd700", "#34c759", "#00c7be", "#0a84ff", "#bf5af2", "#ffffff", "#ffd700"] : ["#4caf50", "#f2a900", "#ffffff", "#7fdc8a", "#ffd54f", "#e5484d"])[index % (chip.surprise ? 10 : 6)]
                      }
                      Text {
                        visible: parent.sparkle
                        anchors.centerIn: parent
                        textFormat: Text.PlainText
                        text: "\u2726"
                        color: (chip.surprise ? ["#ffffff", "#ffd700", "#fff0a0"] : ["#ffffff", "#ffd54f", "#7fdc8a"])[index % 3]
                        font.pixelSize: Style.font.title
                      }
                    }
                  }
                }
              }
            }
          }

          Text {
            visible: root.agents.length === 0 && !root.settingsOpen
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
            width: parent.width
            height: Math.max(headerName.implicitHeight, gearButton.height)

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
            Rectangle {
              id: gearButton
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              width: Style.space(28)
              height: Style.space(28)
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
                onClicked: root.settingsOpen = !root.settingsOpen
              }
              PanelToolTip { visible: gearHover.containsMouse; text: "Settings"; fontFamily: root.fontFamily }
            }
          }

          // ---------------- Settings view: replaces the agent details while open
          Column {
            id: settingsView
            visible: root.settingsOpen
            width: parent.width
            spacing: Style.space(8)

            PanelSectionHeader { width: parent.width; text: "SETTINGS" }
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
                model: [
                  { text: "\u25b6  Test celebration", id: "claude", kind: "scheduled", win: "session" },
                  { text: "\u25b6  Test weekly reset", id: "claude", kind: "scheduled", win: "weekly" },
                  { text: "\u26a1  Test surprise reset", id: "antigravity", kind: "surprise", win: "weekly" }
                ]
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
                    onClicked: root.fireTest(modelData.id, modelData.kind, modelData.win)
                  }
                }
              }
            }

            PanelSectionHeader { width: parent.width; text: "TABS" }
            Repeater {
              model: root.rawAgents
              SettingSwitch {
                required property var modelData
                width: settingsView.width
                label: modelData.name + (modelData.installed === false ? " (not installed)" : "")
                // Only an installed agent can be hidden by choice; an uninstalled
                // one follows "Hide agents that aren't installed".
                enabled: modelData.installed !== false
                checked: root.isShownTab(modelData)
                onToggled: root.writeSetting(["hidden", modelData.id, String(root.isShownTab(modelData))])
              }
            }
            Text {
              width: parent.width
              textFormat: Text.PlainText
              text: "A tab you hide stays hidden until you show it again. Agents you install later appear automatically."
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

          PanelSeparator { foreground: root.foreground; visible: root.showDetail }

          // ---------------- Limits
          Column {
            visible: root.showDetail && (root.agent.limits || []).length > 0
            width: parent.width
            spacing: Style.space(10)

            PanelSectionHeader { width: parent.width; text: "LIMITS" }

            Repeater {
              model: root.agent ? (root.agent.limits || []) : []

              Column {
                required property var modelData
                width: column.width
                spacing: Style.space(4)

                Item {
                  width: parent.width
                  height: pctText.implicitHeight
                  Text {
                    textFormat: Text.PlainText
                    text: modelData.title
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                  }
                  Text {
                    id: pctText
                    anchors.right: parent.right
                    textFormat: Text.PlainText
                    text: Math.round(modelData.percent * 100) + "% used"
                    color: root.meterColor(modelData.percent)
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                    font.bold: true
                  }
                }
                Rectangle {
                  width: parent.width
                  height: Style.space(8)
                  radius: height / 2
                  color: root.track
                  Rectangle {
                    width: Math.max(modelData.percent > 0 ? height : 0, parent.width * root.clamp(modelData.percent, 0, 1))
                    height: parent.height
                    radius: height / 2
                    color: root.meterColor(modelData.percent)
                  }
                }
                Text {
                  textFormat: Text.PlainText
                  text: {
                    var c = root.countdown(modelData.resetsAt)
                    var a = root.resetClock(modelData.resetsAt)
                    return c !== "" && a !== "" ? c + " · " + a : c
                  }
                  visible: text !== ""
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
                  visible: modelHover.containsMouse && modelData.state === "used"
                  fontFamily: root.fontFamily
                  text: "In " + root.fmtTokens(modelData.input) + " · out " + root.fmtTokens(modelData.output) + " · cache read " + root.fmtTokens(modelData.cacheRead) + " · cache write " + root.fmtTokens(modelData.cacheWrite)
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
            visible: root.showDetail
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
