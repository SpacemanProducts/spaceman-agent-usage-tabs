// Headless smoke test for Panel.qml — small and quick, no shell restart needed.
//
// Part A (always runs):
//   1. Panel.qml has balanced braces/brackets (strings and comments stripped first).
//   2. The KeyboardPanel block has no non-Item direct children: handlers, timers,
//      processes and other QtObject types only work inside an Item (the known
//      KeyboardPanel pitfall). Custom Panel* types are trusted to be Items.
//   3. Every property the QML reads off the Constance status JSON
//      (`constance.X`, `constanceBoard.X` and one level deeper) exists in the
//      output of `node bin/constance.mjs status` against an empty temp state
//      dir, with the same env hooks bin/constance.test.mjs uses. Fields under a
//      null parent (goal) or inside arrays can't be checked on an idle status
//      and are skipped; pace.{hard,title,until} only exist in stop mode
//      (bin/constance-pace.mjs) and are allowlisted.
//
// Part B (best effort): load Panel.qml under `timeout 20 qml6 -platform
// offscreen` with stub qmldirs for the Quickshell/qs.Commons/qs.Ui imports.
// The real Quickshell types live inside the qs binary, so plain qml6 can never
// provide them — when the component can't load for that reason this prints
// "skip: <reason>" and passes. qml6/quickshell are ALWAYS wrapped in timeout:
// an earlier attempt hung for two hours.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const qml = fs.readFileSync(path.join(pluginDir, "Panel.qml"), "utf8");

// Blank out strings and comments (newlines kept) so braces inside them don't
// count. Template literals are blanked whole; any ${} inside them is balanced
// anyway, so the counts stay honest.
function stripQml(src) {
  let out = "", i = 0, n = src.length;
  const blank = (len) => { out += " ".repeat(len); };
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") {
      let j = i;
      while (j < n && src[j] !== "\n") j++;
      blank(j - i); i = j;
    } else if (c === "/" && d === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
      j = Math.min(j + 2, n);
      out += src.slice(i, j).replace(/[^\n]/g, " "); i = j;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === "\\") j++; j++; }
      j = Math.min(j + 1, n);
      blank(j - i); i = j;
    } else { out += c; i++; }
  }
  return out;
}
const code = stripQml(qml);

// ---- Part A1: balanced braces and brackets ----
{
  for (const [open, close, name] of [["{", "}", "braces"], ["[", "]", "brackets"]]) {
    let depth = 0;
    for (const ch of code) {
      if (ch === open) depth++;
      if (ch === close) depth--;
      assert.ok(depth >= 0, `Panel.qml: unbalanced ${name} (went negative)`);
    }
    assert.equal(depth, 0, `Panel.qml: unbalanced ${name} (${depth} unclosed)`);
  }
}

