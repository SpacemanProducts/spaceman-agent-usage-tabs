.pragma library
// Theme-aware usage colors. Stock panels read colors from qs.Commons Color/Style;
// this module keeps the plugin's meter colors (the low/mid/high set and the usage gradient) readable on
// whatever background a theme gives a surface: it picks the bright or deep palette
// by the background's lightness, then verifies WCAG contrast and mixes each color
// toward black or white until it reads. Pure functions so bin/usage-colors.test.mjs
// can run them in node. Panel.qml imports this as UsageColors.

const DARK = { low: "#4caf50", mid: "#f2a900", high: "#e5484d" };   // for dark surfaces
const LIGHT = { low: "#1b7a31", mid: "#9a5b00", high: "#c0262d" };  // for light surfaces
const MIN_CONTRAST = 4.5;   // the meter colors are also small text ("94% used")
const BLACK = { r: 0, g: 0, b: 0 };
const WHITE = { r: 1, g: 1, b: 1 };

// Accepts "#rgb", "#rrggbb", "#aarrggbb" or a QML color {r,g,b,a} (0..1 floats).
// Returns {r,g,b,a} 0..1, or null when unparseable.
function parseColor(c) {
  if (c && typeof c === "object") {
    var r = Number(c.r), g = Number(c.g), b = Number(c.b);
    if (![r, g, b].every(isFinite)) return null;
    return { r: r, g: g, b: b, a: isFinite(Number(c.a)) ? Number(c.a) : 1 };
  }
  var s = String(c || "").trim();
  var m = s.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);
  if (!m) return null;
  var h = m[1];
  if (h.length === 3) h = h.split("").map((x) => x + x).join("");
  if (h.length === 8) { // #aarrggbb
    var a = parseInt(h.slice(0, 2), 16) / 255;
    return { r: parseInt(h.slice(2, 4), 16) / 255, g: parseInt(h.slice(4, 6), 16) / 255, b: parseInt(h.slice(6, 8), 16) / 255, a };
  }
  return { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255, a: 1 };
}

// Alpha-composite fg over bg; both parsed colors.
function composite(fg, bg) {
  var a = fg.a === undefined ? 1 : fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

// Same lightness call the panel always used: perceived brightness > 0.55 is "light".
function isLight(c) {
  var p = parseColor(c);
  if (!p) return false;
  return 0.299 * p.r + 0.587 * p.g + 0.114 * p.b > 0.55;
}

function lin(v) { return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }

// WCAG relative luminance and contrast ratio.
function luminance(c) {
  var p = typeof c === "string" ? parseColor(c) : c;
  if (!p) return 0;
  return 0.2126 * lin(p.r) + 0.7152 * lin(p.g) + 0.0722 * lin(p.b);
}

function contrast(a, b) {
  var x = luminance(a), y = luminance(b);
  var hi = Math.max(x, y), lo = Math.min(x, y);
  return (hi + 0.05) / (lo + 0.05);
}

function toHex(c) {
  var p = typeof c === "string" ? parseColor(c) : c;
  if (!p) return "#000000";
  var h = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
  return "#" + h(p.r) + h(p.g) + h(p.b);
}

function mix(c, target, t) {
  return { r: c.r + (target.r - c.r) * t, g: c.g + (target.g - c.g) * t, b: c.b + (target.b - c.b) * t, a: 1 };
}

function dist(a, b) { return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b); }

function rgbToHsl(c) {
  var max = Math.max(c.r, c.g, c.b), min = Math.min(c.r, c.g, c.b);
  var l = (max + min) / 2, h = 0, s = 0;
  if (max !== min) {
    var d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === c.r) h = ((c.g - c.b) / d + (c.g < c.b ? 6 : 0)) / 6;
    else if (max === c.g) h = ((c.b - c.r) / d + 2) / 6;
    else h = ((c.r - c.g) / d + 4) / 6;
  }
  return { h, s, l };
}

function hslToRgb(hsl) {
  var h = ((hsl.h % 1) + 1) % 1, s = hsl.s, l = hsl.l;
  if (s === 0) return { r: l, g: l, b: l, a: 1 };
  var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  var f = (t) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return { r: f(h + 1 / 3), g: f(h), b: f(h - 1 / 3), a: 1 };
}

// One meter color made readable on bg: keep the hue, mix toward black on light
// surfaces and toward white on dark ones until WCAG contrast passes. The final
// fallback is whichever of black/white reads better — always >= ~4.5:1 on any bg.
function ensure(c, bg) {
  var fg = parseColor(c), back = parseColor(bg);
  if (!fg || !back) return toHex(c);
  if (contrast(fg, back) >= MIN_CONTRAST) return toHex(fg);
  var toward = luminance(back) > 0.18 ? BLACK : WHITE;
  for (var t = 0.1; t <= 1.0001; t += 0.1) {
    var cand = mix(fg, toward, Math.min(1, t));
    if (contrast(cand, back) >= MIN_CONTRAST) return toHex(cand);
  }
  return contrast(BLACK, back) >= contrast(WHITE, back) ? "#000000" : "#ffffff";
}

