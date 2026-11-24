import QtQuick

// "This week" tab: standalone summary of bin/weekly-summary.mjs weeklySummary().
// QtQuick only — no qs.* imports — so it can be tested with plain qml6 offscreen.
Item {
  id: root

  property var summary: ({ agents: [] })
  property color textColor: "white"
  property color mutedColor: Qt.rgba(1, 1, 1, 0.55)
  property color barColor: textColor
  property string fontFamily: ""

  implicitWidth: 360
  implicitHeight: contentCol.implicitHeight
  width: implicitWidth
  height: implicitHeight

  function fmtTokens(n) {
    if (n === null || n === undefined || !isFinite(n)) return "—"
    var abs = Math.abs(n)
    if (abs >= 1e6) return trim((n / 1e6).toFixed(1)) + "M"
    if (abs >= 1e3) return trim((n / 1e3).toFixed(1)) + "K"
    return String(Math.round(n))
    function trim(s) { return s.length > 1 && s.charAt(s.length - 1) === "0" && s.charAt(s.length - 2) === "." ? s.slice(0, -2) : s }
  }

  function parseDay(key) {
    var p = String(key).split("-")
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]))
  }

  function monthDay(key) {
    var d = parseDay(key)
    return ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]
      + " " + d.getDate()
  }

  function weekdayMonthDay(key) {
    var d = parseDay(key)
    return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]
      + " " + monthDay(key)
  }

  function headerText() {
    var s = summary || {}
    if (!s.from || !s.to) return "This week"
    return monthDay(s.from) + (s.from === s.to ? "" : " – " + monthDay(s.to))
  }

  function busiestText() {
    var s = summary || {}
    if (!s.busiestDay || !s.busiestDay.date) return ""
    return "Busiest day: " + weekdayMonthDay(s.busiestDay.date) + " · " + fmtTokens(s.busiestDay.tokens) + " tokens"
  }

  function agents() { return (summary && summary.agents) || [] }

  function topTokens() {
    var best = 0
    var list = agents()
    for (var i = 0; i < list.length; i++) {
      var t = list[i].tokens
      if (typeof t === "number" && isFinite(t) && t > best) best = t
    }
    return best
  }

  Column {
    id: contentCol
    width: root.width
    spacing: 4

    Text {
      width: parent.width
      text: root.headerText()
      color: root.textColor
      font.family: root.fontFamily
      font.pixelSize: 15
      font.bold: true
    }

    Text {
      width: parent.width
      text: "Resets hit: " + ((summary && summary.resetsHit) || 0)
      color: root.mutedColor
      font.family: root.fontFamily
      font.pixelSize: 12
    }

    Text {
      width: parent.width
      visible: text.length > 0
      text: root.busiestText()
      color: root.mutedColor
      font.family: root.fontFamily
      font.pixelSize: 12
    }

    Item { width: 1; height: 6 }

    Repeater {
      model: root.agents()

      delegate: Item {
        id: row
        required property var modelData
        width: contentCol.width
        height: 24

        property var agent: modelData
        readonly property bool hasTokens: typeof agent.tokens === "number" && isFinite(agent.tokens)
        readonly property real tokenCount: hasTokens ? agent.tokens : 0

        Text {
          id: agentName
          anchors.left: parent.left
          anchors.verticalCenter: parent.verticalCenter
          width: Math.min(implicitWidth, 120)
          text: row.agent.name || row.agent.id
          color: root.textColor
          font.family: root.fontFamily
          font.pixelSize: 13
          elide: Text.ElideRight
        }

        Text {
          id: agentTokens
          anchors.right: parent.right
          anchors.verticalCenter: parent.verticalCenter
          width: 110
          horizontalAlignment: Text.AlignRight
          text: (row.hasTokens ? root.fmtTokens(row.agent.tokens) : "—")
            + (row.agent.resets > 0 ? "  · " + row.agent.resets + " resets" : "")
          color: root.mutedColor
          font.family: root.fontFamily
          font.pixelSize: 12
        }

        Rectangle {
          anchors.left: agentName.right
          anchors.leftMargin: 10
          anchors.right: agentTokens.left
          anchors.rightMargin: 10
          anchors.verticalCenter: parent.verticalCenter
          height: 8
          radius: 4
          visible: row.hasTokens
          color: Qt.rgba(root.barColor.r, root.barColor.g, root.barColor.b, 0.18)

          Rectangle {
            width: parent.width * (row.hasTokens && root.topTokens() > 0 ? row.tokenCount / root.topTokens() : 0)
            height: parent.height
            radius: parent.radius
            color: root.barColor
          }
        }
      }
    }

    Text {
      width: parent.width
      visible: root.agents().length === 0
      text: "No usage recorded this week yet."
      color: root.mutedColor
      font.family: root.fontFamily
      font.pixelSize: 13
      font.italic: true
    }
  }
}