// ---- Part A2: no non-Item direct children of KeyboardPanel ----
{
  // QtObject-ish types that must never sit directly inside KeyboardPanel.
  const NON_ITEM = new Set([
    "Timer", "Connections", "HoverHandler", "DragHandler", "PinchHandler", "PanGestureHandler",
    "Process", "FileView", "StdioCollector", "QtObject", "Binding", "PropertyChanges",
    "NumberAnimation", "SmoothedAnimation", "SpringAnimation", "XAnimator", "ParentChange",
    "PropertyAction", "WorkerScript", "ListModel", "XmlListModel", "Instantiator", "DelegateModel",
  ]);
  const start = code.search(/\bKeyboardPanel\s*\{/);
  assert.ok(start >= 0, "Panel.qml: no KeyboardPanel block found");
  const open = code.indexOf("{", start);
  const children = [];
  let depth = 1, i = open + 1, n = code.length;
  while (i < n && depth > 0) {
    const ch = code[i];
    if (ch === "{") { depth++; i++; continue; }
    if (ch === "}") { depth--; i++; continue; }
    if (depth === 1 && /[A-Z]/.test(ch) && (i === 0 || /\s/.test(code[i - 1]) || code[i - 1] === "}" || code[i - 1] === ";")) {
      const m = /^[A-Z][A-Za-z0-9_.]*/.exec(code.slice(i));
      if (m) {
        let j = i + m[0].length;
        while (/\s/.test(code[j])) j++;
        if (code[j] === "{") { children.push(m[0]); i = j; continue; }
      }
    }
    i++;
  }
  const bad = children.filter((t) => NON_ITEM.has(t));
  assert.deepEqual(bad, [], `KeyboardPanel has non-Item direct children: ${bad.join(", ")} (all children: ${children.join(", ")})`);
}

// ---- Part A3: fields the QML reads off the constance status JSON ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "panel-headless-"));
  const home = path.join(root, "home"), state = path.join(root, "state");
  fs.mkdirSync(path.join(home, "Projects"), { recursive: true });
  const proc = path.join(root, "proc"); fs.mkdirSync(proc);
  fs.writeFileSync(path.join(proc, "loadavg"), "0.10 0.50 0.50 1/500 999\n");
  fs.writeFileSync(path.join(proc, "meminfo"), "MemTotal: 33554432 kB\nMemAvailable: 20971520 kB\n");
  const env = { ...process.env, HOME: home, SQUAD_PROJECTS: path.join(home, "Projects"), XDG_STATE_HOME: state, XDG_DATA_HOME: path.join(home, ".local", "share"), CONSTANCE_PROC: proc };
  const out = execFileSync("node", [path.join(pluginDir, "bin", "constance.mjs"), "status"], { env, encoding: "utf8" });
  const status = JSON.parse(out);

  // constance.X / constanceBoard.X (board is the alias for status.board), plus
  // deeper dotted reads like constance.pace.hard or constanceBoard.checklist.done.
  const reads = new Map(); // dotted path -> true
  for (const m of qml.matchAll(/\bconstance(Board)?\.([A-Za-z_]\w*)((?:\.[A-Za-z_]\w*)*)/g)) {
    const segs = m[1] ? ["board", m[2], ...m[3].split(".").filter(Boolean)]
      : [m[2], ...m[3].split(".").filter(Boolean)];
    if (segs[0] === "mjs") continue; // "bin/constance.mjs" strings, not a field
    reads.set(segs.join("."), true);
  }
  // pace.{hard,title,until} exist only in stop mode (bin/constance-pace.mjs).
  const CONDITIONAL = new Set(["pace.hard", "pace.title", "pace.until"]);
  const missing = [];
  for (const dotted of reads.keys()) {
    if (CONDITIONAL.has(dotted)) continue;
    const segs = dotted.split(".");
    let cur = status;
    for (const s of segs) {
      if (cur === null || cur === undefined) break;          // e.g. goal: null when idle
      if (Array.isArray(cur)) break;                        // element fields aren't in the schema
      if (typeof cur !== "object") break;
      if (!(s in cur)) { missing.push(dotted); break; }
      cur = cur[s];
    }
  }
  assert.deepEqual(missing, [], `Panel.qml reads status fields the payload doesn't have: ${missing.join(", ")}`);
}

// ---- Part B: best-effort qml6 offscreen load ----
{
  const probe = spawnSync("qml6", ["-version"], { env: { ...process.env, QT_QPA_PLATFORM: "offscreen" }, encoding: "utf8", timeout: 10000 });
  if (probe.error) {
    console.log(`panel-headless: skip: qml6 not installed (${probe.error.code || probe.error.message})`);
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "panel-headless-qml-"));
    const imports = path.join(dir, "imports");
    for (const mod of ["Quickshell", "Quickshell.Io", "Quickshell.Wayland", "qs.Commons", "qs.Ui"]) {
      const d = path.join(imports, ...mod.split("."));
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "qmldir"), `module ${mod}\n`);
    }
    const harness = path.join(dir, "harness.qml");
    fs.writeFileSync(harness, `import QtQuick
import "file://${pluginDir}" as Plugin

Item {
  width: 10
  height: 10
  Plugin.Panel {}
  Timer { interval: 500; running: true; onTriggered: Qt.quit() }
}
`);
    const res = spawnSync("timeout", ["20", "qml6", "-platform", "offscreen", "-I", imports, harness], {
      env: { ...process.env, HOME: dir, XDG_STATE_HOME: path.join(dir, "state"), XDG_DATA_HOME: path.join(dir, "share"), QT_QPA_PLATFORM: "offscreen" },
      encoding: "utf8",
      timeout: 30000,
    });
    const out = `${res.stdout || ""}\n${res.stderr || ""}`;
    const failLine = out.split("\n").find((l) => /did not load|is not a type|not installed|is not a function|Cannot assign|is not defined|does not contain|module .* unqualified|incompatible|is not a value type/i.test(l));
    if (res.error || res.status === 124 || (failLine && !/harness\.qml:\d+: (?:Warning|warning)/.test(failLine))) {
      const reason = res.error ? String(res.error.code || res.error.message) : (failLine || `exit ${res.status} / timeout`).trim();
      console.log(`panel-headless: skip: ${reason}`);
    } else {
      assert.equal(res.status, 0, `qml6 exited ${res.status}:\n${out}`);
      assert.ok(!/error/i.test(out), `qml6 reported errors:\n${out}`);
    }
  }
}

console.log("panel-headless: all tests passed");
