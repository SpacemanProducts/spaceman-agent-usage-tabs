import assert from "node:assert/strict";
import { buildAccounts } from "./accounts.mjs";
const acc = (id, signedIn, extra = {}) => ({ id, label: id.toUpperCase(), plan: "Pro", email: "x@y.z", org: "o", home: "/h", active: id === "a", signedIn,
  limits: [{ label: "Session (5-hour)", percent: 0.5, resetsAt: "t" }, { label: "Weekly (7-day)", percent: 0.2 }], ...extra });
const r = buildAccounts([{ provider: "claude", accounts: [acc("a", true), acc("b", true)] }, { provider: "codex", accounts: [acc("a", true)] }, { provider: "grok", accounts: [acc("a", true), acc("b", false)] }]);
assert.deepEqual(Object.keys(r), ["claude"], "only providers with 2+ signed-in accounts");
assert.equal(r.claude.length, 2);
assert.deepEqual(r.claude[0], { id: "a", label: "A", plan: "Pro", active: true, limits: [{ title: "Session", percent: 0.5, resetsAt: "t" }, { title: "Weekly", percent: 0.2, resetsAt: "" }] });
assert.ok(!JSON.stringify(r).match(/x@y|"org"|"home"/), "no email, org or path leaks");
assert.deepEqual(buildAccounts(null), {});
console.log("accounts: all tests passed");
