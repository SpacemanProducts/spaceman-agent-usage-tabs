import assert from "node:assert/strict";
import { stripAds } from "./freebuff-ads.mjs";

// Sample shapes are guesses at Freebuff/Codebuff's sponsor output (no live sample was
// available); the module only acts on clearly-marked lines and ruled-off blocks.
const REAL = [
  "Freebuff 0.9.1",
  "> fix the flaky test in src/parser.mjs",
  "Reading src/parser.mjs ...",
  "Applied 2 edits, 14 tests pass.",
].join("\n");

// 1. No ads: byte-identical, ANSI codes and all.
const styled = "\u001b[32mAll good\u001b[0m — load average 0.42, bad -> worse\nsecond line";
assert.equal(stripAds(REAL), REAL);
assert.equal(stripAds(styled), styled);
assert.equal(stripAds(""), "");
assert.equal(stripAds("no trailing newline"), "no trailing newline");

// 2. Banner line + separator rules in the middle.
const mid = [
  "before",
  "──────────────────────────────",
  "Sponsored by Acme Tools — try https://acme.example",
  "──────────────────────────────",
  "after",
].join("\n");
assert.equal(stripAds(mid), "before\nafter");

// 3. Whole-line "Ad" banner with promo link line.
const banner = ["start", "┌─────────────┐", "│      Ad      │", "│ https://freebuff.com/go │", "└─────────────┘", "end"].join("\n");
assert.equal(stripAds(banner), "start\nend");

// 4. Bordered box with copy text: frame rule removes the whole box.
const box = [
  "agent output line",
  "╔══════════════════════════╗",
  "║  Sponsored message       ║",
  "║  Some ad copy text here  ║",
  "║  https://codebuff.com/x  ║",
  "╚══════════════════════════╝",
  "more output",
].join("\n");
assert.equal(stripAds(box), "agent output line\nmore output");

// 5. ANSI-wrapped ad is still caught; kept lines keep their escapes.
const ansiAd = "kept \u001b[31mred\u001b[0m\n\u001b[33mSponsored\u001b[0m by someone\nplain after";
assert.equal(stripAds(ansiAd), "kept \u001b[31mred\u001b[0m\nplain after");

// 6. Ad at the very start and very end.
const edges = ["Sponsored: hello", "real line 1", "real line 2", "Advertisement"].join("\n");
assert.equal(stripAds(edges), "real line 1\nreal line 2");

// 7. A promo URL on its own line is removed even without other markers.
const link = "output\nhttps://freebuff.com/redeem?x=1\nmore";
assert.equal(stripAds(link), "output\nmore");

// 8. Ordinary text that merely mentions the product or uses 'ad'-like words survives.
const tricky = [
  "Loading config ... done",
  "Bad load on parser test, fixed it.",
  "See https://codebuff.com/docs for the API reference.",
  "This line mentions freebuff.com in passing but is real output.",
].join("\n");
assert.equal(stripAds(tricky), tricky);

// 9. A promo URL inside an ad cluster is absorbed with it.
const cluster = ["top", "── Sponsored ──", "Visit https://codebuff.com/promo now", "bottom"].join("\n");
assert.equal(stripAds(cluster), "top\nbottom");

// 10. A lone 'ad' word inside a sentence is not an ad.
assert.equal(stripAds("this is an ad for the feature, read on"), "this is an ad for the feature, read on");

console.log("freebuff-ads ok");
