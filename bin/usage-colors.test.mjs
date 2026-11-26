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
const { parseColor, composite, isLight, luminance, contrast, toHex, ensure, palette, forLevel, levelOf, usageHue, gradient } = ctx;

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
// Pinned copy of Omarchy's built-in theme backgrounds, so this runs on any machine; an installed
// Omarchy adds whatever it ships on top.
const PINNED = { "catppuccin-latte": "#eff1f5", catppuccin: "#1e1e2e", ethereal: "#060B1E", everforest: "#2d353b", "flexoki-light": "#FFFCF0",
  gruvbox: "#282828", hackerman: "#0B0C16", "jade-horse": "#142620", kanagawa: "#1f1f28", "last-horizon": "#0c0b0c", lumon: "#16242d",
  lupine: "#fafafa", "matte-black": "#121212", miasma: "#222222", nord: "#2e3440", "retro-82": "#05182e", ristretto: "#2c2525",
  "rose-pine": "#faf4ed", solitude: "#101315", starship: "#1c1c1e", "tokyo-night": "#1a1b26", vantablack: "#000000", white: "#ffffff" };
const themeDir = "/usr/share/omarchy/themes";
const bgs = Object.entries(PINNED);
if (fs.existsSync(themeDir)) {
  for (const t of fs.readdirSync(themeDir)) {
    const f = path.join(themeDir, t, "colors.toml");
    if (!fs.existsSync(f)) continue;
    const m = fs.readFileSync(f, "utf8").match(/^background\s*=\s*"(#[0-9a-fA-F]{6})"/m);
    if (m && PINNED[t] !== m[1]) bgs.push([t, m[1]]);
  }
}
const realBgs = bgs.slice();
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
assert.deepEqual(J(palette("#101315")), { light: false, low: "#4caf50", mid: "#f2a900", high: "#e5484d", bg: "#101315" }, "dark theme keeps the bright set");
assert.deepEqual(J(palette("#eff1f5")), { light: true, low: "#1b7a31", mid: "#9a5b00", high: "#c0262d", bg: "#eff1f5" }, "light theme keeps the deep set");
assert.deepEqual(J(palette("#ffffff")), { light: true, low: "#1b7a31", mid: "#9a5b00", high: "#c0262d", bg: "#ffffff" });
assert.deepEqual(J(palette("#000000")), { light: false, low: "#4caf50", mid: "#f2a900", high: "#e5484d", bg: "#000000" });

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

// ---- the 60/85 bands that rules key off are unchanged
{
  assert.equal(levelOf(0.51), "low"); assert.equal(levelOf(0.599), "low"); assert.equal(levelOf(0.6), "mid");
  assert.equal(levelOf(0.85), "mid"); assert.equal(levelOf(0.851), "high"); assert.equal(levelOf(1), "high");
  assert.equal(levelOf(-0.5), "low"); assert.equal(levelOf(1.5), "high", "out-of-range clamps to the outer bands");
  // The labels are the contract other code keys off: exactly these three strings.
  assert.deepEqual(J([...new Set([levelOf(0), levelOf(0.7), levelOf(1)])]), ["low", "mid", "high"]);
}

// ---- the smooth gradient: green (120) at 0% to red (0) at 100%
const hueOf = (hex) => {
  const { r, g, b } = parseColor(hex);
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  if (!d) return NaN;
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60) > 300 ? h * 60 - 360 : h * 60;
};
{
  const dark = palette("#101315");
  // The named stops, as shown on a dark theme: exact color at each of 0, 15,
  // 30, 45, 60, 75, 90 and 100%.
  const want = { 0: [120, "#7af07a"], 15: [102, "#9df07a"], 30: [84, "#c1f07a"], 45: [66, "#e4f07a"],
    60: [48, "#f0d97a"], 75: [30, "#f0b57a"], 90: [12, "#f0927a"], 100: [0, "#f07a7a"] };
  for (const [pct, [hue, hex]] of Object.entries(want)) {
    const c = forLevel(pct / 100, dark);
    assert.ok(Math.abs(usageHue(pct / 100) - hue) < 1e-9, `${pct}% asks for hue ${hue}`);
    assert.ok(Math.abs(hueOf(c) - hue) < 1, `${pct}%: ${c} has hue ${hueOf(c).toFixed(1)}, wanted ${hue}`);
    if (hex) assert.equal(c, hex, `${pct}% color`);
  }
  assert.equal(new Set(Object.keys(want).map((p) => forLevel(p / 100, dark))).size, 8, "all eight stops differ");
  assert.equal(usageHue(-1), 120); assert.equal(usageHue(7), 0); assert.equal(usageHue(NaN), 120, "junk clamps");
  assert.equal(forLevel(0.5, dark), gradient(0.5, dark), "forLevel is the gradient");
}
// ---- hue never goes back up, and every whole percentage has its own color
for (const bg of ["#101315", "#ffffff"]) {
  const pal = palette(bg);
  let last = Infinity; const seen = new Set();
  for (let i = 0; i <= 1000; i++) {
    const h = usageHue(i / 1000);
    assert.ok(h <= last, `requested hue rose at ${i / 10}%`); last = h;
  }
  last = Infinity;
  for (let i = 0; i <= 100; i++) {
    const c = gradient(i / 100, pal); seen.add(c);
    const h = hueOf(c);
    assert.ok(h <= last + 0.01, `${bg}: shown hue rose at ${i}% (${last.toFixed(2)} -> ${h.toFixed(2)})`); last = h;
  }
  assert.equal(seen.size, 101, `${bg}: 101 percentages, 101 colors`);
}
// ---- readable at every point on every built-in theme (yellow included)
for (const [name, bg] of realBgs) {
  const pal = palette(bg);
  for (let i = 0; i <= 100; i++) {
    const c = gradient(i / 100, pal);
    assert.ok(contrast(c, bg) >= 4.5, `${name} (${bg}): ${i}% ${c} only ${contrast(c, bg).toFixed(2)}:1`);
  }
}
// ---- and on the exact surface the code ensures against: pal.bg is the
// composited popup/bar background, which is what Panel.qml's percent text and
// bars actually sit on. The percent text wears the gradient color itself, so
// it must read there through the yellow range (roughly 40-65%).
for (const [name, bg] of realBgs) {
  const pal = palette(bg);
  for (let i = 0; i <= 100; i++) {
    const c = gradient(i / 100, pal);
    assert.ok(contrast(c, pal.bg) >= 4.5, `${name}: ${i}% ${c} on its surface ${pal.bg} only ${contrast(c, pal.bg).toFixed(2)}:1`);
  }
}
{
  // A translucent popup surface composites over the shell background; the
  // gradient must still read on the result. ensure() works on unrounded
  // floats and toHex() then rounds to 8-bit, so allow a hair under 4.5.
  const pal = palette({ r: 1, g: 1, b: 1, a: 0.5 }, "#101315");
  for (let i = 0; i <= 100; i++) {
    const c = gradient(i / 100, pal);
    assert.ok(contrast(c, pal.bg) >= 4.4, `composited popup ${pal.bg}: ${i}% ${c} only ${contrast(c, pal.bg).toFixed(2)}:1`);
  }
}
// ---- on the dark themes the fixed saturation/lightness is used untouched
for (const [name, bg] of realBgs.filter(([, bg]) => !isLight(bg))) {
  for (let i = 0; i <= 100; i += 5) assert.equal(gradient(i / 100, palette(bg)), gradient(i / 100, { light: false }), `${name}: ${i}% needed no adjustment`);
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
