// Deeper edge-case pass for bin/installed.mjs on top of installed.test.mjs.
// The module is tiny: makeInstalledCheck() builds a predicate over PATH-like
// dirs, with a special case for mise shim dirs (a shim only counts when
// `mise which <bin>` resolves it to a real executable file), and agentCli()
// picks the first installed binary. installed.test.mjs covers the happy
// path, memoization and agentCli basics; this file covers wrong types,
// throwing collaborators, shim-dir detection edges, corrupt `mise which`
// output, the real spawnSync path (fake `mise` on a controlled PATH,
// including the 8 s timeout), memo staleness and reentrancy.
//
// Nothing here touches the real home folder or the real `mise`: every file
// lives under one mkdtemp dir and the env vars are pointed there. The
// default `which` is exercised only with an `env` whose PATH contains
// nothing but our fake binaries, so spawnSync can never find the real mise.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeInstalledCheck, agentCli } from "./installed.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "installed-deep-"));
const savedEnv = {};
for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
  savedEnv[k] = process.env[k];
  process.env[k] = path.join(tmp, k.toLowerCase());
  fs.mkdirSync(process.env[k], { recursive: true });
}

const write = (rel, content = "", mode = 0o644) => {
  const f = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  fs.chmodSync(f, mode);
  return f;
};
const dir = (rel) => { const d = path.join(tmp, rel); fs.mkdirSync(d, { recursive: true }); return d; };
const bombWhich = () => { throw new Error("which must not be called"); };

