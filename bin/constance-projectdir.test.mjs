// A worker never launches without a real project folder.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectDirProblem, assertProjectDir } from "./constance-projectdir.mjs";
import { sandboxArgs } from "./constance-sandbox.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "projdir-"));
const home = path.join(root, "home");
const proj = path.join(home, "Projects", "app");
fs.mkdirSync(proj, { recursive: true });
const file = path.join(proj, "README");
fs.writeFileSync(file, "x");
const env = { HOME: home };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "projdir-tmp-"));

try {
  assert.equal(projectDirProblem(proj, env), "");
  assert.doesNotThrow(() => assertProjectDir(proj, env));

  const bad = [
    [undefined, /no project folder/],
    [null, /no project folder/],
    [42, /no project folder/],
    ["", /no project folder/],
    ["   ", /no project folder/],
    ["Projects/app", /not an absolute path/],
    [path.join(home, "Projects", "missing"), /does not exist/],
    [file, /not a folder/],
    ["/", /can't be \//],
    [home, /home folder/],
    [path.dirname(home), /home folder/],
  ];
  for (const [dir, re] of bad) {
    assert.match(projectDirProblem(dir, env), re, `projectDirProblem(${JSON.stringify(dir)})`);
    assert.throws(() => assertProjectDir(dir, env), /refusing to launch a worker/);
    // The sandbox (the path every worker launch goes through) refuses too,
    // before building any bwrap arguments.
    assert.throws(() => sandboxArgs({ agent: "grok", dir, tmp, env }), /refusing to launch a worker/,
      `sandboxArgs must refuse ${JSON.stringify(dir)}`);
  }
  // A symlink to the home folder is the home folder.
  const link = path.join(root, "link-home");
  fs.symlinkSync(home, link);
  assert.match(projectDirProblem(link, env), /home folder/);
  // A symlink to a real project is fine.
  const plink = path.join(root, "link-proj");
  fs.symlinkSync(proj, plink);
  assert.equal(projectDirProblem(plink, env), "");
  assert.ok(sandboxArgs({ agent: "grok", dir: proj, tmp, env }).includes(fs.realpathSync(proj)));
  console.log("constance-projectdir: ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}
