// Deep edge-case pass for bin/agy-resets.mjs on top of agy-resets.test.mjs.
// The module is pure (fetchFn/url/now injected, corroborate synchronous), so
// nothing here touches the network or the real HOME: the scratch dir only
// exists to satisfy the "never touch the real home folder" rule.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { corroborate, fetchResets, WINDOW_BEFORE_MS, WINDOW_AFTER_MS } from "./agy-resets.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-resets-deep-"));
const savedEnv = {};
for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "AGY_RESETS_URL"]) {
  savedEnv[k] = process.env[k];
  if (k === "AGY_RESETS_URL") { delete process.env[k]; continue; }
  process.env[k] = path.join(tmp, k.toLowerCase());
  fs.mkdirSync(process.env[k], { recursive: true });
}

const NOW = Date.parse("2026-11-25T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const ago = (ms) => iso(NOW - ms);
const R = (over = {}) => ({ id: "r", announced_at: ago(3600e3), models: ["all"], plans: ["all"], ...over });
const S = (title, extra = {}) => [{ title, surprise: true, dueAt: "2026-11-28T00:00:00Z", ...extra }];
const okBody = (body) => async () => ({ ok: true, json: async () => body });

try {
  // ---- corroborate: identity and detail shapes ----
  const ann = R({ id: "keep-me" });
  assert.equal(corroborate([ann], S("Gemini Session"), NOW, "Free"), ann, "returns the announcement object itself");
  assert.equal(corroborate([R(), R({ id: "second" })], S("Gemini Session"), NOW, "Free").id, "r", "first match wins");
  assert.equal(corroborate(null, S("Gemini Session"), NOW), null, "null resets");
  assert.equal(corroborate("junk", S("Gemini Session"), NOW), null, "non-array resets");
  assert.equal(corroborate(42, S("Gemini Session"), NOW), null);
  assert.equal(corroborate([null, 7, "x", {}, R({ id: "late" })], S("Gemini Session"), NOW, "Free").id, "late", "junk entries skipped, real one still found");
  assert.equal(corroborate([R()], null, NOW), null, "null details");
  assert.equal(corroborate([R()], undefined, NOW), null);
  assert.equal(corroborate([R()], [null, undefined, 0, "x"], NOW), null, "no usable surprise detail");
  assert.equal(corroborate([R()], [{ surprise: 1 }], NOW, "Free").id, "r", "truthy non-boolean surprise counts");
  assert.equal(corroborate([R()], [{ title: "Gemini Session", surprise: "yes" }], NOW, "Free").id, "r");

  // ---- corroborate: title tokenization edges ----
  assert.equal(corroborate([R({ models: ["all"] })], S(null), NOW, "Free").id, "r", "empty title still matches an all-models announcement");
  assert.equal(corroborate([R({ models: ["gemini"] })], S(null), NOW, "Free"), null, "empty title cannot match a model-scoped announcement");
  assert.equal(corroborate([R({ models: ["all"] })], S(""), NOW, "Free").id, "r");
  assert.equal(corroborate([R({ models: ["all"] })], S(123), NOW, "Free").id, "r", "non-string title coerced");
  assert.equal(corroborate([R({ models: ["ai"] })], S("AI Session"), NOW, "Free"), null, "'ai' is too short a token to match");
  assert.equal(corroborate([R({ models: ["gemini"] })], S("Gemini"), NOW, "Free").id, "r", "a bare family word is itself a token");
  assert.equal(corroborate([R({ models: ["gemini"] })], S("Gemini Session Weekly Monthly Limit"), NOW, "Free").id, "r", "only 'gemini' survives the stopword filter");
  assert.equal(corroborate([R({ models: ["claude"] })], S("Claude/GPT Weekly"), NOW, "Free").id, "r", "slash-separated families both tokenize");
  assert.equal(corroborate([R({ models: ["gpt"] })], S("Claude/GPT Weekly"), NOW, "Free").id, "r", "second family token matches too");
  assert.equal(corroborate([R({ models: ["weekly"] })], S("Gemini Session"), NOW, "Free"), null, "'weekly' is filtered from meter tokens so a weekly-scoped announcement cannot match via it");

  // ---- corroborate: multiple surprise details union their tokens ----
  const two = [
    { title: "Claude Session", surprise: true },
    { title: "GPT Weekly", surprise: true },
  ];
  assert.equal(corroborate([R({ models: ["gpt"] })], two, NOW, "Free").id, "r", "tokens from every surprise detail are unioned");
  const mixed = [{ title: "Claude Session", surprise: false }, { title: "Gemini Weekly", surprise: true }];
  assert.equal(corroborate([R({ models: ["gemini"] })], mixed, NOW, "Free").id, "r", "scheduled details ignored, surprise one still corroborates");
  assert.equal(corroborate([R({ models: ["gemini"] })], [{ title: "Claude Session", surprise: false }], NOW, "Free"), null);

  // ---- corroborate: announcement field shapes ----
  assert.equal(corroborate([R({ models: [] })], S("Gemini Session"), NOW, "Free").id, "r", "empty models list behaves as a wildcard (documents current behavior)");
  assert.equal(corroborate([R({ plans: [] })], S("Gemini Session"), NOW, "Enterprise").id, "r", "empty plans list skips the plan check: any plan corroborates");
  assert.equal(corroborate([R({ plans: ["ALL"] })], S("Gemini Session"), NOW, "Free").id, "r", "plan 'all' is case-insensitive");
  assert.equal(corroborate([R({ plans: ["Free"] })], S("Gemini Session"), NOW, "FREE").id, "r", "user plan compared case-insensitively");
  assert.equal(corroborate([R({ plans: ["free"] })], S("Gemini Session"), NOW, ""), null, "no plan on file cannot satisfy a plan-scoped announcement");
  assert.equal(corroborate([R({ plans: ["free"] })], S("Gemini Session"), NOW), null, "missing plan arg = empty plan");
  assert.equal(corroborate([R({ plans: [null, 5, "all"] })], S("Gemini Session"), NOW, "Free").id, "r", "non-string plan entries coerced");
  assert.equal(corroborate([R({ models: ["Gemini"] })], S("Gemini Session"), NOW, "Free").id, "r", "announcement models lowercased before compare");

  // ---- corroborate: time window edges ----
  assert.equal(corroborate([R({ announced_at: iso(NOW - WINDOW_BEFORE_MS) })], S("Gemini Session"), NOW, "Free").id, "r", "exactly WINDOW_BEFORE_MS old still counts");
  assert.equal(corroborate([R({ announced_at: iso(NOW - WINDOW_BEFORE_MS - 1) })], S("Gemini Session"), NOW, "Free"), null, "1 ms older than the window does not");
  assert.equal(corroborate([R({ announced_at: iso(NOW + WINDOW_AFTER_MS) })], S("Gemini Session"), NOW, "Free").id, "r", "exactly WINDOW_AFTER_MS ahead still counts");
  assert.equal(corroborate([R({ announced_at: iso(NOW + WINDOW_AFTER_MS + 1) })], S("Gemini Session"), NOW, "Free"), null);
  assert.equal(corroborate([R({ announced_at: iso(NOW) })], S("Gemini Session"), NOW, "Free").id, "r", "announced at detection instant");
  for (const bad of ["", null, undefined, "junk", 0, 1764000000000, {}, []]) {
    assert.equal(corroborate([R({ announced_at: bad })], S("Gemini Session"), NOW, "Free"), null, `announced_at=${JSON.stringify(bad)} skipped`);
  }
  // Regression: an announcement whose `plans` or `models` is a non-array
  // truthy (e.g. the string "all", which a sloppy API payload could send)
  // must be skipped, not throw TypeError on `.map`.
  assert.equal(corroborate([R({ models: "all" })], S("Gemini Session"), NOW, "Free"), null);
  assert.equal(corroborate([R({ plans: "all" })], S("Gemini Session"), NOW, "Free"), null);

  // Regression: a non-array `details` (object, string, number) returns null
  // instead of throwing TypeError on `.filter`.
  // collect.mjs always passes the classifier's array, so this is latent.
  assert.equal(corroborate([R()], { title: "Gemini Session", surprise: true }, NOW), null);
  assert.equal(corroborate([R()], "Gemini Session", NOW), null);

  // Regression: with `detectedAt` missing or NaN the time window must not
  // silently disable itself — no readable time means no match.
  assert.equal(corroborate([R({ announced_at: "2020-01-01T00:00:00Z" })], S("Gemini Session"), undefined, "Free"), null);

  // ---- fetchResets: response shape edges ----
  assert.deepEqual(await fetchResets({ now: NOW, fetchFn: okBody(null) }), []);
  assert.deepEqual(await fetchResets({ now: NOW, fetchFn: okBody([1, 2]) }), [], "array body has no .data");
  assert.deepEqual(await fetchResets({ now: NOW, fetchFn: okBody("text") }), []);
  assert.deepEqual(await fetchResets({ now: NOW, fetchFn: okBody(42) }), []);
  assert.deepEqual(await fetchResets({ now: NOW, fetchFn: okBody({ data: "x" }) }), [], "data not an array");
  assert.deepEqual(await fetchResets({ now: NOW, fetchFn: okBody({ data: {} }) }), []);
  assert.deepEqual(await fetchResets({ now: NOW, fetchFn: okBody({ data: null }) }), []);
  const dataArr = [R()];
  const got = await fetchResets({ now: NOW, fetchFn: okBody({ data: dataArr, extra: 1 }) });
  assert.equal(got, dataArr, "the data array is returned by reference, extra fields ignored");

  // ---- fetchResets: fetchFn/response oddities ----
  assert.deepEqual(await fetchResets({ now: NOW, fetchFn: null }), [], "null fetchFn throws inside try -> []");
  assert.deepEqual(await fetchResets({ now: NOW, fetchFn: 42 }), []);
  assert.deepEqual(await fetchResets({ now: NOW, fetchFn: async () => null }), [], "null response");
  assert.deepEqual(await fetchResets({ now: NOW, fetchFn: async () => ({}) }), [], "response with no ok/json");
  assert.deepEqual(await fetchResets({ now: NOW, fetchFn: async () => ({ ok: true }) }), [], "json() missing throws -> []");
  assert.deepEqual(await fetchResets({ now: NOW, fetchFn: async () => ({ ok: true, json: async () => { throw new Error("bad json"); } }) }), [], "json() rejection -> []");
  assert.deepEqual(await fetchResets({ now: NOW, fetchFn: async () => ({ ok: true, json: null }) }), [], "json not a function -> []");
  assert.deepEqual(await fetchResets({ now: NOW, fetchFn: async () => ({ ok: 0 }) }), [], "ok falsy -> [] without parsing");
  let parsed = false;
  await fetchResets({ now: NOW, fetchFn: async () => ({ ok: false, json: async () => { parsed = true; return {}; } }) });
  assert.equal(parsed, false, "non-ok responses never parse the body");

  // ---- fetchResets: URL construction ----
  let seen;
  await fetchResets({ now: NOW, fetchFn: async (u, o) => { seen = { u, o }; return { ok: true, json: async () => ({ data: [] }) }; } });
  const q = new URL(seen.u).searchParams;
  assert.equal(q.get("limit"), "10");
  assert.equal(q.get("from"), iso(NOW - WINDOW_BEFORE_MS - 3600e3), "from is 13h before now, ISO-encoded");
  assert.equal(seen.o.headers.Accept, "application/json");
  assert.ok(seen.o.signal instanceof AbortSignal, "an AbortSignal is always passed");
  await fetchResets({ now: 0, fetchFn: async (u) => { seen = { u }; return { ok: true, json: async () => ({ data: [] }) }; } });
  assert.equal(new URL(seen.u).searchParams.get("from"), iso(-WINDOW_BEFORE_MS - 3600e3), "now=0 still produces a valid ISO from");
  for (const badNow of [NaN, "junk", Infinity, -Infinity]) {
    assert.deepEqual(await fetchResets({ now: badNow, fetchFn: okBody({ data: [1] }) }), [], `now=${badNow} -> toISOString throws -> []`);
  }
  await fetchResets({ now: NOW, fetchFn: async () => ({ ok: true, json: async () => ({ data: [] }) }) });
  assert.equal(process.env.AGY_RESETS_URL, undefined, "AGY_RESETS_URL unset in test env");

  // env override: AGY_RESETS_URL replaces the endpoint entirely
  process.env.AGY_RESETS_URL = "https://resets.example.test/custom";
  await fetchResets({ now: NOW, fetchFn: async (u) => { seen = { u }; return { ok: true, json: async () => ({ data: [] }) }; } });
  assert.ok(seen.u.startsWith("https://resets.example.test/custom?"), "env url used as base");
  delete process.env.AGY_RESETS_URL;
  await fetchResets({ now: NOW, fetchFn: async (u) => { seen = { u }; return { ok: true, json: async () => ({ data: [] }) }; } });
  assert.ok(seen.u.startsWith("https://agyresets.com/api/v1/resets?"), "default API url restored");

  // ---- fetchResets: timeout actually aborts ----
  {
    // AbortSignal.timeout's timer is unref'd, so a bare await could leave the
    // event loop empty before the abort fires; keep it alive with a real timer.
    const p = fetchResets({
      now: NOW, timeoutMs: 30,
      fetchFn: (_u, o) => new Promise((_res, rej) => o.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))),
    });
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(await p, []);
  }
  {
    // a fetchFn that ignores the signal is NOT cancelled by the module itself;
    // the timeout only reaches code that honours the signal. Document that.
    let settled = false;
    const p = fetchResets({ now: NOW, timeoutMs: 20, fetchFn: () => new Promise((res) => setTimeout(() => { settled = true; res({ ok: true, json: async () => ({ data: [] }) }); }, 60)) });
    await p;
    assert.equal(settled, true, "module waits for a signal-ignoring fetchFn; timeout is cooperative only");
  }

  // ---- fetchResets: concurrency ----
  {
    const results = await Promise.all([
      fetchResets({ now: NOW, fetchFn: okBody({ data: [R({ id: "a" })] }) }),
      fetchResets({ now: NOW, fetchFn: async () => { throw new Error("net down"); } }),
      fetchResets({ now: NOW, fetchFn: okBody({ data: "bad" }) }),
      fetchResets({ now: NOW, fetchFn: okBody({ data: [R({ id: "b" })] }) }),
    ]);
    assert.deepEqual(results.map((r) => r.map((x) => x.id)), [["a"], [], [], ["b"]], "parallel calls are independent, failures isolated");
  }
  {
    // same fetchFn shared across concurrent calls: call count and args stay per-call
    const calls = [];
    const shared = async (u, o) => { calls.push(u); return { ok: true, json: async () => ({ data: [] }) }; };
    await Promise.all([fetchResets({ now: NOW, fetchFn: shared }), fetchResets({ now: NOW + 1000, fetchFn: shared })]);
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0], calls[1], "each call builds its own URL from its own now");
  }

  console.log("agy-resets deep: all tests passed");
} finally {
  for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "AGY_RESETS_URL"]) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
