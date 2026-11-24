import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const qmlFile = path.join(pluginDir, 'WeeklySummary.qml');
const qml6 = '/usr/bin/qml6';

// --- text check: standalone QtQuick component, no qs.* imports ---
{
  const src = fs.readFileSync(qmlFile, 'utf8');
  const imports = src.split('\n').filter((l) => /^\s*import\s/.test(l));
  for (const line of imports) {
    assert.ok(!/\bqs\./.test(line), `WeeklySummary.qml must not import qs.*: ${line}`);
  }
  assert.ok(imports.some((l) => /import\s+QtQuick\s*$/.test(l)), 'WeeklySummary.qml should import QtQuick');
}

// --- live check: instantiate under qml6 offscreen when available ---
if (!fs.existsSync(qml6)) {
  console.log('weekly-summary-qml tests passed (qml6 not installed, harness skipped)');
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-summary-qml-'));
  const harness = path.join(dir, 'harness.qml');
  const pluginUrl = 'file://' + pluginDir;
  fs.writeFileSync(harness, `import QtQuick
import "${pluginUrl}" as Plugin

Item {
  width: 400
  height: 500

  Plugin.WeeklySummary {
    id: full
    y: 10
    width: 380
    textColor: "#ffffff"
    mutedColor: "#999999"
    barColor: "#4caf50"
    fontFamily: "sans"
    summary: ({
      from: "2026-11-18",
      to: "2026-11-24",
      resetsHit: 3,
      busiestDay: { date: "2026-11-22", tokens: 1200000 },
      agents: [
        { id: "claude", name: "Claude", tokens: 1200000, resets: 2, peaks: {} },
        { id: "devin", name: "Devin", tokens: 3400, resets: 0, peaks: {} },
        { id: "grok", name: "Grok", tokens: null, resets: 1, peaks: {} }
      ]
    })
  }

  Plugin.WeeklySummary {
    y: 260
    width: 380
    textColor: "#ffffff"
    mutedColor: "#999999"
    barColor: "#4caf50"
    fontFamily: "sans"
    summary: ({ from: "2026-11-18", to: "2026-11-24", resetsHit: 0, busiestDay: null, agents: [] })
  }

  Timer {
    interval: 800
    running: true
    onTriggered: Qt.quit()
  }
}
`);

  const res = spawnSync(qml6, [harness], {
    env: { ...process.env, QT_QPA_PLATFORM: 'offscreen' },
    encoding: 'utf8',
    timeout: 20000,
  });
  const err = `${res.stderr || ''}\n${res.error ? String(res.error) : ''}`;
  for (const bad of ['Error', 'ReferenceError', 'TypeError', 'is not a type']) {
    assert.ok(!err.includes(bad), `qml6 harness stderr contains ${bad}:\n${res.stderr}`);
  }
  if (res.error) throw res.error;
  assert.equal(res.status, 0, `qml6 exited ${res.status}:\n${res.stderr}`);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('weekly-summary-qml tests passed');
}
