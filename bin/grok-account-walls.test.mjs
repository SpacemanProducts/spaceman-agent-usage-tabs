import assert from "node:assert/strict";
import { grokWalls } from "./grok-account-walls.mjs";

const cap = { title: "Free grok-4.7 (24 h)", cap: true, percent: 1 };
const bill = { title: "Weekly", percent: 0.4 };
const reg = { active: "main", accounts: [
  { id: "main", label: "Main", primary: true, active: true, home: "/h/.grok", login: "/h/.grok" },
  { id: "work", label: "Work", home: "/state/accounts/grok/work", login: "/state/accounts/grok/work" },
  { id: "idle", label: "Idle", home: "/state/accounts/grok/idle" },
] };
const homes = [];
const run = (home) => { homes.push(home); return { limits: home.includes("work") ? [cap, bill] : [] }; };

// The seated account is skipped (its wall comes from the primary run); only
// cap rows are kept — billing meters belong to Omarchy's record.
assert.deepEqual(grokWalls(reg, { primaryHome: "/h/.grok", homeDir: "/h", run }), { work: [cap] });
assert.deepEqual(homes, ["/state/accounts/grok/work", "/state/accounts/grok/idle"], "every non-seated home is checked");

// No registry, no run calls, empty result.
assert.deepEqual(grokWalls(null, { run }), {});
assert.deepEqual(grokWalls(reg, { primaryHome: "/h/.grok", homeDir: "/h" }), {}, "no run: nothing to report");

// A login pointing back at the primary home is the seated account even if its
// own home field differs.
const swapped = { accounts: [{ id: "a", home: "/state/a", login: "/h/.grok" }, { id: "b", home: "/state/b" }] };
const seen = [];
assert.deepEqual(grokWalls(swapped, { primaryHome: "/h/.grok", run: (h) => { seen.push(h); return { limits: [cap] }; } }), { b: [cap] });
assert.deepEqual(seen, ["/state/b"]);

// ~ expands against the caller's home dir.
const tilde = { accounts: [{ id: "t", home: "~/.grok-work" }] };
grokWalls(tilde, { primaryHome: "/elsewhere", homeDir: "/h", run: (h) => { assert.equal(h, "/h/.grok-work"); return { limits: [cap] }; } });
console.log("grok-account-walls: all tests passed");
