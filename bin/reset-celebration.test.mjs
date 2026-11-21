import assert from "node:assert/strict";
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { applyResets, resetNotice, resetNotifyArgs, FLASH_MS } from "./reset-celebration.mjs";
const A = (id, session, extra = {}) => ({ id, name: id.toUpperCase(), installed: true, limits: [{ title: "Session", percent: session }], ...extra });

assert.deepEqual(resetNotice({ name: "Claude Code" }, ["Session"]), { title: "Claude Code reset. Go cook.", body: "\u{1F4B8} Session limit reset" });
assert.equal(resetNotice({ name: "X" }, ["Session", "Weekly"]).body, "\u{1F4B8} Session and Weekly limits reset");
const args = resetNotifyArgs({ title: "T", body: "B" }, "/p/cash-burst.svg");
assert.deepEqual(args.slice(-2), ["T", "B"], "title then body last");
assert.ok(args.includes("string:image-path:/p/cash-burst.svg"), "the cash-burst picture is attached");
assert.ok(args.includes("boolean:suppress-sound:true"), "the daemon stays silent; the cha-ching is played by us");
assert.equal(resetNotifyArgs({ title: "T", body: "B" }, "").some((a) => String(a).includes("image-path")), false, "no image path, no hint");
// the bundled picture exists and is a valid SVG; the panel's test notification uses it too
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
assert.ok(fs.readFileSync(path.join(root, "notify", "cash-burst.svg"), "utf8").startsWith("<svg"), "cash-burst.svg is bundled");
assert.ok(fs.readFileSync(path.join(root, "Panel.qml"), "utf8").includes("notify/cash-burst.svg"), "the panel's Test celebration notification uses the picture");

// A big drop: flagged, noticed once.
const sent = []; const now = 1_000_000;
let agents = [A("claude", 0.03), A("grok", 0.5)];
applyResets(agents, [A("claude", 0.95), A("grok", 0.5)], (a, w) => sent.push([a.id, w]), now);
assert.deepEqual(sent, [["claude", ["Session"]]]); assert.equal(agents[0].resetAt, now); assert.deepEqual(agents[0].resetWindows, ["Session"]); assert.equal(agents[1].resetAt, undefined);

// A refresh inside the flash keeps it alive without a second notice.
const prev = agents; agents = [A("claude", 0.04)];
applyResets(agents, prev, (a) => sent.push(a.id), now + 4000);
assert.equal(sent.length, 1); assert.equal(agents[0].resetAt, now); assert.deepEqual(agents[0].resetWindows, ["Session"]);
// After it has expired it is gone.
agents = [A("claude", 0.05)]; applyResets(agents, prev, () => sent.push("x"), now + FLASH_MS + 5001);
assert.equal(agents[0].resetAt, undefined); assert.equal(sent.length, 1);
// No previous data / junk: nothing.
agents = [A("claude", 0)]; applyResets(agents, null, () => sent.push("y"), now); assert.equal(sent.length, 1); assert.equal(agents[0].resetAt, undefined);
applyResets(null, [], () => {}); applyResets([], undefined, () => {});

// WIRING GUARD: the collector must actually call the features it advertises.
// (A refactor once deleted the celebration block and nothing noticed.)
const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "collect.mjs"), "utf8");
for (const needle of ["applyResets(agents, prev?.agents", "resetNotifyArgs(", "resetNotice(", "playSound(SOUND_VOLUME)", "planLoginNotices(agents", "planInstallNotices(prev?.agents", "notifyHighUsage(agents)", "diag.flush()", "planLimitsOnly(out.limits)", "buildModels({"])
  assert.ok(src.includes(needle), `collect.mjs no longer calls: ${needle}`);
console.log("reset-celebration: all tests passed");
