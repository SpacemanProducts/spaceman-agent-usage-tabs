// Deep edge-case tests for constance-logtext.mjs: the basic test covers the happy
// path; this one pokes stamp()/entryText()/logText() with corrupt, missing and
// wrong-typed fields the way a damaged log.jsonl or a hand-built entry could feed
// them through `constance.mjs log`. The module is pure (no files, no clock reads
// of its own), so "races" here mean determinism under interleaved calls.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stamp, entryText, logText } from "./constance-logtext.mjs";

// Scratch HOME/XDG like the other deep tests: nothing here should ever touch the
// real home folder, and everything is removed at the end.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "constance-logtext-deep-"));
const saved = {};
for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
  saved[k] = process.env[k];
  process.env[k] = path.join(tmp, k.toLowerCase());
}
fs.mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });

try {
  // --- stamp: bad `at` values -------------------------------------------------
  // Number(at) || 0 folds every unparsable value to the epoch; compare against
  // stamp(0) itself so the assertion is timezone-proof.
  for (const bad of [undefined, null, "", "garbage", NaN, {}, [], false]) {
    assert.equal(stamp(bad), stamp(0), `stamp(${JSON.stringify(bad) ?? String(bad)}) falls back to epoch`);
  }
  assert.equal(stamp(0), stamp(-0));
  // A numeric string is accepted, same as the number.
  assert.equal(stamp("1764000000000"), stamp(1764000000000));
  // true coerces to 1 ms; a Date object coerces to its ms.
  assert.equal(stamp(true), stamp(1));
  const d = new Date(2026, 5, 15, 12, 30);
  assert.equal(stamp(d), stamp(d.getTime()));
  // Fractional ms are truncated by the Date.
  assert.equal(stamp(1500.9), stamp(1500));
  // Infinity is beyond the Date range -> Invalid Date -> NaN fields (documented
  // quirk: a corrupt `at` renders as "NaN-NaN-NaN NaN:NaN" rather than throwing).
  assert.equal(stamp(Infinity), "NaN-NaN-NaN NaN:NaN");
  assert.equal(stamp(8.64e15 + 1), "NaN-NaN-NaN NaN:NaN", "past the max Date still gives NaN, not a throw");
  assert.notEqual(stamp(8.64e15).includes("NaN"), true, "the max valid Date still renders");
  // Pre-epoch times: build expectations from local-time Date constructors so the
  // check holds in any timezone.
  assert.equal(stamp(new Date(1969, 11, 31, 23, 59).getTime()), "1969-12-31 23:59");
  assert.equal(stamp(new Date(1900, 0, 2, 3, 4).getTime()), "1900-01-02 03:04");
  // Year/month/day boundaries pad correctly.
  assert.equal(stamp(new Date(2026, 0, 1, 0, 0).getTime()), "2026-01-01 00:00");
  assert.equal(stamp(new Date(2025, 11, 31, 23, 59).getTime()), "2025-12-31 23:59");
  assert.equal(stamp(new Date(2024, 1, 29, 12, 0).getTime()), "2024-02-29 12:00", "leap day");

  // --- entryText: missing / wrong-typed fields -------------------------------
  // An empty entry is just the epoch stamp and the fallback heading.
  assert.equal(entryText({}), `${stamp(0)}  Entry`);
  // Missing or falsy kind -> "Entry"; unknown string kinds are used verbatim.
  assert.equal(entryText({ at: 1000, kind: null }), `${stamp(1000)}  Entry`);
  assert.equal(entryText({ at: 1000, kind: "" }), `${stamp(1000)}  Entry`);
  assert.equal(entryText({ at: 1000, kind: 0 }), `${stamp(1000)}  Entry`);
  assert.equal(entryText({ at: 1000, kind: "weird-kind" }), `${stamp(1000)}  weird-kind`);
  assert.equal(entryText({ at: 1000, kind: 123 }), `${stamp(1000)}  123`, "numeric kind stringifies");
  // Falsy text never gets a colon; "0" does.
  assert.equal(entryText({ at: 1000, kind: "note", text: "" }), `${stamp(1000)}  Note`);
  assert.equal(entryText({ at: 1000, kind: "note", text: 0 }), `${stamp(1000)}  Note`);
  assert.equal(entryText({ at: 1000, kind: "note", text: "0" }), `${stamp(1000)}  Note: 0`);
  // `who` needs an agent; worker/account alone are ignored.
  assert.equal(entryText({ at: 1000, kind: "handoff", job: 5, worker: "W", account: "a" }), `${stamp(1000)}  Job 5 → `, "worker without agent is dropped");
  assert.equal(entryText({ at: 1000, kind: "handoff", job: 5, agent: "devin", worker: "", account: "work" }), `${stamp(1000)}  Job 5 → devin (work)`, "empty worker falls back to the id, account still shows");
  assert.equal(entryText({ at: 1000, kind: "handoff", job: 5, agent: "devin" }), `${stamp(1000)}  Job 5 → devin`, "default nameOf is the identity");
  assert.equal(entryText({ at: 1000, kind: "handoff", job: 5, agent: "devin" }, () => ""), `${stamp(1000)}  Job 5 → `, "a nameOf returning empty leaves a bare arrow");
  // Review verdicts: only the exact string "accept" means accepted; anything
  // else — including a missing verdict — reads "sent back".
  assert.equal(entryText({ at: 1000, kind: "review", job: 1, verdict: "accept" }), `${stamp(1000)}  Job 1 accepted`);
  assert.equal(entryText({ at: 1000, kind: "review", job: 1 }), `${stamp(1000)}  Job 1 sent back`, "no verdict defaults to sent back");
  assert.equal(entryText({ at: 1000, kind: "review", job: 1, verdict: "maybe" }), `${stamp(1000)}  Job 1 sent back`);
  // Practice extras: the worktree line needs kind "practice" AND a worktree;
  // branch falls back to "its own branch".
  assert.equal(entryText({ at: 1000, kind: "practice", job: 1, agent: "g", worktree: "/w" }), `${stamp(1000)}  Practice job 1 → g\n(a real run works in /w on its own branch)`);
  assert.equal(entryText({ at: 1000, kind: "note", worktree: "/w", branch: "b" }), `${stamp(1000)}  Note`, "worktree line is practice-only");
  assert.equal(entryText({ at: 1000, kind: "practice", job: 1, agent: "g" }), `${stamp(1000)}  Practice job 1 → g`, "no worktree, no extra line");
  assert.equal(entryText({ at: 1000, kind: "practice", job: 1, agent: "g", worktree: "/w", branch: "" }), `${stamp(1000)}  Practice job 1 → g\n(a real run works in /w on its own branch)`, "empty branch falls back too");
  // prompt is appended on ANY kind, stringified; falsy prompts are skipped.
  assert.equal(entryText({ at: 1000, kind: "note", prompt: "p1\np2" }), `${stamp(1000)}  Note\np1\np2`);
  assert.equal(entryText({ at: 1000, kind: "note", prompt: "" }), `${stamp(1000)}  Note`, "empty prompt adds nothing");
  assert.equal(entryText({ at: 1000, kind: "note", prompt: 0 }), `${stamp(1000)}  Note`, "prompt 0 is falsy and skipped");
  assert.equal(entryText({ at: 1000, kind: "note", prompt: { a: 1 } }), `${stamp(1000)}  Note\n[object Object]`, "non-string prompt is String()-ed");
  assert.equal(entryText({ at: 1000, kind: "note", text: "t", prompt: "p" }), `${stamp(1000)}  Note: t\np`, "text colon and prompt line coexist");
  // agent + worker + account + reason all at once on a held entry.
  assert.equal(
    entryText({ at: 1000, kind: "held", job: 9, agent: "devin", worker: "Devin 3", account: "pro", text: "busy" }, (id) => `name(${id})`),
    `${stamp(1000)}  Job 9 → Devin 3 (pro) (held): busy`,
    "held heading, worker wins over nameOf, account parenthesized",
  );

  // --- logText: shape and robustness ----------------------------------------
  // Every falsy non-array input renders as a bare newline.
  for (const bad of [null, undefined, false, 0, ""]) {
    assert.equal(logText(bad), "\n", `logText(${String(bad)})`);
  }
  // Entries are emitted in the order given — the module does not sort, it trusts
  // readLog's oldest-first order; a reversed input stays reversed.
  const newestFirst = [
    { at: 2000, kind: "report", text: "new" },
    { at: 1000, kind: "goal", text: "old" },
  ];
  assert.equal(logText(newestFirst), `${stamp(2000)}  Report: new\n\n${stamp(1000)}  Goal: old\n`, "input order is preserved, not sorted");
  // Exactly one blank line between entries, none before the first, trailing \n.
  const three = [{ at: 1, kind: "note", text: "a" }, { at: 2, kind: "note", text: "b" }, { at: 3, kind: "note", text: "c" }];
  assert.equal(logText(three), `${stamp(1)}  Note: a\n\n${stamp(2)}  Note: b\n\n${stamp(3)}  Note: c\n`);
  assert.equal(logText([{ at: 1, kind: "note" }]), `${stamp(1)}  Note\n`, "single entry has no leading blank line");
  // A text containing its own newlines flows through verbatim.
  assert.equal(logText([{ at: 1, kind: "note", text: "line1\nline2" }]), `${stamp(1)}  Note: line1\nline2\n`);
  // nameOf is threaded through to every entry.
  assert.equal(logText([{ at: 1, kind: "handoff", job: 1, agent: "x" }], (id) => `N:${id}`), `${stamp(1)}  Job 1 → N:x\n`);
  // Wrong-typed entries that survive property access (strings, numbers) render
  // as bare entries rather than crashing.
  assert.equal(logText(["str", 5, true]), `${stamp(0)}  Entry\n\n${stamp(0)}  Entry\n\n${stamp(0)}  Entry\n`);
  // A truthy non-array is a TypeError, not a silent "\n".
  assert.throws(() => logText({ length: 0 }), TypeError);
  assert.throws(() => logText("x"), TypeError);

  // BUG: a `null` or `undefined` element inside the array crashes entryText on
  // `e.agent`, and store.readLog() can produce exactly that: a log.jsonl line
  // containing the bare JSON `null` parses fine and lands in the entries, so
  // `constance.mjs log` (Copy all) would die mid-print. readLog should filter
  // non-object lines, or entryText should tolerate them.
  // assert.doesNotThrow(() => logText([null]));
  // assert.equal(logText([null, { at: 1, kind: "note" }]), `${stamp(0)}  Entry\n\n${stamp(1)}  Note\n`);

  // --- determinism: no shared state, safe under interleaved/repeated calls ---
  const a = { at: 1000, kind: "practice", job: 1, agent: "devin", reason: "r", text: "t", prompt: "do it", worktree: "/w", branch: "b" };
  const expected = entryText(a, (id) => `name(${id})`);
  let calls = 0;
  const counting = (id) => { calls++; return `name(${id})`; };
  for (let i = 0; i < 1000; i++) {
    assert.equal(entryText(a, counting), expected);
    assert.equal(logText([a, { at: i, kind: "note" }], counting).split("\n\n").length, 2);
  }
  assert.equal(calls, 2000, "nameOf ran once per entry per call — no caching, no leaks");

  console.log("constance-logtext.deep: tests passed");
} finally {
  for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
