import assert from "node:assert/strict";
import { planLoginNotices, isHidden, planInstallNotices } from "./login-watch.mjs";
const A = (id, signedIn, installed = true) => ({ id, name: id.toUpperCase(), signedIn, installed });

// isHidden: a manual hide counts only while installed; uninstalled follows the switch.
assert.equal(isHidden(A("amp", true), { hiddenAgents: ["amp"] }), true);
assert.equal(isHidden(A("amp", true), { hiddenAgents: [] }), false);
assert.equal(isHidden(A("amp", null, false), { hiddenAgents: [], hideUninstalled: true }), true, "uninstalled + switch on");
assert.equal(isHidden(A("amp", null, false), { hiddenAgents: [], hideUninstalled: false }), false, "uninstalled + switch off");
assert.equal(isHidden(A("amp", null, false), { hiddenAgents: ["amp"], hideUninstalled: false }), false, "a stale manual hide on an uninstalled agent is ignored");

// First run: silent baseline, even for hidden signed-in agents.
let r = planLoginNotices([A("claude", true), A("amp", true)], { hiddenAgents: ["amp"] }, null);
assert.deepEqual(r.notify, []); assert.deepEqual(r.seen, { claude: true, amp: true });

// Later: a hidden agent signs in for the first time -> exactly one notice.
r = planLoginNotices([A("claude", true), A("kiro", true)], { hiddenAgents: ["kiro"] }, r.seen);
assert.deepEqual(r.notify.map((a) => a.id), ["kiro"]);
// ...and never again.
r = planLoginNotices([A("kiro", true)], { hiddenAgents: ["kiro"] }, r.seen); assert.deepEqual(r.notify, []);
// Signing out and back in later does not re-notify.
r = planLoginNotices([A("kiro", false)], { hiddenAgents: ["kiro"] }, r.seen); r = planLoginNotices([A("kiro", true)], { hiddenAgents: ["kiro"] }, r.seen); assert.deepEqual(r.notify, []);

// A visible agent signing in needs no notice (its tab simply shows); it is still recorded.
r = planLoginNotices([A("codex", true)], { hiddenAgents: [] }, { claude: true });
assert.deepEqual(r.notify, []); assert.equal(r.seen.codex, true);
// Not signed in / unknown login concept: nothing, nothing recorded.
r = planLoginNotices([A("copilot", false), A("opencode", null)], { hiddenAgents: ["copilot", "opencode"] }, {});
assert.deepEqual(r.notify, []); assert.deepEqual(r.seen, {});
// Hidden because uninstalled never notifies until it is installed and signed in while hidden by the user.
assert.deepEqual(planLoginNotices([A("hermes", true, false)], { hideUninstalled: true }, {}).notify.map((a) => a.id), ["hermes"], "a login on an uninstalled-hidden agent is still announced once");
// Corrupt seen file behaves like a first run.
assert.deepEqual(planLoginNotices([A("amp", true)], { hiddenAgents: ["amp"] }, "junk").notify, []);
assert.deepEqual(planLoginNotices(null, {}, {}), { notify: [], seen: {} });

// Install notices
const ag = (id, installed) => ({ id, name: id.toUpperCase(), installed });
let n = planInstallNotices([ag("amp", false), ag("claude", true)], [ag("amp", true), ag("claude", true)], { hiddenAgents: [], hideUninstalled: true }, {});
assert.deepEqual(n.notify.map((a) => a.id), ["amp"], "uninstalled -> installed announces once"); assert.equal(n.notified.amp, true);
assert.deepEqual(planInstallNotices([ag("amp", false)], [ag("amp", true)], { hideUninstalled: true }, n.notified).notify, [], "already announced");
assert.deepEqual(planInstallNotices([ag("amp", true)], [ag("amp", true)], {}, {}).notify, [], "was already installed");
assert.deepEqual(planInstallNotices([ag("amp", false)], [ag("amp", false)], {}, {}).notify, [], "still not installed");
assert.deepEqual(planInstallNotices([], [ag("amp", true)], {}, {}).notify, [], "first run: no previous data");
assert.deepEqual(planInstallNotices(null, [ag("amp", true)], {}, null).notify, []);
assert.deepEqual(planInstallNotices([ag("amp", false)], [ag("amp", true)], { hiddenAgents: [], hideUninstalled: false }, {}).notify, [], "switch off: tab was already showing");
assert.deepEqual(planInstallNotices([ag("amp", false)], [ag("amp", true)], { hiddenAgents: ["amp"], hideUninstalled: true }, {}).notify, [], "user hid it on purpose: stays hidden, no notice");
assert.deepEqual(planInstallNotices([{ id: "amp" }], [ag("amp", true)], {}, {}).notify, [], "old data without an installed flag is not a flip");
console.log("login-watch: all tests passed");
