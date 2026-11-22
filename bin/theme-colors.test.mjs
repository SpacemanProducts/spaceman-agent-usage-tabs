// Guards the theme work: the meter palettes in Panel.qml must stay readable (>= 4.5:1) on the
// backgrounds they are used on, and the panel must take its colors from the theme, not fixed values.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const qml = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "Panel.qml"), "utf8");
const lin = (c) => (c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const lum = (h) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const pal = (fn) => ["greenFor", "amberFor", "redFor"].map((f) => qml.match(new RegExp(`function ${f}\\(light\\) \\{ return light \\? "(#\\w{6})" : "(#\\w{6})" \\}`))).map((m) => (assert.ok(m, "palette function missing"), fn === "light" ? m[1] : m[2]));
for (const bg of ["#ffffff", "#eff1f5", "#fffcf0"]) for (const c of pal("light")) assert.ok(contrast(c, bg) >= 4.5, `light ${c} on ${bg}: ${contrast(c, bg).toFixed(1)}`);
for (const bg of ["#101315", "#060b1e"]) for (const c of pal("dark")) assert.ok(contrast(c, bg) >= 4.5, `dark ${c} on ${bg}: ${contrast(c, bg).toFixed(1)}`);
assert.match(qml, /foreground: Color\.popups\.text/, "text color comes from the theme");
assert.match(qml, /panelBackground: Color\.popups\.background/, "background comes from the theme");
assert.ok(!/Qt\.darker\(foreground/.test(qml), "dim text must not use darker() (it vanishes on light themes)");
console.log("theme-colors: all tests passed");
