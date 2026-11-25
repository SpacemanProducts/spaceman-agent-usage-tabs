// Deep edge-case pass for bin/amp-usage.mjs on top of amp-usage.test.mjs.
// parseAmpUsage is pure; readAmpUsage spawns `amp usage --details`. Real `amp`
// IS installed on this machine, so every readAmpUsage call gets an env whose
// PATH leads with a fake bin dir inside the mkdtemp scratch — the real binary
// and the real HOME are never reached. Nothing here touches the network.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseAmpUsage, readAmpUsage } from "./amp-usage.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amp-usage-deep-"));
const savedEnv = {};
for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
  savedEnv[k] = process.env[k];
  process.env[k] = path.join(tmp, k.toLowerCase());
  fs.mkdirSync(process.env[k], { recursive: true });
}

// Fake `amp` executables. Each lives in its own bin dir; PATH is
// "<dir>:<real PATH>" so coreutils work but our amp shadows the real one.
const bindir = (name, body) => {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, "amp");
  fs.writeFileSync(f, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(f, 0o755);
  return { ...process.env, PATH: `${d}:${process.env.PATH}` };
};

const BIN = {
  // Refuses to run unless invoked as `amp usage --details`, then reports 42
  // tokens over a 7-day range.
  ok: bindir("bin-ok", `[ "$*" = "usage --details" ] || exit 3
printf 'Total tokens: 42\\nRange: 2026-11-01T00:00:00Z to 2026-11-08T00:00:00Z\\n'`),
  // Prints a valid-looking report but exits 1: the exit status must win.
  nonzero: bindir("bin-nonzero", `printf 'Total tokens: 42\\n'
echo 'boom' >&2
exit 1`),
  // Signed-out style output: exit 0, no token line.
  garbage: bindir("bin-garbage", `echo 'not signed in'
exit 0`),
  // The token line only on stderr: stdout is all that is parsed.
  stderrOnly: bindir("bin-stderr", `echo 'Total tokens: 42' >&2
exit 0`),
  // Prints tokens only when AMP_DEEP_OK=1 is in the env it was spawned with.
  gated: bindir("bin-gated", `[ "$AMP_DEEP_OK" = "1" ] || exit 1
printf 'Total tokens: 7\\n'`),
  // Sleeps 1 s, then reports 9 tokens.
  slow: bindir("bin-slow", `sleep 1
printf 'Total tokens: 9\\n'`),
  // Writes ~5 MB, over the module's 4 MB maxBuffer.
  big: bindir("bin-big", `head -c 5000000 /dev/zero | tr '\\0' 'x'
printf '\\nTotal tokens: 5\\n'`),
};
// PATH with no amp anywhere (system dirs only; the real amp lives under mise).
const NO_AMP = { ...process.env, PATH: "/usr/bin:/bin" };

