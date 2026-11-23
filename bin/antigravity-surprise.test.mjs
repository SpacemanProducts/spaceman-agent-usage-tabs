import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { immediateResetKind, surpriseNotifyArgs, surpriseStateFile, updateSurpriseState, writeSurpriseState } from "./antigravity-surprise.mjs";

const timestamp = 1_800_000_000_000;
let state = updateSurpriseState(null, "record", timestamp);
assert.deepEqual(state, { at: timestamp, clickedAt: 0, playedAt: 0 });
assert.deepEqual(updateSurpriseState(state, "record", timestamp), state, "recording the same reset preserves its state");
assert.deepEqual(updateSurpriseState(state, "click", timestamp), { ...state, clickedAt: timestamp });
assert.deepEqual(updateSurpriseState(state, "played", timestamp), { ...state, playedAt: timestamp });
assert.deepEqual(updateSurpriseState(state, "click", timestamp - 1), state, "a stale notification cannot change a newer reset");
assert.equal(updateSurpriseState(state, "record", timestamp + 1).playedAt, 0, "a new reset starts unplayed");
assert.throws(() => updateSurpriseState(null, "record", "not-a-time"), /positive integer/);

assert.equal(immediateResetKind([{ a: { id: "antigravity" }, info: { kind: "surprise" } }]), null);
assert.equal(immediateResetKind([
  { a: { id: "antigravity" }, info: { kind: "surprise" } },
  { a: { id: "codex" }, info: { kind: "scheduled" } },
]), "scheduled", "an unrelated reset keeps its ordinary sound");
assert.equal(immediateResetKind([
  { a: { id: "antigravity" }, info: { kind: "surprise" } },
  { a: { id: "claude" }, info: { kind: "surprise" } },
]), "surprise", "Claude's existing surprise sound is unchanged");

const args = surpriseNotifyArgs({ title: "Antigravity reset", body: "It reset early." }, "/plugin/surprise-burst.svg");
assert.ok(args.includes("-1"), "the notification does not time out");
assert.ok(args.includes("critical"), "critical urgency keeps the toast on screen until clicked");
assert.ok(args.includes("--wait"), "the notification process waits for user action");
assert.ok(args.includes("--action=default=Celebrate"), "clicking the notification has a default action");
assert.ok(args.includes("boolean:suppress-sound:true"), "the notification stays silent");
assert.ok(args.includes("string:image-path:/plugin/surprise-burst.svg"));
assert.deepEqual(args.slice(-2), ["Antigravity reset", "It reset early."]);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-surprise-"));
try {
  const file = surpriseStateFile(dir);
  writeSurpriseState(file, "record", timestamp);
  writeSurpriseState(file, "played", timestamp);
  writeSurpriseState(file, "click", timestamp);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { at: timestamp, clickedAt: timestamp, playedAt: timestamp });

  const bin = path.join(dir, "bin");
  const xdg = path.join(dir, "xdg");
  fs.mkdirSync(bin);
  const fakeNotifySend = path.join(bin, "notify-send");
  fs.writeFileSync(fakeNotifySend, "#!/bin/sh\nprintf 'default\\n'\n", { mode: 0o700 });
  const actionState = surpriseStateFile(path.join(xdg, "omarchy", "agent-usage-tabs"));
  writeSurpriseState(actionState, "record", timestamp);
  execFileSync(process.execPath, [path.join(rootFromHere(), "bin", "antigravity-surprise.mjs"), "notify", String(timestamp), "title", "body"], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_STATE_HOME: xdg },
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(actionState, "utf8")), { at: timestamp, clickedAt: timestamp, playedAt: 0 }, "the default notification action is recorded for the panel");

  writeSurpriseState(actionState, "record", timestamp + 1);
  const script = path.join(rootFromHere(), "bin", "antigravity-surprise.mjs");
  const env = { ...process.env, XDG_STATE_HOME: xdg };
  const runStateAction = (action) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, action, String(timestamp + 1)], { env, stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`state action ${action} exited ${code}`)));
  });
  await Promise.all([runStateAction("played"), runStateAction("click")]);
  assert.deepEqual(JSON.parse(fs.readFileSync(actionState, "utf8")), { at: timestamp + 1, clickedAt: timestamp + 1, playedAt: timestamp + 1 }, "simultaneous click and playback acknowledgements do not lose state");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

function rootFromHere() { return path.join(path.dirname(new URL(import.meta.url).pathname), ".."); }
const root = rootFromHere();
const collector = fs.readFileSync(path.join(root, "bin", "collect.mjs"), "utf8");
const panel = fs.readFileSync(path.join(root, "Panel.qml"), "utf8");
assert.ok(collector.includes('writeSurpriseState(surpriseStateFile(OUT_DIR), "record"'), "collector records Antigravity's surprise");
assert.ok(collector.includes('"antigravity-surprise.mjs"), "notify"'), "collector starts the actionable notification");
assert.ok(panel.includes("function playAntigravitySurprise("), "panel provides the click celebration");
assert.ok(panel.includes("antigravity-surprise.json"), "panel watches celebration state");
console.log("antigravity-surprise: all tests passed");