try {
  // ================================================================ real files
  // The default `executable` is fs.accessSync(X_OK) + statSync().isFile().
  const real = dir("real");
  write("real/tool", "#!/bin/sh\n", 0o755);              // executable file
  write("real/plain", "x", 0o644);                       // not executable
  write("real/empty", "", 0o755);                        // empty but +x: still a file
  const plaindir = dir("real/plaindir");                 // +x but a directory
  fs.chmodSync(plaindir, 0o755);
  fs.symlinkSync(path.join(real, "tool"), path.join(real, "link-ok"));       // statSync follows
  fs.symlinkSync(path.join(real, "gone"), path.join(real, "link-broken"));   // dangling

  // bombWhich proves `which` is never consulted for non-shim dirs.
  const realCheck = makeInstalledCheck({ dirs: [real], which: bombWhich });
  assert.equal(realCheck(["tool"]), true, "executable file on a normal dir");
  assert.equal(realCheck(["plain"]), false, "non-executable file");
  assert.equal(realCheck(["empty"]), true, "empty file with +x still counts (size is irrelevant)");
  assert.equal(realCheck(["plaindir"]), false, "a directory is never a binary, even with +x");
  assert.equal(realCheck(["link-ok"]), true, "symlink to an executable file resolves through statSync");
  assert.equal(realCheck(["link-broken"]), false, "dangling symlink: accessSync fails");
  assert.equal(realCheck(["missing"]), false);

  // Collaborator error paths: a throwing `executable` or `which` propagates;
  // nothing is swallowed.
  assert.throws(() => makeInstalledCheck({ dirs: [real], executable: () => { throw new Error("boom"); } })(["tool"]), /boom/);
  {
    const shim = dir("shims-a/mise/shims");
    write("shims-a/mise/shims/tool", "", 0o755);
    assert.throws(
      () => makeInstalledCheck({ dirs: [shim], executable: () => true, which: () => { throw new Error("which boom"); } })(["tool"]),
      /which boom/,
      "a throwing `which` propagates out of the predicate",
    );
  }
  // ... but `which` is not consulted when the shim file itself is missing.
  {
    let n = 0;
    const missing = makeInstalledCheck({ dirs: [dir("shims-b/mise/shims")], executable: () => false, which: () => { n++; return "/x"; } });
    assert.equal(missing(["tool"]), false);
    assert.equal(n, 0, "unresolvable shim file never reaches `mise which`");
  }

  // ================================================================ shim-dir detection
  // isShimDir is a regex on the dir string: must END in /mise/shims with at
  // most one trailing slash. executable: () => true isolates the detection.
  for (const [d, expectShim] of [
    ["/x/mise/shims", true],
    ["/x/mise/shims/", true],
    ["relative/mise/shims", true],        // still ends with /mise/shims
    ["/x/mise/shims//", false],           // two trailing slashes: no match
    ["/x/mise/shims/sub", false],         // not the shims dir itself
    ["/x/notmise/shims", false],          // 'mise' must be a full path segment
    ["/x/mise/shim", false],              // singular
    ["/x/MISE/shims", false],             // case-sensitive
    ["/x/mise/Shims", false],
    ["mise/shims", false],                // no slash before 'mise'
    ["/x/mise/shims/extra/../shims", false], // ends with '/../shims', not '/mise/shims'
  ]) {
    let n = 0;
    const check = makeInstalledCheck({ dirs: [d], executable: () => true, which: () => { n++; return ""; } });
    const got = check(["tool"]);
    if (expectShim) {
      assert.equal(n, 1, `${d}: treated as shim dir -> which consulted`);
      assert.equal(got, false, `${d}: which returned "" -> not installed`);
    } else {
      assert.equal(n, 0, `${d}: NOT a shim dir -> which never consulted`);
      assert.equal(got, true, `${d}: plain executable counts`);
    }
  }

  // ================================================================ wrong-type inputs
  // The predicate has no `bins || []` guard: non-arrays throw TypeError.
  const ok = makeInstalledCheck({ dirs: [real], which: bombWhich });
  for (const bad of [undefined, null, 0, "", "claude", 42, true, {}, { length: 2 }])
    assert.throws(() => ok(bad), TypeError, `bins=${JSON.stringify(bad)} -> TypeError (.some missing)`);
  assert.equal(ok([]), false, "empty bins -> false");
  // Elements: path.join throws TypeError on non-strings BEFORE executable runs.
  for (const b of [null, undefined, 0, 42, {}, [], ["x"], { toString: () => "x" }])
    assert.throws(() => ok([b]), TypeError, `bin element ${JSON.stringify(b)} -> path.join TypeError`);
  // ... unless an earlier element already matched (Array.some short-circuits).
  assert.equal(ok(["tool", null]), true, "some() stops at the first hit; junk after it is never joined");
  assert.throws(() => ok([null, "tool"]), TypeError, "junk BEFORE the hit still throws");
  // A NUL byte survives path.join but dies inside fs.accessSync, which the
  // default executable catches -> treated as not installed, no throw.
  assert.equal(ok(["a\0b"]), false, "NUL byte in bin name -> accessSync throws, caught -> false");
  assert.equal(ok([""]), false, "empty bin name joins to the dir itself -> not a file");

  // `dirs` wrong types.
  assert.equal(makeInstalledCheck({ executable: () => true })(["x"]), false, "dirs omitted -> no dirs -> false");
  assert.equal(makeInstalledCheck({ dirs: undefined, executable: () => true })(["x"]), false);
  assert.equal(makeInstalledCheck({ dirs: [], executable: () => true })(["x"]), false);
  for (const badDirs of ["abc", 5, {}, [null], [7], ["/ok", null], [undefined]])
    assert.throws(() => makeInstalledCheck({ dirs: badDirs, executable: () => false })(["x"]), TypeError,
      `dirs=${JSON.stringify(badDirs)} -> TypeError`);
  // env that is not an object only matters if a shim resolution actually
  // spawns; with no shim hit it is never touched.
  assert.equal(makeInstalledCheck({ dirs: [real], env: 42, executable: () => true, which: bombWhich })(["tool"]), true);

  // ================================================================ path traversal quirk
  // path.join does not stop ".." segments: a bin name can escape its dir.
  // bins are internal constants today, so this is pinned as a quirk, not a bug.
  {
    dir("escape/evil");
    write("escape/evil/shell", "", 0o755);
    fs.mkdirSync(path.join(tmp, "escape", "bin"), { recursive: true });
    const esc = makeInstalledCheck({ dirs: [path.join(tmp, "escape", "bin")], which: bombWhich });
    assert.equal(esc(["../evil/shell"]), true,
      "QUIRK: '../' in a bin name escapes the search dir via path.join normalization");
    assert.equal(esc([".."]), false, "'..' alone lands on a directory -> not a file");
  }

  // ================================================================ memoization deep edges
  // Memo is keyed by bin NAME only and caches forever, including negative
  // results. Mutating the world after the first call changes nothing.
  {
    const shimA = "/s1/mise/shims", shimB = "/s2/mise/shims";
    const files = new Set([`${shimA}/tool`, `${shimB}/tool`, "/real/tool"]);
    let whichResult = "/real/tool";
    let n = 0;
    const mk = () => makeInstalledCheck({
      dirs: [shimA, shimB],
      executable: (f) => files.has(f),
      which: (b) => { n++; assert.equal(b, "tool", "which receives the bare bin name"); return whichResult; },
    });
    const c = mk();
    assert.equal(c(["tool"]), true);
    assert.equal(n, 1, "shim file in the FIRST shim dir resolves once");
    // The memo is per-factory: a second factory asks again.
    const c2 = mk();
    assert.equal(c2(["tool"]), true);
    assert.equal(n, 2, "memo is per makeInstalledCheck instance, not global");
    assert.equal(c(["tool"]), true);
    assert.equal(n, 2, "repeat calls on the same factory stay memoized");
    // Stale negative: first resolution failed, the world "heals", memo wins.
    let heal = false;
    const c4 = makeInstalledCheck({
      dirs: [shimA],
      executable: (f) => files.has(f),
      which: () => (heal ? "/real/tool" : ""),
    });
    assert.equal(c4(["tool"]), false, "first resolution failed");
    heal = true;
    assert.equal(c4(["tool"]), false, "QUIRK: stale memo - a shim that becomes resolvable later stays 'not installed'");
    // Stale positive: resolved file vanishes, memo still says yes.
    const c6 = makeInstalledCheck({ dirs: [shimA], executable: (f) => files.has(f), which: () => "/real/tool" });
    assert.equal(c6(["tool"]), true);
    files.delete("/real/tool");
    assert.equal(c6(["tool"]), true, "QUIRK: stale memo - the resolved file can vanish and the shim still counts");
    files.add("/real/tool");
    // Resolution to a missing file -> false (fresh factory, fresh memo).
    const c5 = makeInstalledCheck({ dirs: [shimA], executable: (f) => files.has(f), which: () => "/gone" });
    assert.equal(c5(["tool"]), false, "resolution to a missing file -> false");
    // A different bin name has its own memo entry.
    let otherCalls = 0;
    const c7 = makeInstalledCheck({ dirs: [shimA], executable: (f) => f.startsWith(`${shimA}/`), which: () => { otherCalls++; return ""; } });
    c7(["a"]); c7(["b"]); c7(["a"]);
    assert.equal(otherCalls, 2, "memo is per bin name: a, b resolved once each");
  }

  // `which` may return anything; only !!p && executable(p) matters. A
  // relative or non-path result is passed to `executable` verbatim.
  {
    const seen = [];
    const c = makeInstalledCheck({
      dirs: ["/s/mise/shims"],
      executable: (f) => { if (f !== "/s/mise/shims/tool") seen.push(f); return f === "/s/mise/shims/tool" || f === "/abs/tool"; },
      which: () => "./rel/tool",
    });
    assert.equal(c(["tool"]), false, "relative which-result './rel/tool' is not '/abs/tool'");
    assert.ok(seen.includes("./rel/tool"), "QUIRK: the raw which output reaches `executable` unmodified");
    const cNum = makeInstalledCheck({ dirs: ["/s/mise/shims"], executable: () => true, which: () => 42 });
    assert.equal(cNum(["tool"]), true, "QUIRK: truthy non-string which-result (42) counts if executable accepts it");
    const cNull = makeInstalledCheck({ dirs: ["/s/mise/shims"], executable: () => true, which: () => null });
    assert.equal(cNull(["tool"]), false, "falsy which-result -> not installed");
  }

  // Reentrancy: `which` may call the predicate for a DIFFERENT bin; nested
  // resolution works and both results memoize.
  {
    const outer = makeInstalledCheck({
      dirs: ["/s/mise/shims"],
      executable: (f) => f.startsWith("/s/mise/shims/") || f === "/r/a" || f === "/r/b",
      which: (b) => {
        if (b === "a") { outer(["b"]); return "/r/a"; }
        return b === "b" ? "/r/b" : "";
      },
    });
    assert.equal(outer(["a"]), true);
    assert.equal(outer(["b"]), true, "nested resolution of 'b' was memoized by the inner call");
  }
  // BUG: a `which` that reenters the SAME bin recurses without bound - the
  // memo is only written AFTER resolveShim returns, so the inner call sees
  // memo.has(b) === false and calls `which` again, until the stack overflows.
  // The default spawnSync `which` can never do this (it never calls back),
  // so this only bites an injected `which`; pinned here, disabled:
  // {
  //   const c = makeInstalledCheck({ dirs: ["/s/mise/shims"], executable: () => true, which: () => { c(["tool"]); return ""; } });
  //   assert.throws(() => c(["tool"]), RangeError);
  // }

  // ================================================================ real spawnSync path
  // The default `which` runs `mise which <bin>` with the injected env. A fake
  // `mise` on a private PATH makes every outcome deterministic - the real
  // mise can never be found because env.PATH is all spawnSync searches.
  const bindir = dir("fakebin");
  const shimDirReal = dir("realshims/mise/shims");
  write("realshims/mise/shims/tool", "", 0o755);
  const envFor = (extra = {}) => ({ PATH: `${bindir}:/usr/bin:/bin`, HOME: process.env.HOME, ...extra });
  // executable/which left undefined -> module defaults (real fs + spawnSync).
  const shimCheck = (env) => makeInstalledCheck({ dirs: [shimDirReal], env });
  const writeMise = (body, mode = 0o755) => write("fakebin/mise", body, mode);

  const toolReal = write("spawn-target/tool", "", 0o755);
  writeMise(`#!/bin/sh\nprintf '%s\\n' '${toolReal}'\n`);
  assert.equal(shimCheck(envFor())(["tool"]), true, "fake mise resolves the shim to a real file");

  // env actually reaches the child: ask mise to print $MARKER.
  writeMise(`#!/bin/sh\nprintf '%s\\n' "$MARKER"\n`);
  {
    const c = makeInstalledCheck({ dirs: [shimDirReal], env: envFor({ MARKER: toolReal }) });
    assert.equal(c(["tool"]), true, "env vars are passed through to `mise which`");
  }

  // stdout parsing: the WHOLE stdout is trimmed, then only the first line is
  // used. Leading whitespace on line 1 is stripped by the trim; whitespace
  // between line 1 and the newline is interior and survives.
  writeMise(`#!/bin/sh\nprintf '  ${toolReal}\\nignored-second-line\\n'\n`);
  assert.equal(shimCheck(envFor())(["tool"]), true, "leading whitespace trimmed; only first line used");
  writeMise(`#!/bin/sh\nprintf '${toolReal}  \\nignored\\n'\n`);
  assert.equal(shimCheck(envFor())(["tool"]), false,
    "QUIRK: trim() runs before split() - trailing spaces on line 1 are kept and break the path");
  writeMise(`#!/bin/sh\nprintf '/nonexistent-first\\n${toolReal}\\n'\n`);
  assert.equal(shimCheck(envFor())(["tool"]), false,
    "QUIRK: only the FIRST stdout line is used - a valid path on line 2 is ignored");
  writeMise(`#!/bin/sh\nprintf '\\n\\n'\n`);
  assert.equal(shimCheck(envFor())(["tool"]), false, "blank stdout -> no resolution");
  writeMise(`#!/bin/sh\nprintf '\\xff\\xfe garbage\\n'\n`);
  assert.equal(shimCheck(envFor())(["tool"]), false, "non-UTF8 garbage output -> path does not exist -> false");
  writeMise(`#!/bin/sh\nexit 1\n`);
  assert.equal(shimCheck(envFor())(["tool"]), false, "mise exit!=0 discards even valid stdout");
  writeMise(`#!/bin/sh\nprintf '%s\\n' '${toolReal}'\nexit 3\n`);
  assert.equal(shimCheck(envFor())(["tool"]), false, "exit 3 with a valid path on stdout still -> false");

  // mise missing / not executable / a directory: spawn fails, status is null,
  // which returns "" - never throws.
  const emptyPath = dir("emptypath");
  assert.equal(shimCheck(envFor({ PATH: emptyPath }))(["tool"]), false,
    "mise not on PATH -> ENOENT -> not installed");
  writeMise("#!/bin/sh\nexit 0\n", 0o644);
  assert.equal(shimCheck(envFor())(["tool"]), false, "mise without +x -> EACCES -> not installed");
  fs.unlinkSync(path.join(bindir, "mise"));
  dir("fakebin/mise"); // now `mise` is a directory
  assert.equal(shimCheck(envFor())(["tool"]), false, "mise as a directory -> spawn fails -> not installed");

  // Timeout: the fixed 8000 ms timeout kills a hung `mise`; status null -> "".
  fs.rmSync(path.join(bindir, "mise"), { recursive: true, force: true });
  writeMise("#!/bin/sh\nexec sleep 30\n");
  const t0 = Date.now();
  assert.equal(shimCheck(envFor())(["tool"]), false, "hung mise is killed by the 8 s timeout");
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 7000 && elapsed < 20000, `timeout fired near 8 s (took ${elapsed} ms)`);

  // ================================================================ agentCli deep edges
  {
    const seen = [];
    const pick = agentCli(["a", "b", "c"], (bins) => { seen.push(bins[0]); return bins[0] === "b"; });
    assert.equal(pick, "b");
    assert.deepEqual(seen, ["a", "b"], "find stops at the first hit; later bins are never tested");
    // isInstalled is probed with a single-element array each time.
    const shapes = [];
    agentCli(["x", "y"], (bins) => { shapes.push(bins); return false; });
    assert.deepEqual(shapes, [["x"], ["y"]], "each probe is isInstalled([bin])");
    // Truthy non-boolean returns count.
    assert.equal(agentCli(["a"], () => 1), "a");
    assert.equal(agentCli(["a"], () => "yes"), "a");
    // Falsy ELEMENTS are swallowed by `|| ""` even when isInstalled says yes.
    assert.equal(agentCli([null], () => true), "", "QUIRK: element null -> find returns null -> ''");
    assert.equal(agentCli([0, "x"], () => true), "", "QUIRK: element 0 -> find returns 0 -> ''");
    assert.equal(agentCli([""], () => true), "", "QUIRK: element '' -> find returns '' -> ''");
    // Sparse arrays: find visits holes as undefined.
    assert.equal(agentCli([, "x"], (b) => b[0] === "x"), "x", "hole is probed as undefined, then 'x' matches");
    // Throwing isInstalled propagates.
    assert.throws(() => agentCli(["a"], () => { throw new Error("nope"); }), /nope/);
    // Falsy bins -> ""; truthy non-arrays have no .find -> TypeError.
    for (const bad of [null, undefined, 0, "", false])
      assert.equal(agentCli(bad, () => true), "", `bins=${String(bad)} -> ""`);
    for (const bad of ["ab", 5, {}, { length: 1 }, new Set(["a"])])
      assert.throws(() => agentCli(bad, () => true), TypeError, `bins=${Object.prototype.toString.call(bad)} -> TypeError`);
  }

  console.log("installed deep: all tests passed");
} finally {
  for (const k of Object.keys(savedEnv)) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
