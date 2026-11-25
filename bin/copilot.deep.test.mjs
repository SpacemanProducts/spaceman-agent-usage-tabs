// Deep edge-case pass for bin/copilot.mjs on top of copilot.test.mjs.
// parseCopilotQuota is pure (no I/O, no clock, no shared state), so the
// scratch dir only exists to satisfy the "never touch the real home folder"
// rule; env vars are pointed at it. The CLI entry block (gh auth token +
// fetch) is exercised by spawning the real script with a stub `gh` first on
// PATH. A successful fetch can't be stubbed (the URL is hard-coded), so the
// CLI cases only cover the paths that end in the empty `out({})` answer:
// no token, gh failure, and a bad token (401 or network error, same output).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseCopilotQuota } from "./copilot.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const copilotPath = path.join(here, "copilot.mjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-deep-"));
const home = path.join(tmp, "home");
const xdg = path.join(tmp, "xdg");
const bin = path.join(tmp, "bin");
for (const d of [home, xdg, bin]) fs.mkdirSync(d, { recursive: true });
const savedEnv = {};
for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
  savedEnv[k] = process.env[k];
  process.env[k] = path.join(tmp, k.toLowerCase());
  fs.mkdirSync(process.env[k], { recursive: true });
}

const q = (snap, extra = {}) => ({ copilot_plan: "individual", quota_reset_date_utc: "2026-12-01T00:00:00.000Z", quota_snapshots: { premium_interactions: snap }, ...extra });

