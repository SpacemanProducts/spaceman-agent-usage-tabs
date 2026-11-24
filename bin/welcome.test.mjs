// The first-run welcome screen: a sub-view like the others, shown once until
// "Got it" writes welcomeDismissed into settings.json. Source-level checks,
// same style as the other Panel.qml tests.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applySetting, ALLOWED } from "./settings-set.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const qml = fs.readFileSync(path.join(here, "..", "Panel.qml"), "utf8");

assert.ok(qml.includes("property bool welcomeOpen"), "welcomeOpen property exists");
assert.match(qml, /subView: squadOpen \|\| addOpen \|\| settingsOpen \|\| agentHereOpen \|\| constanceOpen \|\| welcomeOpen/, "welcome counts as a sub-view");
assert.match(qml, /leaveSubView\(\) \{[^}]*welcomeOpen = false/, "Back closes the welcome view");
assert.match(qml, /function maybeShowWelcome\(\)[\s\S]*?settingsLoaded[\s\S]*?welcomeDismissed === true[\s\S]*?autoOpened[\s\S]*?welcomeOpen = true/, "maybeShowWelcome gates on settings loaded, not dismissed, user-opened, no other sub-view");
assert.match(qml, /function dismissWelcome\(\) \{ writeSetting\(\["welcomeDismissed", "true"\]\); welcomeOpen = false \}/, "Got it persists the dismissal");
assert.match(qml, /settingsLoaded = true[\s\S]*?maybeShowWelcome/, "settings load triggers the welcome check");
assert.match(qml, /onOpenedChanged:[\s\S]*?maybeShowWelcome/, "panel open triggers the welcome check");
assert.match(qml, /id: welcomeView[\s\S]*?visible: root\.welcomeOpen/, "welcomeView binds to welcomeOpen");
assert.ok(qml.includes('text: "Got it"'), "dismiss button label");
assert.equal((qml.match(/modelData\.t/g) || []).length >= 3, true, "three tips rendered from the model");
assert.match(qml, /name === "welcome"\) root\.welcomeOpen = true/, "view(welcome) IPC hook for screenshots/tests");
assert.match(qml, /root\.welcomeOpen \? "Welcome"/, "header title shows Welcome");

// settings-set accepts the new key and round-trips it.
assert.ok(ALLOWED.includes("welcomeDismissed"), "welcomeDismissed is an allowed setting");
assert.deepEqual(JSON.parse(JSON.stringify(applySetting({}, "welcomeDismissed", "true"))), { welcomeDismissed: true });
assert.throws(() => applySetting({}, "welcomeDismissed", "yes"), /true or false/);

console.log("welcome: all tests passed");
