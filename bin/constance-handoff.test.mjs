// constance-handoff.mjs: the handoff file's memory, rendering, size cap, where it
// lives, and the controller-only write (a changed file is noticed and rewritten).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  memoryOf, addDecision, addProblem, solveProblem, addNext, currentNext, beginStep, endStep, openStep,
  renderHandoff, handoffFile, writeHandoff, insidePlugins, textSha, MAX_LINES,
} from "./constance-handoff.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "constance-handoff-"));
try {
  // ---- memory: decisions, problems (numbered, solvable once), notes per step, steps
  const goal = { id: "g1", text: "1. parse the config\n2. write tests\n3. update docs", dir: "/x", status: "running", startedAt: Date.UTC(2026, 10, 26, 9) };
  const mem = memoryOf(goal);
  assert.deepEqual(mem, { decisions: [], problems: [], next: [], steps: [], sha: "" }, "an empty goal has an empty memory");
  assert.deepEqual(memoryOf({ handoff: { decisions: "junk", steps: [null, 3, { n: 1 }] } }).steps, [{ n: 1 }], "junk entries are dropped");
  assert.equal(beginStep(mem, { kind: "plan", session: "s1", mark: "0/0/0/0" }), 1);
  assert.ok(openStep(mem), "a begun step is open");
  addDecision(mem, "Use the stdlib parser: no new dependency");
  assert.equal(addProblem(mem, "the docs build is flaky"), 1);
  assert.equal(addProblem(mem, "item 2 needs a fixture"), 2);
  addNext(mem, "review job 4 first");
  assert.throws(() => addDecision(mem, "   "), /Usage/);
  endStep(mem, { outcome: "ok", outChars: 10 });
  assert.equal(openStep(mem), null, "an ended step is closed");
  assert.equal(mem.decisions[0].step, 1, "entries are filed under their step");
  solveProblem(mem, 1, "pinned the theme");
  assert.throws(() => solveProblem(mem, 1), /already solved/);
  assert.throws(() => solveProblem(mem, 9), /No open problem 9/);
  // A new step's notes replace the last step's notes; until it writes any, the old ones stay.
  beginStep(mem, { kind: "review", session: "s2", jobs: [4] });
  assert.deepEqual(currentNext(mem).map((e) => e.text), ["review job 4 first"]);
  addNext(mem, "item 3 is next");
  assert.deepEqual(currentNext(mem).map((e) => e.text), ["item 3 is next"], "the latest step's notes win");

  // ---- rendering: every section, done items collapsed, open jobs listed, closed jobs one line
  goal.handoff = mem;
  const jobs = [
    { id: 1, goal: "g1", agent: "devin", worker: "Devin 1", status: "accepted", items: [1], files: ["cfg.js"], title: "parsing the config" },
    { id: 2, goal: "g1", agent: "grok", status: "sent back", items: [2], files: ["t.js"] },
    { id: 3, goal: "g1", agent: "grok", status: "running", items: [2], files: ["t.js"], title: "writing tests" },
    { id: 4, goal: "g1", agent: "devin", worker: "Devin 2", status: "finished", items: [3], task: "update the docs" },
    { id: 9, goal: "other", agent: "grok", status: "running" },
  ];
  const items = [
    { n: 1, text: "parse the config", state: "done", jobs: [1] },
    { n: 2, text: "write tests", state: "working", jobs: [2, 3] },
    { n: 3, text: "update docs", state: "review", jobs: [4] },
  ];
  const md = renderHandoff({ goal, jobs, items, name: (id) => id.toUpperCase(), liveStep: 2 });
  for (const h of ["# Handoff: 1. parse the config", "## Goal", "## Checklist", "## Job board", "## Decisions made", "## Open problems", "## Notes for the next session"]) assert.ok(md.includes(h), `has ${h}`);
  assert.match(md, /- \[x\] Done 1 of 3: 1 parse the config/, "done items collapse into one summary line");
  assert.match(md, /- \[ \] 2\. write tests — working \(jobs 2, 3\)/);
  assert.match(md, /- \[ \] 3\. update docs — waiting for review \(job 4\)/);
  assert.match(md, /- Closed: 1 accepted \(1\), 1 sent back \(2\)/, "reviewed jobs collapse into one line");
  assert.match(md, /- #3 GROK item 2 · running · writing tests · files t\.js/);
  assert.match(md, /- #4 Devin 2 item 3 · finished · update the docs · read-only/);
  assert.ok(!md.includes("#9"), "another goal's job is not on this board");
  assert.match(md, /- Use the stdlib parser/);
  assert.match(md, /- P2: item 2 needs a fixture/); assert.ok(!md.includes("P1:"), "a solved problem leaves the list");
  assert.match(md, /\(1 solved\)/);
  assert.match(md, /- item 3 is next/); assert.ok(!md.includes("review job 4 first"));
  assert.match(md, /Step 2 \(review\) is running now/, "the live step is not called interrupted");
  assert.match(md, /never edit this file/);
  // A numbered goal's items are shown once, in the checklist, not again under Goal.
  assert.match(md, /## Goal\n\(the checklist below is the whole goal\)\n/);
  {
    const g1 = { id: "g3", status: "running", startedAt: 0, text: "Tidy the repo before the release.\n1. drop dead code\n2. fix lint" };
    const it = [{ n: 1, text: "drop dead code", state: "todo", jobs: [] }, { n: 2, text: "fix lint", state: "todo", jobs: [] }];
    const t = renderHandoff({ goal: g1, items: it });
    assert.match(t, /## Goal\nTidy the repo before the release\.\n\n/, "the preamble stays");
    assert.equal(t.split("drop dead code").length - 1, 1, "an item appears once");
    const one = renderHandoff({ goal: { id: "g4", status: "running", startedAt: 0, text: "fix the flaky test" }, items: [{ n: 1, text: "fix the flaky test", state: "todo", jobs: [] }] });
    assert.match(one, /## Goal\nfix the flaky test\n/); assert.match(one, /- \[ \] 1\. \(the goal above\) — todo/);
  }
  assert.equal(renderHandoff({ goal, jobs, items, liveStep: 2 }), renderHandoff({ goal, jobs, items, liveStep: 2 }), "rendering is deterministic");
  // The same open step with no live session was cut off, and the next session is told so.
  assert.match(renderHandoff({ goal, jobs, items }), /The step-2 session \(review\) did not finish: it was interrupted/);
  endStep(mem, { outcome: "her limit wall" });
  assert.match(renderHandoff({ goal, jobs, items }), /The step-2 session \(review\) ended: her limit wall/);
  assert.match(renderHandoff({ goal: { ...goal, status: "running" }, jobs, items, practice: true }), /PRACTICE \(dry run\)/);
  assert.equal(renderHandoff({ goal: null }), "");

  // ---- size: a huge goal stays under MAX_LINES, with the overflow named, not dropped silently
  const big = { id: "g2", status: "running", startedAt: Date.now(), text: Array.from({ length: 80 }, (_, i) => `${i + 1}. item number ${i + 1} ` + "x".repeat(400)).join("\n"), handoff: { decisions: [], problems: [], next: [], steps: [] } };
  const bm = memoryOf(big);
  for (let i = 0; i < 40; i++) { addDecision(bm, `decision ${i}`); addProblem(bm, `problem ${i}`); addNext(bm, `note ${i}`); }
  big.handoff = bm;
  const bigItems = Array.from({ length: 80 }, (_, i) => ({ n: i + 1, text: `item number ${i + 1}`, state: i < 30 ? "done" : "todo", jobs: [] }));
  const bigJobs = Array.from({ length: 70 }, (_, i) => ({ id: i + 1, goal: "g2", agent: "devin", status: i < 40 ? "accepted" : "running", files: ["f" + i] }));
  const bmd = renderHandoff({ goal: big, jobs: bigJobs, items: bigItems });
  const lines = bmd.trimEnd().split("\n");
  assert.ok(lines.length <= MAX_LINES, `stays under ${MAX_LINES} lines: ${lines.length}`);
  assert.ok(lines.length <= 130, `the caps alone keep it well under: ${lines.length}`);
  assert.ok(lines.every((l) => l.length <= 400), "no line runs on");
  assert.match(bmd, /- \[x\] Done 30 of 80:/, "thirty done items are one line");
  assert.equal(lines.filter((l) => l.startsWith("- [x]")).length, 1);
  assert.match(bmd, /… \d+ more open items/); assert.match(bmd, /… 28 earlier decisions/); assert.match(bmd, /… 30 older open problems/);
  assert.match(bmd, /… \d+ more open jobs/);
  assert.match(bmd, /- Closed: 40 accepted/);
  assert.match(bmd, /- decision 39/, "the newest decision is kept");

  // ---- where it lives: the project's .constance/, except inside the plugins folder
  const home = path.join(root, "home"), plugins = path.join(home, ".config", "omarchy", "plugins");
  const env = { HOME: home };
  assert.equal(insidePlugins(path.join(plugins, "me.thing"), env), true);
  assert.equal(insidePlugins(path.join(home, "Projects", "app"), env), false);
  assert.deepEqual(handoffFile(path.join(home, "Projects", "app"), "/state", env), { file: path.join(home, "Projects", "app", ".constance", "handoff.md"), inProject: true });
  const pf = handoffFile(path.join(plugins, "me.thing"), "/state", env);
  assert.equal(pf.inProject, false); assert.match(pf.file, /^\/state\/handoff\/me\.thing-[0-9a-f]{8}\.md$/, "a plugin project's file goes to her state dir: " + pf.file);
  assert.notEqual(handoffFile(path.join(plugins, "a", "me.thing"), "/state", env).file, pf.file, "two same-named folders don't share a file");

  // ---- the controller-only write: atomic, and a file changed behind its back is noticed
  const f = path.join(root, "proj", ".constance", "handoff.md");
  const w1 = writeHandoff(f, "one\n");
  assert.equal(fs.readFileSync(f, "utf8"), "one\n"); assert.equal(w1.sha, textSha("one\n")); assert.equal(w1.tampered, false);
  assert.equal(writeHandoff(f, "two\n", w1.sha).tampered, false, "its own last write is not tampering");
  fs.writeFileSync(f, "a worker wrote this\n");
  const w3 = writeHandoff(f, "three\n", textSha("two\n"));
  assert.equal(w3.tampered, true, "an outside edit is noticed");
  assert.equal(fs.readFileSync(f, "utf8"), "three\n", "and replaced by the true file");
  fs.rmSync(f);
  assert.equal(writeHandoff(f, "four\n", w3.sha).tampered, false, "a deleted file is just written again");
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ["handoff.md"], "no temp files left behind");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("constance-handoff: tests passed");
