// The SCORECARD section on Constance's screen: per-agent reviewed-job stats
// plus the "Use it or lose it" switch (constanceUseItOrLoseIt in settings.json).
// Source-level checks, same style as the other Panel.qml tests.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applySetting, ALLOWED } from "./settings-set.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const qml = fs.readFileSync(path.join(here, "..", "Panel.qml"), "utf8");

assert.ok(qml.includes('text: "SCORECARD"'), "SCORECARD header exists");
assert.match(qml, /readonly property var constanceScorecard: constanceBoard\.scorecard/, "constanceScorecard property exists");
assert.match(qml, /readonly property bool constanceSpareOn: userSettings\.constanceUseItOrLoseIt/, "constanceSpareOn property exists");
assert.ok(qml.includes('root.writeSetting(["constanceUseItOrLoseIt", String(!root.constanceSpareOn)])'), "toggle writes constanceUseItOrLoseIt");
assert.ok(qml.includes('text: "Use it or lose it"'), "toggle label exists");
assert.ok(qml.includes("No reviewed jobs yet."), "empty-rows line exists");
assert.ok(qml.includes("id: spareToggle") && qml.includes("id: spareText") && qml.includes("id: spareArea"), "toggle ids are unique");

const opens = (qml.match(/\{/g) || []).length;
const closes = (qml.match(/\}/g) || []).length;
assert.equal(opens, closes, "Panel.qml braces are balanced");

// settings-set accepts the new key and round-trips it as a boolean.
assert.ok(ALLOWED.includes("constanceUseItOrLoseIt"), "constanceUseItOrLoseIt is an allowed setting");
assert.deepEqual(JSON.parse(JSON.stringify(applySetting({}, "constanceUseItOrLoseIt", "true"))), { constanceUseItOrLoseIt: true });
assert.deepEqual(JSON.parse(JSON.stringify(applySetting({}, "constanceUseItOrLoseIt", "false"))), { constanceUseItOrLoseIt: false });
assert.throws(() => applySetting({}, "constanceUseItOrLoseIt", "yes"), /true or false/);

console.log("constance-scorecard-panel: all tests passed");