try {
  // ---- parseAmpUsage: falsy and non-string inputs ----
  for (const bad of [undefined, null, "", 0, false, NaN]) {
    assert.deepEqual(parseAmpUsage(bad), { tokens: null, status: "" }, `falsy ${String(bad)} is no data`);
  }
  assert.deepEqual(parseAmpUsage(42), { tokens: null, status: "" }, "a bare number has no token line");
  assert.deepEqual(parseAmpUsage({}), { tokens: null, status: "" }, "a plain object stringifies to [object Object]");
  assert.deepEqual(parseAmpUsage(true), { tokens: null, status: "" });
  // String() coerces truthy non-strings, so these DO parse.
  assert.equal(parseAmpUsage(["Total tokens: 7"]).tokens, 7, "a one-element array stringifies to its element");
  assert.equal(parseAmpUsage(Buffer.from("Total tokens: 8")).tokens, 8, "a Buffer stringifies to its text");
  assert.equal(parseAmpUsage({ toString: () => "Total tokens: 9" }).tokens, 9);
  assert.deepEqual(parseAmpUsage(Symbol("x")), { tokens: null, status: "" }, "String(symbol) does not throw");
  assert.throws(() => parseAmpUsage({ toString() { throw new Error("nope"); } }), /nope/,
    "a throwing toString propagates out of parseAmpUsage");

  // ---- parseAmpUsage: the token line's shape ----
  assert.deepEqual(parseAmpUsage("Total tokens:"), { tokens: null, status: "" }, "label with nothing after it");
  assert.deepEqual(parseAmpUsage("Total tokens:    \n"), { tokens: null, status: "" }, "label with only whitespace");
  assert.deepEqual(parseAmpUsage("Total tokens: -5"), { tokens: null, status: "" }, "a negative sign is not in [\\d,]");
  // A "Total tokens:" line holding only commas reports no digits, so it is
  // no data — never a fabricated "0 tokens" (Number("") === 0).
  assert.deepEqual(parseAmpUsage("Total tokens: ,,,"), { tokens: null, status: "" });
  assert.deepEqual(parseAmpUsage("Total tokens: ,"), { tokens: null, status: "" });
  assert.deepEqual(parseAmpUsage("Total  tokens: 5"), { tokens: null, status: "" },
    "two spaces between the words do not match the literal 'Total tokens:'");
  assert.equal(parseAmpUsage("NotTotal tokens: 5").tokens, 5, "the match is not anchored to a word boundary");
  assert.equal(parseAmpUsage("TOTAL TOKENS: 6").tokens, 6, "the label match is case-insensitive");
  assert.equal(parseAmpUsage("Total tokens:1,000").tokens, 1000, "no space after the colon still matches");
  assert.equal(parseAmpUsage("Total tokens: 5\r\nRange: 2026-11-01T00:00:00Z to 2026-11-08T00:00:00Z\r\n").tokens, 5,
    "CRLF line endings parse fine");
  assert.equal(parseAmpUsage("Total tokens: 1,2,3").tokens, 123, "every comma is stripped, not just thousands groups");
  // Space-separated "thousands" are not understood: the match stops at the
  // first space, so this reports 1 — a wrong number for malformed input the
  // real CLI never prints. Documented, not asserted as correct.
  assert.equal(parseAmpUsage("Total tokens: 1 000 000").tokens, 1);
  assert.equal(parseAmpUsage("Total tokens: 5\nTotal tokens: 10").tokens, 5, "the first token line wins");

  // ---- parseAmpUsage: numeric extremes ----
  const huge = parseAmpUsage(`Total tokens: ${"9".repeat(400)}`);
  assert.deepEqual(huge, { tokens: null, status: "" }, "a number too big for float64 (Infinity) is treated as no data");
  const big = parseAmpUsage(`Total tokens: ${"9".repeat(22)}`);
  assert.equal(big.tokens, 1e22, "the largest finite parse still counts");
  assert.ok(big.status.includes("M"), "the formatter still runs on huge finite values");
  assert.equal(parseAmpUsage("Total tokens: 0").status, "Last 7 days: 0 tokens (from `amp usage`).",
    "a real reported 0 is shown honestly");

  // ---- parseAmpUsage: the Range line only labels the window ----
  const withTokens = (range) => parseAmpUsage(`Total tokens: 9\n${range}`);
  assert.equal(withTokens("Range: foo to bar").status, "Last 7 days: 9 tokens (from `amp usage`).",
    "unparseable dates fall back to the '7 days' label, tokens kept");
  assert.equal(withTokens("Range: 2026-11-10T00:00:00Z to 2026-11-01T00:00:00Z").status,
    "Last 7 days: 9 tokens (from `amp usage`).", "a reversed range (negative days) falls back to '7 days'");
  assert.equal(withTokens("Range: 2026-11-01T00:00:00Z to 2026-11-01T00:00:00Z").status,
    "Last 7 days: 9 tokens (from `amp usage`).", "a zero-length range falls back to '7 days'");
  assert.equal(withTokens("Range: 2026-11-01T00:00:00Z to 2026-11-01T00:01:00Z").status,
    "Last 7 days: 9 tokens (from `amp usage`).", "a one-minute range rounds to 0 days -> '7 days'");
  assert.equal(withTokens("Range: 2026-11-01T00:00:00Z to 2026-11-01T12:00:00Z").status,
    "Last 1 days: 9 tokens (from `amp usage`).", "12h rounds to 1 day (Math.round(0.5)=1); '1 days' grammar quirk");
  assert.equal(withTokens("Range: 2026-11-01T00:00:00Z to 2026-11-02T00:00:00Z").status,
    "Last 1 days: 9 tokens (from `amp usage`).");
  assert.equal(withTokens("Range: 2026-11-01T00:00:00Z to 2026-11-15T12:00:00Z").status,
    "Last 15 days: 9 tokens (from `amp usage`).", "14.5 days rounds half up to 15");
  assert.equal(withTokens("range: 2026-11-01 to 2026-11-08").status,
    "Last 7 days: 9 tokens (from `amp usage`).", "lowercase label and date-only values work");
  assert.equal(withTokens("Range: 2026-11-01T00:00:00+02:00 to 2026-11-08T00:00:00+02:00").status,
    "Last 7 days: 9 tokens (from `amp usage`).", "ISO timezone offsets parse");
  assert.equal(withTokens("Range: 2026-01-01T00:00:00Z to 2027-02-05T00:00:00Z").status,
    "Last 400 days: 9 tokens (from `amp usage`).", "large day counts are shown as-is");
  assert.equal(withTokens("Range: 2026-11-01T00:00:00Z").status,
    "Last 7 days: 9 tokens (from `amp usage`).", "a Range line without 'to' does not match");
  // Range may appear before the token line; both regexes scan the whole text.
  assert.equal(parseAmpUsage("Range: 2026-11-01T00:00:00Z to 2026-11-08T00:00:00Z\nTotal tokens: 3").tokens, 3);

  // ---- parseAmpUsage: status formatting boundaries ----
  const status = (n) => parseAmpUsage(`Total tokens: ${n}`).status;
  assert.equal(status("999"), "Last 7 days: 999 tokens (from `amp usage`).");
  assert.equal(status("1,000"), "Last 7 days: 1.0K tokens (from `amp usage`).", "exactly 1K uses K");
  assert.equal(status("999,999"), "Last 7 days: 1000.0K tokens (from `amp usage`).",
    "999,999 rounds to '1000.0K' — it never reaches the M branch below 1e6");
  assert.equal(status("1,000,000"), "Last 7 days: 1.0M tokens (from `amp usage`).");
  const money = parseAmpUsage("Total tokens: 5\nTotal recorded cost: $99.00\n**Credits:** $1.00");
  assert.ok(!/[$\d]{2,}\.\d\d|credit/i.test(money.status.replace(/7 days|5 tokens|amp usage/g, "")),
    "no money or extra figures leak into the status");

  // ---- readAmpUsage: spawn outcomes via fake `amp` ----
  assert.deepEqual(readAmpUsage({ env: BIN.ok }),
    { tokens: 42, status: "Last 7 days: 42 tokens (from `amp usage`)." },
    "a good report parses; the fake also proves argv is exactly 'usage --details'");
  assert.deepEqual(readAmpUsage({ env: NO_AMP }), { tokens: null, status: "" },
    "amp missing from PATH is no data, not a throw");
  assert.deepEqual(readAmpUsage({ env: BIN.nonzero }), { tokens: null, status: "" },
    "a non-zero exit discards even a valid-looking stdout");
  assert.deepEqual(readAmpUsage({ env: BIN.garbage }), { tokens: null, status: "" });
  assert.deepEqual(readAmpUsage({ env: BIN.stderrOnly }), { tokens: null, status: "" },
    "only stdout is parsed; stderr is ignored");
  assert.deepEqual(readAmpUsage({ env: BIN.gated }), { tokens: null, status: "" },
    "the env option is really passed to the child");
  assert.equal(readAmpUsage({ env: { ...BIN.gated, AMP_DEEP_OK: "1" } }).tokens, 7,
    "with the gate open the same script reports tokens");
  // env given as a non-object does not throw; the lookup just fails.
  assert.deepEqual(readAmpUsage({ env: "nope" }), { tokens: null, status: "" });
  assert.deepEqual(readAmpUsage({ env: [] }), { tokens: null, status: "" });

  // ---- readAmpUsage: timeout handling ----
  let t = Date.now();
  assert.deepEqual(readAmpUsage({ env: BIN.slow, timeoutMs: 300 }), { tokens: null, status: "" });
  assert.ok(Date.now() - t < 900, "a 1s amp killed at timeoutMs=300 returns in well under a second");
  t = Date.now();
  assert.equal(readAmpUsage({ env: BIN.slow, timeoutMs: 0 }).tokens, 9,
    "timeoutMs 0 disables the timeout: the slow amp is waited out and parsed");
  assert.ok(Date.now() - t >= 800, "...and it really did wait ~1s");

  // ---- readAmpUsage: output cap ----
  assert.deepEqual(readAmpUsage({ env: BIN.big }), { tokens: null, status: "" },
    "stdout over the 4MB maxBuffer is an error -> no data");

  // ---- readAmpUsage: invalid options throw before/at spawn ----
  for (const bad of [-1, Infinity, -Infinity, 1.5e999]) {
    assert.throws(() => readAmpUsage({ env: NO_AMP, timeoutMs: bad }),
      (e) => e.code === "ERR_OUT_OF_RANGE", `timeoutMs=${bad} is out of range`);
  }
  assert.throws(() => readAmpUsage({ env: NO_AMP, timeoutMs: "abc" }),
    (e) => e.code === "ERR_INVALID_ARG_TYPE", "a non-numeric timeoutMs is a type error");
  assert.throws(() => readAmpUsage(null), TypeError, "null options cannot be destructured");

  // ---- readAmpUsage: the default env path, exercised safely ----
  // readAmpUsage() with no args uses process.env; point PATH at the fake bin
  // for the duration of the call so the real amp can never run.
  const realPath = process.env.PATH;
  try {
    process.env.PATH = `${path.join(tmp, "bin-ok")}:${realPath}`;
    assert.equal(readAmpUsage().tokens, 42, "default env still finds amp first on PATH");
  } finally {
    process.env.PATH = realPath;
  }

  // ---- readAmpUsage: statelessness / sequential calls ----
  // spawnSync is synchronous, so there is no true concurrency to race; what
  // matters is that calls share no state. Interleave good and bad fakes.
  assert.equal(readAmpUsage({ env: BIN.ok }).tokens, 42);
  assert.deepEqual(readAmpUsage({ env: BIN.nonzero }), { tokens: null, status: "" });
  assert.equal(readAmpUsage({ env: BIN.ok }).tokens, 42, "a failed call leaves no residue");
  // And a parseAmpUsage call cannot be affected by spawn state either.
  assert.equal(parseAmpUsage("Total tokens: 11").tokens, 11);

  console.log("amp-usage deep: all tests passed");
} finally {
  for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
