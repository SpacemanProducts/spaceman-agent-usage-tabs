import assert from "node:assert/strict";
import { parseAmpUsage } from "./amp-usage.mjs";
// What `amp usage --details` printed (email scrubbed): only the token total is taken; the credit balance and the dollar cost are never read
const real = `# Usage

Signed in as [email]
**Individual credits:** $9.59 remaining (set up auto-reload to avoid running out) - https://ampcode.com/settings

Range: 2026-11-15T11:27:17.269Z to 2026-11-22T11:27:17.269Z (end exclusive; trailing 7 days)
Total Orb runtime: 0.000s (0 ms)
Total tokens: 50,942
Total recorded cost: $0.40
`;
const r = parseAmpUsage(real);
assert.equal(r.tokens, 50942); assert.equal(r.status, "Last 7 days: 50.9K tokens (from `amp usage`).");
assert.ok(!/\$|credit|cost/i.test(r.status), "no money in what is shown");
assert.equal(parseAmpUsage("Total tokens: 1,234,567\nRange: 2026-11-01T00:00:00Z to 2026-11-04T00:00:00Z").status, "Last 3 days: 1.2M tokens (from `amp usage`).");
assert.equal(parseAmpUsage("Total tokens: 12\n").status, "Last 7 days: 12 tokens (from `amp usage`).");
assert.deepEqual(parseAmpUsage("not signed in"), { tokens: null, status: "" }); assert.deepEqual(parseAmpUsage(null), { tokens: null, status: "" });
console.log("amp-usage: all tests passed");
