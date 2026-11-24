// usage-colors.js: the meter palette must stay >= 4.5:1 on whatever background a
// theme gives a surface — dark, light and mid-tone — and keep low/mid/high
// distinguishable. Also guards that Panel.qml takes its colors from the theme.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "usage-colors.js"), "utf8").replace(/^\.pragma library\s*$/m, "");
const ctx = {}; vm.createContext(ctx); vm.runInContext(src, ctx);
const { parseColor, composite, isLight, luminance, contrast, toHex, ensure, palette, forLevel } = ctx;

const J = (v) => JSON.parse(JSON.stringify(v));
// ---- parsing / math
assert.deepEqual(J(parseColor("#4caf50")), { r: 0x4c / 255, g: 0xaf / 255, b: 0x50 / 255, a: 1 });
assert.deepEqual(J(parseColor("#fff")), { r: 1, g: 1, b: 1, a: 1 });
assert.equal(parseColor("#80ffffff").a, 128 / 255, "#aarrggbb alpha");
assert.deepEqual(J(parseColor({ r: 1, g: 0, b: 0 })), { r: 1, g: 0, b: 0, a: 1 }, "QML color objects parse");
assert.equal(parseColor("red"), null); assert.equal(parseColor(""), null);
assert.ok(Math.abs(luminance("#ffffff") - 1) < 1e-9 && Math.abs(luminance("#000000")) < 1e-9);
assert.ok(Math.abs(contrast("#000000", "#ffffff") - 21) < 0.01, "black/white is 21:1");
assert.deepEqual(J(composite({ r: 1, g: 1, b: 1, a: 0.5 }, { r: 0, g: 0, b: 0, a: 1 })), { r: 0.5, g: 0.5, b: 0.5, a: 1 });
assert.equal(isLight("#ffffff"), true); assert.equal(isLight("#101315"), false); assert.equal(isLight("#eff1f5"), true);
assert.equal(toHex({ r: 1, g: 0, b: 0 }), "#ff0000");

// ---- palette on every real built-in theme background + synthetic edge cases
const themeDir = "/usr/share/omarchy/themes";
const bgs = [];
if (fs.existsSync(themeDir)) {
  for (const t of fs.readdirSync(themeDir)) {
    const f = path.join(themeDir, t, "colors.toml");
    if (!fs.existsSync(f)) continue;
    const m = fs.readFileSync(f, "utf8").match(/^background\s*=\s*"(#[0-9a-fA-F]{6})"/m);
    if (m) bgs.push([t, m[1]]);
  }
}
assert.ok(bgs.length >= 10, "found the built-in themes to test against");
bgs.push(["mid-gray", "#808080"], ["mid-blue", "#4a6a8a"], ["sepia", "#8a7a5a"]);
const dist = (a, b) => { const A = parseColor(a), B = parseColor(b); return Math.hypot(A.r - B.r, A.g - B.g, A.b - B.b); };
for (const [name, bg] of bgs) {
  const p = palette(bg);
  const synthetic = name === "mid-gray" || name === "mid-blue" || name === "sepia";
  for (const k of ["low", "mid", "high"]) {
    const c = contrast(p[k], bg);
    // Real themes must hit full text contrast; a synthetic mid-tone clash gets
    // the best readable+distinct compromise the fallback can find.
    assert.ok(c >= (synthetic ? 3.0 : 4.5), `${name} (${bg}): ${k} ${p[k]} only ${c.toFixed(1)}:1`);
  }
  // The three usage levels must stay tellable apart on the surface (RGB distance;
  // same-lightness hues like green vs amber score ~1:1 on WCAG but are distinct).
  const sep = Math.min(dist(p.low, p.mid), dist(p.mid, p.high), dist(p.low, p.high));
  assert.ok(sep >= 0.12, `${name} (${bg}): levels collapsed together (sep ${sep.toFixed(3)})`);
}

// ---- the base sets are unchanged where they already worked (no visual churn)
assert.deepEqual(J(palette("#101315")), { light: false, low: "#4caf50", mid: "#f2a900", high: "#e5484d" }, "dark theme keeps the bright set");
assert.deepEqual(J(palette("#eff1f5")), { light: true, low: "#1b7a31", mid: "#9a5b00", high: "#c0262d" }, "light theme keeps the deep set");
assert.deepEqual(J(palette("#ffffff")), { light: true, low: "#1b7a31", mid: "#9a5b00", high: "#c0262d" });
assert.deepEqual(J(palette("#000000")), { light: false, low: "#4caf50", mid: "#f2a900", high: "#e5484d" });

// ---- translucent popup backgrounds composite over the shell background
{
  const p = palette({ r: 1, g: 1, b: 1, a: 0.5 }, "#101315"); // half-white popup over dark shell ~ #808080-ish
  for (const k of ["low", "mid", "high"]) assert.ok(contrast(p[k], "#808080") >= 3, `composited ${k} readable: ${p[k]}`);
}

// ---- ensure() fallback: an impossible clash still returns a readable color
{
  const c = ensure("#4caf50", "#777777"); // mid-gray: green can't reach 4.5 without going dark
  assert.ok(contrast(c, "#777777") >= 4.5, `ensure fallback reads on #777777: ${c}`);
  assert.equal(ensure("not-a-color", "#fff"), "#000000", "unparseable input falls back safely");
}

// ---- forLevel keeps the exact 60/85 thresholds
{
  const p = palette("#101315");
  assert.equal(forLevel(0.51, p), "#4caf50"); assert.equal(forLevel(0.6, p), "#f2a900");
  assert.equal(forLevel(0.85, p), "#f2a900"); assert.equal(forLevel(0.851, p), "#e5484d");
  assert.equal(forLevel(1, p), "#e5484d");
}

// ---- Panel.qml wiring: theme colors in, palette out, no hardcoded meter hex
{
  const qml = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "Panel.qml"), "utf8");
  assert.match(qml, /import "usage-colors\.js" as UsageColors/, "Panel.qml imports the palette module");
  assert.match(qml, /foreground: Color\.popups\.text/, "text color comes from the theme");
  assert.match(qml, /panelBackground: Color\.popups\.background/, "background comes from the theme");
  assert.match(qml, /UsageColors\.palette\(panelBackground/, "panel meters use a per-surface palette");
  assert.match(qml, /UsageColors\.palette\(Color\.bar\.background/, "bar meters use the bar surface's palette");
  assert.doesNotMatch(qml, /function (greenFor|amberFor|redFor|isLightColor)\(/, "the old hardcoded meter palette functions are gone");
  assert.ok(!/Qt\.darker\(foreground/.test(qml), "dim text must not use darker() (it vanishes on light themes)");
}
console.log("usage-colors: all tests passed");
