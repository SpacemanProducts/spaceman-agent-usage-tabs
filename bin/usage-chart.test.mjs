// usage-chart.js: bars() scaling, null-vs-0 honesty, labels; UsageChart.qml
// loads under qml6 when available.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const src = fs.readFileSync(path.join(root, "usage-chart.js"), "utf8").replace(/^\.pragma library\s*$/m, "");
const ctx = {}; vm.createContext(ctx); vm.runInContext(src, ctx);
const { bars, peakLabel, hasData } = ctx;

// ---- scaling: heights are 0..maxHeight relative to the largest non-null day
{
  const b = bars([
    { date: "2026-11-20", tokens: 100 },
    { date: "2026-11-21", tokens: 400 },
    { date: "2026-11-22", tokens: 200 },
  ], 40);
  assert.equal(b.length, 3);
  assert.equal(b[1].height, 40, "largest day fills maxHeight");
  assert.equal(b[0].height, 10);
  assert.equal(b[2].height, 20);
  assert.deepEqual(b.map((x) => x.tokens), [100, 400, 200]);
  assert.deepEqual(b.map((x) => x.date), ["2026-11-20", "2026-11-21", "2026-11-22"]);
}

// ---- null vs 0: null is 'no data' (-1), a reported 0 is a real 0-height bar
{
  const b = bars([
    { date: "2026-11-20", tokens: null },
    { date: "2026-11-21", tokens: 0 },
    { date: "2026-11-22", tokens: 1000 },
  ], 30);
  assert.equal(b[0].height, -1, "null day has no bar");
  assert.equal(b[0].tokens, null);
  assert.equal(b[1].height, 0, "reported 0 draws at the baseline");
  assert.equal(b[1].tokens, 0);
  assert.equal(b[2].height, 30);
}

// ---- all-null: nothing to scale, every day is -1, no data flags
{
  const s = [{ date: "2026-11-20", tokens: null }, { date: "2026-11-21", tokens: null }];
  const b = bars(s, 30);
  assert.ok(b.every((x) => x.height === -1));
  assert.equal(hasData(s), false);
  assert.equal(peakLabel(s), "");
}

// ---- single day: it is the peak, so it fills maxHeight
{
  const b = bars([{ date: "2026-11-24", tokens: 500 }], 36);
  assert.equal(b[0].height, 36);
  assert.equal(b[0].label, "Nov 24: 500 tokens");
  assert.equal(peakLabel([{ date: "2026-11-24", tokens: 500 }]), "peak 500");
}

// ---- labels and peak formatting
{
  const b = bars([
    { date: "2026-11-23", tokens: 1200000 },
    { date: "2026-11-24", tokens: null },
    { date: "2026-11-25", tokens: 900 },
  ], 10);
  assert.equal(b[0].label, "Nov 23: 1.2M tokens");
  assert.equal(b[1].label, "Nov 24: no data");
  assert.equal(b[2].label, "Nov 25: 900 tokens");
  assert.equal(peakLabel(b.map((x) => ({ date: x.date, tokens: x.tokens }))), "peak 1.2M");
  assert.equal(hasData([{ date: "2026-11-24", tokens: 0 }]), true, "a reported 0 is still data");
  assert.equal(hasData([]), false);
  assert.equal(hasData(undefined), false);
  assert.equal(bars(undefined, 10).length, 0, "non-array input is safe");
}

// ---- UsageChart.qml must actually load: instantiate it under qml6 offscreen
const qml6 = "/usr/bin/qml6";
if (fs.existsSync(qml6)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-chart-"));
  const file = path.join(dir, "harness.qml");
  fs.writeFileSync(file, `import QtQuick
import "file://${root}/UsageChart.qml"

Item {
  width: 400
  height: 200
  UsageChart {
    anchors.centerIn: parent
    series: [
      { date: "2026-11-20", tokens: 100000 },
      { date: "2026-11-21", tokens: null },
      { date: "2026-11-22", tokens: 0 },
      { date: "2026-11-23", tokens: 1200000 },
      { date: "2026-11-24", tokens: 800000 }
    ]
  }
  Timer { interval: 300; running: true; onTriggered: Qt.quit() }
}
`);
  const r = spawnSync(qml6, [file], {
    env: { ...process.env, QT_QPA_PLATFORM: "offscreen" },
    timeout: 20000,
    encoding: "utf8",
  });
  assert.ifError(r.error);
  const err = String(r.stderr || "");
  assert.ok(!/error|ReferenceError|TypeError/i.test(err), `qml6 stderr had errors:\n${err}`);
  console.log("usage-chart: all tests passed (qml6 harness clean)");
} else {
  console.log("usage-chart: all tests passed (qml6 harness skipped: /usr/bin/qml6 missing)");
}
