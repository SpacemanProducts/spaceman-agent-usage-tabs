import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseQwenUsageText, readQwenUsage } from "./qwen-usage.mjs";

const NOW = new Date(2026, 10, 24, 12, 0, 0).getTime(); // local noon, Tuesday
const iso = (y, m, d, h = 10) => new Date(y, m - 1, d, h, 0, 0).toISOString();
const dayStr = (y, m, d) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${y}-${p(m)}-${p(d)}`;
};

// One chat-transcript line: a ui_telemetry record carrying a billed response.
// eventOver goes inside systemPayload.uiEvent, recordOver at the record level.
function telemetry(eventOver = {}, recordOver = {}) {
  return JSON.stringify({
    type: "system",
    subtype: "ui_telemetry",
    uuid: "u-" + Math.random().toString(36).slice(2),
    timestamp: iso(2026, 11, 20),
    systemPayload: {
      uiEvent: {
        "event.name": "qwen-code.api_response",
        "event.timestamp": iso(2026, 11, 20),
        model: "qwen3-coder-plus",
        auth_type: "qwen-oauth",
        response_id: "resp-1",
        input_token_count: 1000,
        cached_content_token_count: 400,
        output_token_count: 200,
        thoughts_token_count: 50,
        total_token_count: 1650,
        ...eventOver,
      },
    },
    ...recordOver,
  });
}

// --- parseQwenUsageText -------------------------------------------------

{
  const entries = parseQwenUsageText([
    telemetry({ "event.timestamp": iso(2026, 11, 20, 9) }),
    telemetry({ model: "other/model-x", total_token_count: 0, input_token_count: 10, output_token_count: 5, thoughts_token_count: 7, auth_type: "anthropic" }),
    JSON.stringify({ type: "user", subtype: null, uuid: "p1", timestamp: iso(2026, 11, 20) }),
    "not json at all",
    telemetry({ "event.name": "qwen-code.api_error" }),
  ].join("\n"));
  assert.equal(entries.length, 2, "only api_response telemetry lines parse");
  assert.equal(entries[0].tokens, 1650, "total_token_count wins");
  assert.equal(entries[0].model, "qwen3-coder-plus");
  assert.equal(entries[1].tokens, 22, "no total: input + output + thoughts for non-openai auth");
  const openai = parseQwenUsageText(telemetry({ total_token_count: 0, input_token_count: 10, output_token_count: 5, thoughts_token_count: 7, auth_type: "openai" }));
  assert.equal(openai[0].tokens, 15, "thoughts already inside output for openai auth types");
  const cachedOnly = parseQwenUsageText(telemetry({ total_token_count: 0, input_token_count: 0, cached_content_token_count: 30, output_token_count: 0 }));
  assert.equal(cachedOnly[0].tokens, 30, "cached counts as input when input is absent");
  assert.equal(parseQwenUsageText(telemetry({ total_token_count: 0, input_token_count: 0, cached_content_token_count: 0, output_token_count: 0, thoughts_token_count: 0 })).length, 0, "zero-token replies are skipped");
  assert.deepEqual(parseQwenUsageText(""), []);
}

// --- readQwenUsage ------------------------------------------------------

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-usage-"));
  const chats = path.join(home, ".qwen", "projects", "proj-a", "chats");
  fs.mkdirSync(chats, { recursive: true });
  return { home, chats };
}

{
  const { home, chats } = makeHome();
  // 1650 tokens on Nov 20 plus a fork copy of the same uuid (deduped), 300 on
  // Nov 22, 100 on Oct 1 (outside the 30-day window).
  const lines = [
    telemetry({ "event.timestamp": iso(2026, 11, 20, 9) }, { uuid: "u-1" }),
    telemetry({ "event.timestamp": iso(2026, 11, 20, 9) }, { uuid: "u-1", forkedFrom: "parent-session" }),
    telemetry({ "event.timestamp": iso(2026, 11, 22, 15), total_token_count: 300 }, { uuid: "u-2" }),
    telemetry({ model: "vendor/path/model-y", "event.timestamp": iso(2026, 10, 1), total_token_count: 100 }, { uuid: "u-3" }),
    "{corrupt line",
  ];
  fs.writeFileSync(path.join(chats, "s1.jsonl"), lines.join("\n") + "\n");
  fs.writeFileSync(path.join(chats, "s1.ledger.jsonl"), telemetry({ total_token_count: 99999 }, { uuid: "ledger-1" }));
  fs.mkdirSync(path.join(home, ".qwen", "projects", "proj-b", "chats"), { recursive: true });
  fs.writeFileSync(path.join(home, ".qwen", "projects", "proj-b", "chats", "bad.jsonl"), "not json\n");

  const r = readQwenUsage({ home, env: {}, now: NOW });
  assert.ok(r, "store present -> result");
  assert.equal(r.days.length, 30, "30 local days");
  assert.equal(r.days[0].date, dayStr(2026, 10, 26), "window starts 29 days back");
  assert.equal(r.days[29].date, dayStr(2026, 11, 24), "window ends today");
  assert.equal(r.days.find((d) => d.date === dayStr(2026, 11, 20)).tokens, 1650, "fork copy counted once, corrupt line skipped");
  assert.equal(r.days.find((d) => d.date === dayStr(2026, 11, 22)).tokens, 300);
  assert.equal(r.days.find((d) => d.date === dayStr(2026, 10, 1)), undefined, "older than 30 days not in the window");
  assert.deepEqual(r.models, { "qwen3-coder-plus": 1950 }, "models over last 7 days only");
  assert.deepEqual(r.limits, []);
}

{
  // QWEN_RUNTIME_DIR relocates the projects folder.
  const { home } = makeHome();
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-runtime-"));
  const chats = path.join(runtime, "projects", "p", "chats");
  fs.mkdirSync(chats, { recursive: true });
  fs.writeFileSync(path.join(chats, "s.jsonl"), telemetry({ "event.timestamp": iso(2026, 11, 23), total_token_count: 42 }, { uuid: "rt-1" }));
  const r = readQwenUsage({ home, env: { QWEN_RUNTIME_DIR: runtime }, now: NOW });
  assert.equal(r.days.find((d) => d.date === dayStr(2026, 11, 23)).tokens, 42, "QWEN_RUNTIME_DIR is scanned");
}

{
  // settings.json advanced.runtimeOutputDir relocates it too.
  const { home } = makeHome();
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-runtime-"));
  fs.mkdirSync(path.join(home, ".qwen"), { recursive: true });
  fs.writeFileSync(path.join(home, ".qwen", "settings.json"), JSON.stringify({ advanced: { runtimeOutputDir: runtime } }));
  const chats = path.join(runtime, "projects", "p", "chats");
  fs.mkdirSync(chats, { recursive: true });
  fs.writeFileSync(path.join(chats, "s.jsonl"), telemetry({ "event.timestamp": iso(2026, 11, 24), total_token_count: 7 }, { uuid: "cfg-1" }));
  const r = readQwenUsage({ home, env: {}, now: NOW });
  assert.equal(r.days.find((d) => d.date === dayStr(2026, 11, 24)).tokens, 7, "settings.json runtimeOutputDir is scanned");
}

{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-empty-"));
  assert.equal(readQwenUsage({ home, env: {}, now: NOW }), null, "no .qwen -> null");
}

{
  const { home, chats } = makeHome();
  fs.writeFileSync(path.join(chats, "only-bad.jsonl"), "garbage\n{\"type\":\n");
  const r = readQwenUsage({ home, env: {}, now: NOW });
  assert.equal(r.days.reduce((s, d) => s + d.tokens, 0), 0, "corrupt-only store reads as present with zero days");
}

console.log("qwen-usage.test.mjs: ok");
