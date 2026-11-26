// sandboxArgs({ readOnly }): folders inside the project that only the controller
// writes (her .constance/ with handoff.md) are bound read-only over the writable
// project. For real with bwrap: the worker can write the project but not
// .constance/. Paths outside the project, the project itself and missing ones are
// never bound. Fake home under the system temp folder, never the real one.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sandboxArgs, bwrapWorks } from "./constance-sandbox.mjs";

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "constance-sbro-")));
try {
  const home = path.join(base, "home"), proj = path.join(base, "proj"), tmp = path.join(base, "tmp"), outside = path.join(base, "outside");
  for (const d of [home, proj, tmp, outside, path.join(proj, ".constance")]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(proj, ".constance", "handoff.md"), "controller\n");
  const env = { ...process.env, HOME: home };
  const ro = (a) => a.flatMap((x, i) => (x === "--ro-bind" ? [a[i + 1]] : []));
  const cdir = path.join(proj, ".constance");
  const a = sandboxArgs({ agent: "grok", dir: proj, tmp, env, readOnly: [cdir, outside, proj, path.join(proj, "missing"), "", null] });
  assert.ok(ro(a).includes(cdir), "the project's .constance/ is read-only");
  assert.ok(!ro(a).includes(outside), "a folder outside the project is never bound");
  assert.ok(!ro(a).includes(proj), "the project itself stays writable");
  assert.ok(!ro(a).some((p) => p.endsWith("/missing")), "a missing path is skipped");
  assert.ok(a.lastIndexOf(cdir) > a.indexOf(proj), "the read-only bind comes after the project bind");
  assert.ok(!ro(sandboxArgs({ agent: "grok", dir: proj, tmp, env })).includes(cdir), "nothing extra without readOnly");

  if (bwrapWorks()) {
    const r = spawnSync("bwrap", [...a, "--", "sh", "-c", `echo w > ${proj}/ok.txt && echo yes || echo no; echo x >> ${cdir}/handoff.md 2>/dev/null && echo yes || echo no; touch ${cdir}/new 2>/dev/null && echo yes || echo no`], { encoding: "utf8" });
    assert.deepEqual(r.stdout.trim().split("\n"), ["yes", "no", "no"], "project writable, .constance read-only: " + r.stdout + r.stderr);
    assert.equal(fs.readFileSync(path.join(cdir, "handoff.md"), "utf8"), "controller\n", "the handoff file is untouched");
  } else {
    console.log("constance-sandbox-readonly: bwrap unavailable, live check skipped");
  }
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
console.log("constance-sandbox-readonly: tests passed");