// Below this RGB distance the three levels stop being tellable apart — the
// signal that a mid-tone background is clashing with every readable option.
const MIN_SEPARATION = 0.12;

// A mid-tone background can force every meter color so dark (or so light) that
// they converge. Rebuild the palette in HSL instead: keep each color's hue and
// push saturation up, then pick the single lightness — dark or light side —
// that reads best on the background while keeping the hues apart.
function clashPalette(set, back) {
  var hsls = [set.low, set.mid, set.high].map((c) => {
    var hsl = rgbToHsl(parseColor(c));
    return { h: hsl.h, s: Math.max(hsl.s, 0.55), l: hsl.l };
  });
  var best = null;
  for (var side = 0; side < 2; side++) {
    for (var l = side === 0 ? 0.1 : 0.9; side === 0 ? l <= 0.36 : l >= 0.64; l += side === 0 ? 0.02 : -0.02) {
      // Each level gets its own lightness slice so the trio stays spread out
      // even when the background forces them all to one extreme.
      var cols = hsls.map((h, i) => hslToRgb({ h: h.h, s: h.s, l: Math.min(0.97, Math.max(0.03, l + (i - 1) * 0.05)) }));
      var minContrast = Math.min.apply(null, cols.map((c) => contrast(c, back)));
      var minSep = Math.min(dist(cols[0], cols[1]), dist(cols[1], cols[2]), dist(cols[0], cols[2]));
      var score = Math.min(minContrast, 4.5) * 2 + minSep;
      if (!best || score > best.score) best = { score, cols, minContrast, minSep };
      if (minContrast >= 4.5 && minSep >= MIN_SEPARATION) return { low: cols[0], mid: cols[1], high: cols[2] };
    }
  }
  return best ? { low: best.cols[0], mid: best.cols[1], high: best.cols[2] } : null;
}

// The palette for one surface. bg may carry alpha (popup surfaces do); `under`
// is what sits behind it (the shell background) for compositing. `light` keeps
// the old light/dark call so celebration palettes can keep keying off it.
function palette(bg, under) {
  var back = parseColor(bg);
  var fallback = parseColor(under) || BLACK;
  if (back && back.a !== undefined && back.a < 1) back = composite(back, fallback);
  if (!back) back = fallback;
  var set = isLight(back) ? LIGHT : DARK;
  var cols = [ensure(set.low, back), ensure(set.mid, back), ensure(set.high, back)].map(parseColor);
  var sep = Math.min(dist(cols[0], cols[1]), dist(cols[1], cols[2]), dist(cols[0], cols[2]));
  if (sep < MIN_SEPARATION) {
    var rebuilt = clashPalette(set, back);
    if (rebuilt) cols = [rebuilt.low, rebuilt.mid, rebuilt.high];
  }
  return { light: isLight(back), low: toHex(cols[0]), mid: toHex(cols[1]), high: toHex(cols[2]), bg: toHex(back) };
}

// The bands every rule keys off (unchanged): > 85% high, >= 60% mid, else low.
// Only the displayed color is continuous now; use this for decisions.
function levelOf(p) {
  return p > 0.85 ? "high" : (p >= 0.6 ? "mid" : "low");
}

// The displayed meter color: one smooth HSL gradient, hue 120 (green) at 0%
// down to hue 0 (red) at 100%. Saturation and lightness are fixed per surface,
// so every percentage has its own color. The dark pair is bright enough that
// every hue reads on the dark themes; the light pair is deep enough for yellow
// to read on white.
var GRADIENT_DARK = { s: 0.80, l: 0.71 };
var GRADIENT_LIGHT = { s: 0.90, l: 0.22 };

function usageHue(p) {
  var x = Number(p);
  if (!isFinite(x)) x = 0;
  return 120 * (1 - Math.min(1, Math.max(0, x)));
}

// `pal` is a palette() result: its bg decides the pair, and ensure() only steps
// in on an unusual background where the fixed pair would not read.
function gradient(p, pal) {
  var light = !!(pal && pal.light);
  var g = light ? GRADIENT_LIGHT : GRADIENT_DARK;
  var color = toHex(hslToRgb({ h: usageHue(p) / 360, s: g.s, l: g.l }));
  return pal && pal.bg ? ensure(color, pal.bg) : color;
}

// The name Panel.qml has always called for a meter's color.
function forLevel(p, pal) {
  return gradient(p, pal);
}
