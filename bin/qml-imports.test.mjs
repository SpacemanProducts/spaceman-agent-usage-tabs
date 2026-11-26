// The plugin's QML files call only helpers they import, under a name that isn't
// the component's own, and only functions those helpers define. Catches the
// 1.56.2 bug: UsageChart.qml called UsageChart.bars() etc. with no import, so
// every binding logged "Property 'bars' of object UsageChart is not a function"
// and the 30-day chart never drew.
import assert from "node:assert/strict";
import path from "node:path";
import { checkQml, checkPlugin, codeOnly, jsExports } from "./qml-imports.mjs";

const plugin = path.dirname(path.dirname(new URL(import.meta.url).pathname));

// The real plugin is clean.
assert.deepEqual(checkPlugin(plugin), [], "every QML helper call is imported and defined");

const helper = "function bars(s, h) { return []; }\nfunction hasData(s) { return false; }\nvar peakLabel = function (s) { return ''; };\n";
const readJs = (rel) => (rel === "usage-chart.js" ? helper : null);
const check = (text, name = "UsageChart") => checkQml(text, { name, readJs });

// The exact shape of the bug: calls on the component's own name, no import.
const buggy = `import QtQuick
Item {
  readonly property var bars: UsageChart.bars(series, chartHeight)
  readonly property bool hasData: UsageChart.hasData(series)
}`;
const p = check(buggy);
assert.equal(p.length, 2, "both calls are flagged: " + p.join("; "));
assert.match(p[0], /UsageChart\.bars\(\) with no `import "….js" as UsageChart` \(inside this file that name is the component itself\)/);

// Importing it under the component's own name is flagged too.
assert.match(check(`import "usage-chart.js" as UsageChart\nItem { property var b: UsageChart.bars(s, 1) }`).join(";"), /its own component name/);

// The fix shape passes; var-defined helpers count.
assert.deepEqual(check(`import QtQuick\nimport "usage-chart.js" as Chart\nItem { property var b: Chart.bars(s, 1); property string p: Chart.peakLabel(s) }`), []);

// A helper function that doesn't exist, a missing file, a duplicate alias.
assert.match(check(`import "usage-chart.js" as Chart\nItem { property var b: Chart.barz(s) }`).join(";"), /calls Chart\.barz\(\), but that helper defines no barz/);
assert.match(check(`import "gone.js" as Gone\nItem {}`, "Panel").join(";"), /imports gone\.js, which does not exist/);
assert.match(check(`import "usage-chart.js" as Chart\nimport "usage-chart.js" as Chart\nItem {}`, "Panel").join(";"), /imports two files as Chart/);

// Some other helper name used without an import (in another file).
assert.match(check(`Item { property var c: TabOrder.sorted(x) }`, "Panel").join(";"), /TabOrder\.sorted\(\) with no `import/);

// Globals and singletons, member calls, comments and strings are not flagged.
assert.deepEqual(check(`import QtQuick
Item {
  // UsageChart.bars(x) in a comment
  /* Foo.bar(1) */
  property string cmd: "node Foo.run(1) qs://x"
  property var a: Math.max(1, 2) + JSON.stringify({}) + Qt.rgba(0, 0, 0, 1) + Style.px(2)
  property var b: root.Thing.call(1)
}`, "Panel"), []);

// Helpers' exported names: functions and var/let/const, not ones in comments.
assert.deepEqual([...jsExports("// function hidden() {}\nfunction a() {}\nconst b = 1;\nlet c = 2;\n  var d = 3;\n")].sort(), ["a", "b", "c", "d"]);
assert.equal(codeOnly('a "b//c" // d').trimEnd(), 'a "    "');

console.log("qml-imports: tests passed");