try {
  // ---- planOf(): wrong-typed and missing payloads ----
  for (const bad of [null, undefined, 0, "", "x", 42, true, false, [], [1], NaN]) {
    const r = parseCopilotQuota(bad);
    assert.deepEqual(r, { limits: [], plan: "", free: false, status: "" },
      `parseCopilotQuota(${JSON.stringify(bad) ?? String(bad)}) is the empty answer`);
  }
  // Plan names are looked up case-insensitively; unknown names give "" (not a guess).
  assert.equal(parseCopilotQuota(q({ entitlement: 1, credits_used: 0 }, { copilot_plan: "INDIVIDUAL" })).plan, "Pro");
  assert.equal(parseCopilotQuota(q({ entitlement: 1, credits_used: 0 }, { copilot_plan: "Individual_Pro" })).plan, "Pro+");
  assert.equal(parseCopilotQuota(q({ entitlement: 1, credits_used: 0 }, { copilot_plan: "BUSINESS" })).plan, "Business");
  assert.equal(parseCopilotQuota(q({ entitlement: 1, credits_used: 0 }, { copilot_plan: "Enterprise" })).plan, "Enterprise");
  assert.equal(parseCopilotQuota(q({ entitlement: 1, credits_used: 0 }, { copilot_plan: "mystery" })).plan, "");
  assert.equal(parseCopilotQuota(q({ entitlement: 1, credits_used: 0 }, { copilot_plan: "mystery" })).free, false,
    "an unknown plan is not 'Free'");
  // access_type_sku wins over copilot_plan when it says free (the real free-account shape).
  assert.equal(parseCopilotQuota(q({ entitlement: 1, credits_used: 0 }, { copilot_plan: "business", access_type_sku: "free_limited_copilot" })).plan, "Free");
  // ...and the match is a substring test: any sku/plan containing "free" reads as Free.
  assert.equal(parseCopilotQuota(q({ entitlement: 1, credits_used: 0 }, { access_type_sku: "notfree_trial" })).plan, "Free",
    "BUG?: /free/i substring match — 'notfree_trial' is not a free plan but reads as one");
  assert.equal(parseCopilotQuota(q({ entitlement: 1, credits_used: 0 }, { copilot_plan: "freemium_plus" })).plan, "Free",
    "same substring quirk on copilot_plan");

  // ---- quota_reset_date_utc edges ----
  const noAllow = { quota_snapshots: { premium_interactions: { entitlement: 0, credits_used: 0 } } };
  for (const bad of ["", "not a date", "2026-13-45T99:99:99Z", null, undefined, false, {}, []]) {
    const r = parseCopilotQuota({ copilot_plan: "individual", quota_reset_date_utc: bad, ...noAllow });
    assert.equal(r.status, "No included allowance on this plan", `bad reset date ${JSON.stringify(bad)}: no '· resets' tail`);
    assert.equal(r.limits.length, 0);
  }
  // A date-only string and an offset-bearing string both normalise to ISO.
  assert.equal(parseCopilotQuota({ copilot_plan: "individual", quota_reset_date_utc: "2026-12-01", ...noAllow }).status,
    "No included allowance on this plan · resets Dec 1, 00:00 UTC");
  assert.equal(parseCopilotQuota(q({ entitlement: 10, credits_used: 1 }, { quota_reset_date_utc: "2026-12-01T05:30:00+05:30" })).limits[0].resetsAt,
    "2026-12-01T00:00:00.000Z", "offset normalises to UTC");
  // BUG: the 'No included allowance' status hardcodes ", 00:00 UTC". A reset
  // date carrying a real time-of-day is reported at the wrong hour.
  // assert.equal(
  //   parseCopilotQuota({ copilot_plan: "individual", quota_reset_date_utc: "2026-12-01T15:30:00Z", ...noAllow }).status,
  //   "No included allowance on this plan · resets Dec 1, 15:30 UTC");
  assert.equal(
    parseCopilotQuota({ copilot_plan: "individual", quota_reset_date_utc: "2026-12-01T15:30:00Z", ...noAllow }).status,
    "No included allowance on this plan · resets Dec 1, 00:00 UTC",
    "current (buggy) behaviour pinned: the status claims 00:00 UTC for a 15:30 reset");

  // ---- quota_snapshots wrong types ----
  for (const bad of [null, undefined, 0, "x", 42, true, [], "[]"]) {
    const r = parseCopilotQuota({ copilot_plan: "individual", quota_reset_date_utc: "2026-12-01T00:00:00.000Z", quota_snapshots: bad });
    assert.deepEqual(r, { limits: [], plan: "Pro", free: false, status: "" },
      `quota_snapshots=${JSON.stringify(bad) ?? String(bad)} yields nothing`);
  }
  // chat present but premium missing entirely -> just the allowance meter.
  {
    const r = parseCopilotQuota({ copilot_plan: "free", quota_snapshots: { chat: { entitlement: 200, percent_remaining: 50 } } });
    assert.deepEqual(r.limits.map((l) => l.title), ["Chat and agent requests"]);
    assert.equal(r.status, "");
  }

  // ---- allowanceMeter() via quota_snapshots.chat: gating ----
  const chatOnly = (chat) => parseCopilotQuota({ copilot_plan: "free", quota_reset_date_utc: "2026-12-01T00:00:00.000Z", quota_snapshots: { chat, premium_interactions: { entitlement: 0, credits_used: 0 } } });
  for (const bad of [null, undefined, 0, "x", 42, true, "entitlement"]) {
    assert.deepEqual(chatOnly(bad).limits, [], `chat=${JSON.stringify(bad) ?? String(bad)}: no meter`);
  }
  // [] is an object but has no usable fields -> still no meter.
  assert.deepEqual(chatOnly([]).limits, []);
  // has_quota/unlimited are STRICT checks: truthy non-true values do not gate.
  assert.equal(chatOnly({ entitlement: 200, percent_remaining: 50, has_quota: 0 }).limits.length, 1,
    "has_quota: 0 does NOT disable the meter (strict === false)");
  assert.equal(chatOnly({ entitlement: 200, percent_remaining: 50, has_quota: "false" }).limits.length, 1,
    "has_quota: 'false' does NOT disable the meter");
  assert.equal(chatOnly({ entitlement: 200, percent_remaining: 50, unlimited: "yes" }).limits.length, 1,
    "unlimited: 'yes' does NOT disable the meter (strict === true)");
  assert.equal(chatOnly({ entitlement: 200, percent_remaining: 50, unlimited: 1 }).limits.length, 1);
  assert.deepEqual(chatOnly({ entitlement: 200, percent_remaining: 50, unlimited: true }).limits, [],
    "unlimited: true does disable");
  assert.deepEqual(chatOnly({ entitlement: 200, percent_remaining: 50, has_quota: false }).limits, [],
    "has_quota: false does disable");
  // entitlement edges: 0/negative/garbage -> no meter; numeric strings coerce.
  for (const ent of [0, -5, "", "junk", NaN, Infinity, true, false, null, undefined]) {
    assert.deepEqual(chatOnly({ entitlement: ent, percent_remaining: 50 }).limits, [],
      `entitlement=${JSON.stringify(ent) ?? String(ent)}: no meter`);
  }
  assert.equal(chatOnly({ entitlement: "200", percent_remaining: "50" }).limits[0].percent, 0.5,
    "numeric strings coerce through num()");
  assert.equal(chatOnly({ entitlement: [200], percent_remaining: 50 }).limits[0].percent, 0.5,
    "single-element array coerces to its element (Number([200]) === 200)");

  // ---- allowanceMeter(): which figure wins ----
  // percent_remaining beats everything.
  assert.equal(chatOnly({ entitlement: 100, percent_remaining: 40, remaining: 90, quota_remaining: 95, credits_used: 99 }).limits[0].percent, 0.6);
  // Without percent_remaining, quota_remaining beats remaining (the reverse of
  // the premium meter, which prefers remaining — pinned asymmetry).
  assert.equal(chatOnly({ entitlement: 100, remaining: 90, quota_remaining: 80 }).limits[0].percent, 0.2);
  assert.equal(chatOnly({ entitlement: 100, remaining: 90 }).limits[0].percent, 0.1);
  // credits_used is the last resort.
  assert.equal(chatOnly({ entitlement: 100, credits_used: 25 }).limits[0].percent, 0.25);
  assert.equal(chatOnly({ entitlement: 100, credits_used: "25" }).limits[0].percent, 0.25);
  // No usable figure at all -> no meter.
  for (const snap of [{ entitlement: 100 }, { entitlement: 100, percent_remaining: "junk" }, { entitlement: 100, remaining: "", quota_remaining: null, credits_used: true }]) {
    assert.deepEqual(chatOnly(snap).limits, [], `no usable usage figure: ${JSON.stringify(snap)}`);
  }
  // percent_remaining out of range clamps through clamp01.
  assert.equal(chatOnly({ entitlement: 100, percent_remaining: 140 }).limits[0].percent, 0, "pctLeft > 100 -> used < 0 -> clamped 0");
  assert.equal(chatOnly({ entitlement: 100, percent_remaining: -40 }).limits[0].percent, 1, "negative pctLeft -> used > 1 -> clamped to 1");
  assert.equal(chatOnly({ entitlement: 100, quota_remaining: 250 }).limits[0].percent, 0, "remaining > entitlement -> negative used -> clamped 0");
  assert.equal(chatOnly({ entitlement: 100, credits_used: -10 }).limits[0].percent, 0, "negative credits_used -> negative used -> clamped 0");

  // ---- allowanceMeter(): token-based billing note ----
  // The credits note is only added for the chat meter (title check), and only
  // when token_based_billing === true (strict).
  const tok = chatOnly({ entitlement: 200, percent_remaining: 50, token_based_billing: true });
  assert.equal(tok.limits[0].note, "100 of 200 AI credits used. Shared plan quota",
    "note counts used credits derived from percent when no remaining figure");
  const tok2 = chatOnly({ entitlement: 200, quota_remaining: 50, token_based_billing: true });
  assert.equal(tok2.limits[0].note, "150 of 200 AI credits used. Shared plan quota",
    "note prefers the remaining figure over the percent-derived one");
  assert.equal(chatOnly({ entitlement: 200, percent_remaining: 50, token_based_billing: "yes" }).limits[0].note,
    "Shared plan quota", "token_based_billing must be strictly true");
  // The premium 'Monthly' meter never gets the credits note (it doesn't go
  // through allowanceMeter and carries no note field at all).
  const premTok = parseCopilotQuota(q({ entitlement: 300, credits_used: 30, token_based_billing: true }));
  assert.equal(premTok.limits[0].note, undefined, "premium meter has no note even under token billing");
  // credits() rounds to one decimal.
  assert.equal(chatOnly({ entitlement: 200, quota_remaining: 194.94, token_based_billing: true }).limits[0].note,
    "5.1 of 200 AI credits used. Shared plan quota");

  // ---- premium_interactions(): gating and wrong types ----
  for (const bad of [null, undefined, 0, "x", 42, true, "snap"]) {
    const r = parseCopilotQuota({ copilot_plan: "individual", quota_snapshots: { premium_interactions: bad } });
    assert.deepEqual(r, { limits: [], plan: "Pro", free: false, status: "" },
      `premium=${JSON.stringify(bad) ?? String(bad)}: empty answer`);
  }
  // [] is an object -> proceeds -> entitlement null -> empty status, not a throw.
  assert.deepEqual(parseCopilotQuota({ copilot_plan: "individual", quota_snapshots: { premium_interactions: [] } }).status, "");
  // unlimited is strict === true.
  assert.equal(parseCopilotQuota(q({ unlimited: "yes", entitlement: 100, credits_used: 10 })).limits.length, 1,
    "unlimited: 'yes' still meters");
  // entitlement <= 0 variants all give the 'No included allowance' line (with a chat meter present -> status stays "").
  assert.equal(parseCopilotQuota(q({ entitlement: -3, credits_used: 0 })).status, "No included allowance on this plan · resets Dec 1, 00:00 UTC");
  assert.equal(parseCopilotQuota(q({ entitlement: "0", credits_used: 0 })).status, "No included allowance on this plan · resets Dec 1, 00:00 UTC",
    "numeric-string '0' coerces to <= 0");
  assert.equal(parseCopilotQuota({ copilot_plan: "individual", quota_reset_date_utc: "2026-12-01T00:00:00.000Z",
    quota_snapshots: { premium_interactions: { entitlement: 0, credits_used: 0 }, chat: { entitlement: 200, percent_remaining: 50 } } }).status,
    "", "allowances present -> no status line even at entitlement 0");
  // entitlement that num() rejects (boolean, junk, empty) -> plain empty status, NOT the no-allowance line.
  for (const ent of [true, false, "junk", "", NaN, Infinity, null, undefined]) {
    assert.equal(parseCopilotQuota(q({ entitlement: ent, credits_used: 5 })).status, "",
      `entitlement=${JSON.stringify(ent) ?? String(ent)} -> status "" (num() -> null)`);
  }
  // has_quota is never consulted for the premium meter.
  assert.equal(parseCopilotQuota(q({ entitlement: 100, credits_used: 10, has_quota: false })).limits.length, 1,
    "premium meter ignores has_quota");

  // ---- premium used-figure precedence: credits_used > remaining > quota_remaining > percent_remaining ----
  const prem = (snap) => parseCopilotQuota(q(snap)).limits[0]?.percent;
  assert.equal(prem({ entitlement: 100, credits_used: 50, remaining: 10, percent_remaining: 90 }), 0.5, "credits_used wins");
  assert.equal(prem({ entitlement: 100, remaining: 90, quota_remaining: 80, percent_remaining: 10 }), 0.1,
    "remaining beats quota_remaining (opposite of the chat meter)");
  assert.equal(prem({ entitlement: 100, quota_remaining: 80, percent_remaining: 10 }), 0.2, "quota_remaining beats percent_remaining");
  assert.equal(prem({ entitlement: 100, percent_remaining: 25 }), 0.75);
  // credits_used: "" / junk / boolean fall through to the next figure.
  assert.equal(prem({ entitlement: 100, credits_used: "", remaining: 75 }), 0.25);
  assert.equal(prem({ entitlement: 100, credits_used: "junk", percent_remaining: 50 }), 0.5);
  assert.equal(prem({ entitlement: 100, credits_used: true, remaining: 60 }), 0.4);
  // Out-of-range results clamp through clamp01; negative used still yields a meter at 0.
  assert.equal(prem({ entitlement: 100, remaining: 150 }), 0, "remaining > entitlement -> 0");
  assert.equal(prem({ entitlement: 100, remaining: -50 }), 1, "negative remaining -> used 150 -> clamped 1");
  assert.equal(prem({ entitlement: 100, percent_remaining: 120 }), 0);
  assert.equal(prem({ entitlement: 100, percent_remaining: -20 }), 1);
  assert.equal(prem({ entitlement: 100, credits_used: -5 }), 0, "negative credits_used -> meter at 0 (not dropped)");
  assert.equal(prem({ entitlement: 100, credits_used: 250 }), 1, "credits_used > entitlement -> clamped 1");
  // entitlement as a numeric string works end to end.
  assert.equal(prem({ entitlement: "200", credits_used: "50" }), 0.25);

  // ---- ordering and shared resetsAt ----
  {
    const r = parseCopilotQuota({ copilot_plan: "free", quota_reset_date_utc: "2026-12-01T00:00:00.000Z", quota_snapshots: {
      premium_interactions: { entitlement: 300, credits_used: 30 },
      chat: { entitlement: 200, percent_remaining: 50 } } });
    assert.deepEqual(r.limits.map((l) => l.title), ["Monthly", "Chat and agent requests"], "Monthly first, allowances after");
    assert.ok(r.limits.every((l) => l.resetsAt === "2026-12-01T00:00:00.000Z"), "same resetsAt on every meter");
    assert.equal(r.limits[1].window, "monthly");
    // A bad reset date propagates "" to every meter.
    const r2 = parseCopilotQuota({ copilot_plan: "free", quota_reset_date_utc: "junk", quota_snapshots: {
      premium_interactions: { entitlement: 300, credits_used: 30 }, chat: { entitlement: 200, percent_remaining: 50 } } });
    assert.ok(r2.limits.every((l) => l.resetsAt === ""));
  }

  // ---- purity: no mutation, no memoization, interleaved calls independent ----
  {
    const input = q({ entitlement: 100, credits_used: 10 }, { quota_snapshots: undefined });
    input.quota_snapshots = { premium_interactions: { entitlement: 100, credits_used: 10 }, chat: { entitlement: 200, percent_remaining: 50 } };
    const before = JSON.stringify(input);
    const a = parseCopilotQuota(input);
    assert.equal(JSON.stringify(input), before, "input untouched");
    input.quota_snapshots.chat.percent_remaining = 90;
    const b = parseCopilotQuota(input);
    assert.notDeepEqual(a, b, "mutated input is re-read: no caching");
    assert.ok(Math.abs(b.limits[1].percent - 0.1) < 1e-9, "chat meter re-read at 10% used");
    // Many interleaved calls stay independent (no shared module state).
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) =>
      Promise.resolve().then(() => parseCopilotQuota({ copilot_plan: i % 2 ? "free" : "individual", quota_snapshots: { premium_interactions: { entitlement: 100, credits_used: i } } }))));
    assert.equal(results[7].limits[0].percent, 0.07);
    assert.equal(results[8].limits[0].percent, 0.08);
  }

  // ---- CLI entry block: gh token -> fetch -> out() ----
  const stub = (name, body) => { const f = path.join(bin, name); fs.writeFileSync(f, `#!/bin/sh\n${body}\n`); fs.chmodSync(f, 0o755); };
  const childEnv = (extraPath = "") => ({
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: path.join(xdg, "state"),
    XDG_CONFIG_HOME: path.join(xdg, "config"),
    XDG_CACHE_HOME: path.join(xdg, "cache"),
    PATH: `${bin}${extraPath}:/usr/bin:/bin`,
  });
  const runCli = (env) => {
    const r = spawnSync(process.execPath, [copilotPath], { encoding: "utf8", env, timeout: 30000 });
    assert.equal(r.status, 0, `CLI exit: ${r.stderr}`);
    const lines = String(r.stdout).trim().split("\n");
    assert.equal(lines.length, 1, "exactly one JSON line on stdout");
    return JSON.parse(lines[0]);
  };
  const EMPTY = { limits: [], plan: "", status: "" };

  // gh prints nothing -> no token -> empty answer, no fetch attempted.
  stub("gh", `exit 0`);
  assert.deepEqual(runCli(childEnv()), EMPTY, "gh with empty stdout -> empty answer");
  // gh fails outright -> same.
  stub("gh", `echo "gh: not logged in" >&2\nexit 1`);
  assert.deepEqual(runCli(childEnv()), EMPTY, "gh failure -> empty answer");
  // gh prints only whitespace -> trimmed to "" -> empty answer.
  stub("gh", `printf '   \\n\\t\\n'`);
  assert.deepEqual(runCli(childEnv()), EMPTY, "whitespace token -> empty answer");
  // gh prints a token -> fetch happens; a bogus token can only end in the
  // same empty answer (401, or network failure -> catch -> out({})).
  stub("gh", `printf 'definitely-not-a-real-token\\n'`);
  assert.deepEqual(runCli(childEnv()), EMPTY, "bad token -> empty answer (res.ok false or fetch threw)");
  // Two CLI runs in flight at once stay independent (separate processes, no shared files).
  {
    stub("gh", `exit 0`);
    const once = () => new Promise((resolve, reject) => {
      const c = spawn(process.execPath, [copilotPath], { env: childEnv() });
      let out = "", err = "";
      c.stdout.on("data", (d) => { out += d; });
      c.stderr.on("data", (d) => { err += d; });
      c.on("close", (code) => code === 0 ? resolve(JSON.parse(out.trim())) : reject(new Error(err)));
    });
    const [r1, r2] = await Promise.all([once(), once()]);
    assert.deepEqual(r1, EMPTY);
    assert.deepEqual(r2, EMPTY);
  }

  console.log("copilot deep: all tests passed");
} finally {
  for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
