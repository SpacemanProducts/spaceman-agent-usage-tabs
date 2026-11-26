import QtQuick
import "usage-chart.js" as Chart

// A 30-day usage bar chart for an agent tab. Bars come from usage-chart.js,
// imported as Chart (never as UsageChart: inside this file that name is the
// component itself). The component hides itself when the series has no
// reported data so a missing feed never draws a placeholder chart.
Item {
  id: root

  property var series: []
  property color barColor: "#4caf50"
  property color emptyColor: "#3a3f4a"
  property int chartHeight: 36
  property string fontFamily: ""

  readonly property var bars: Chart.bars(series, chartHeight)
  readonly property string peak: Chart.peakLabel(series)
  readonly property bool hasData: Chart.hasData(series)

  visible: hasData
  implicitWidth: hasData ? bars.length * (barWidth + spacing) - spacing : 0
  implicitHeight: hasData ? chartHeight + 14 : 0

  readonly property int barWidth: 3
  readonly property int spacing: 2

  Row {
    id: chartRow
    anchors.left: parent.left
    anchors.bottom: parent.bottom
    anchors.bottomMargin: 12
    spacing: root.spacing

    Repeater {
      model: root.bars
      delegate: Item {
        width: root.barWidth
        height: root.chartHeight

        Rectangle {
          visible: modelData.height >= 0
          anchors.bottom: parent.bottom
          width: modelData.height >= 0 ? root.barWidth : 0
          height: modelData.height >= 0 ? modelData.height : 0
          radius: 1
          color: root.barColor
        }

        Rectangle {
          visible: modelData.height < 0
          anchors.bottom: parent.bottom
          anchors.bottomMargin: (root.chartHeight - 8) / 2
          width: 1
          height: 8
          color: root.emptyColor
        }
      }
    }
  }

  Text {
    anchors.left: parent.left
    anchors.bottom: parent.bottom
    text: root.peak
    font.family: root.fontFamily !== "" ? root.fontFamily : "Sans Serif"
    font.pixelSize: 9
    color: root.emptyColor
  }
}
