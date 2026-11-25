import assert from "node:assert/strict";
import { stripAds } from "./freebuff-ads.mjs";

// Deep edge-case tests for stripAds(). The shallow cases (basic banners, boxes,
// ANSI-wrapped markers, promo URLs in passing) live in freebuff-ads.test.mjs;
// this file covers wrong types, line classification corners, frame/cluster
// boundaries and inputs the first suite never tried. stripAds() is a pure
// function: it touches no files and no env, so no temp HOME is needed.

// --- Wrong / non-string input -------------------------------------------------

assert.equal(stripAds(), "");
assert.equal(stripAds(null), "");
assert.equal(stripAds(undefined), "");
assert.equal(stripAds(""), "");
assert.equal(stripAds(0), "0");
assert.equal(stripAds(false), "false");
assert.equal(stripAds(42), "42");
assert.equal(stripAds(["x", "y"]), "x,y");          // String(array) joins with ","
assert.equal(stripAds({ toString: () => " Sponsored " }), ""); // object stringifies to a marker
assert.throws(() => stripAds(Object.create(null)), TypeError); // no toString -> cannot convert

// --- Blank vs decor classification ---------------------------------------------

// A whitespace-only line is "blank": it stops both frame pairing and cluster spread.
const wsBlank = ["── rule ──", "   ", "Sponsored by Acme", "real"].join("\n");
assert.equal(stripAds(wsBlank), "── rule ──\n   \nreal");

// A line holding only ANSI escapes is "decor" (raw is non-empty after trim) and is
// absorbed into an adjacent ad cluster.
const ansiOnly = ["real", "[31m[0m", "Sponsored by Acme", "done"].join("\n");
assert.equal(stripAds(ansiOnly), "real\ndone");

// A tab-only line is blank for the same reason.
const tabBlank = ["──", "\t", "Ad", "x"].join("\n");
assert.equal(stripAds(tabBlank), "──\n\t\nx");

// --- Frame rule boundaries ------------------------------------------------------

const D = "──────────────────────────────";

// Borders exactly MAX_FRAME (30) lines apart still form a frame: everything inside
// dies, including ordinary text lines.
const frame30 = [D, "Sponsored", ...Array(28).fill("filler"), D].join("\n");
assert.equal(stripAds(frame30), "");

// 31 lines apart is one too many: no frame. The cluster pass still removes the
// marker plus the top border (decor directly adjacent to it); the far bottom border
// and all filler lines survive.
const interior31 = ["Sponsored", ...Array(29).fill("filler")];
const frame31 = [D, ...interior31, D].join("\n");
assert.equal(stripAds(frame31), [...interior31.slice(1), D].join("\n"));

// Ordinary text trapped inside a frame is removed with it.
const frameText = [D, "real output A", "Sponsored", "real output B", D, "tail"].join("\n");
assert.equal(stripAds(frameText), "tail");

// A blank line between the marker and a would-be closing border breaks the frame;
// the cluster pass still eats the marker and the one adjacent decor line.
const frameBlank = [D, "Sponsored", "", "══════"].join("\n");
assert.equal(stripAds(frameBlank), "\n══════");

// Two separate frames are both removed; text between them survives.
const twoFrames = [D, "Sponsored", D, "mid", "══════", "Ad", "══════"].join("\n");
assert.equal(stripAds(twoFrames), "mid");

// A run of consecutive decor lines never forms a frame (each pairs with an empty
// interior), so only the cluster rule's decor cap applies — see below.

// --- Cluster rule: decorative absorption cap ------------------------------------

// Exactly 8 decor lines above a marker are all absorbed.
const decor8 = [...Array(8).fill("─".repeat(10)), "Sponsored", "after"].join("\n");
assert.equal(stripAds(decor8), "after");

// 9 decor lines: only 8 are absorbed, the furthest one survives.
const decor9 = [...Array(9).fill("─".repeat(10)), "Sponsored", "after"].join("\n");
assert.equal(stripAds(decor9), "─".repeat(10) + "\nafter");

// The cap applies per contiguous run: a promo-mention line resets the decor count,
// so decor runs on both sides of it are each absorbed up to 8.
const decorBridge = [
  ...Array(8).fill("═".repeat(8)),
  "see https://freebuff.com/docs for details",   // text + promoMention: absorbable
  ...Array(8).fill("═".repeat(8)),
  "Sponsored",
  "tail",
].join("\n");
assert.equal(stripAds(decorBridge), "tail");

// A blank line stops the upward spread dead.
const clusterBlankStop = ["decor", "", "Sponsored", "x"].join("\n");
// "decor" is plain text here (letters), so only the marker dies.
assert.equal(stripAds(clusterBlankStop), "decor\n\nx");

// --- Promo URL variants -----------------------------------------------------------

// Scheme-less and www forms are whole-line markers on their own.
assert.equal(stripAds("a\nfreebuff.com\nb"), "a\nb");
assert.equal(stripAds("a\nwww.codebuff.com/path?x=1\nb"), "a\nb");
assert.equal(stripAds("a\nHTTPS://FREEBUFF.COM\nb"), "a\nb");

// Trailing sentence punctuation still counts as promo-only.
assert.equal(stripAds("a\nfreebuff.com.\nb"), "a\nb");
assert.equal(stripAds("a\n(codebuff.com/x)\nb"), "a\nb");

// Box-drawing around a bare promo URL is allowed by the edge rule.
assert.equal(stripAds("a\n│freebuff.com│\nb"), "a\nb");

// A domain that only ends in freebuff.com (lookbehind rejects the match start) is
// not even a promo mention: it survives right next to a marker.
const lookbehind = ["Sponsored", "see notfreebuff.com now", "after"].join("\n");
assert.equal(stripAds(lookbehind), "see notfreebuff.com now\nafter");

// freebuff.com.evil.com DOES match the URL regex (path check fails on ".evil"), so the
// line is promoMention: harmless alone, absorbed next to a marker.
assert.equal(stripAds("a\nfreebuff.com.evil.com/x\nb"), "a\nfreebuff.com.evil.com/x\nb");
const evilNearAd = ["Sponsored", "freebuff.com.evil.com/x", "after"].join("\n");
assert.equal(stripAds(evilNearAd), "after");

// A promo-mention text line adjacent to a marker is absorbed with the cluster even
// though it is not itself a marker.
const mentionAbsorbed = ["top", "Sponsored", "Docs: https://freebuff.com/docs is great", "bottom"].join("\n");
assert.equal(stripAds(mentionAbsorbed), "top\nbottom");

// --- Marker word boundaries ---------------------------------------------------------

// Words that merely contain marker substrings survive.
const nearMisses = [
  "promotional material for the launch",
  "the load average is bad today",
  "download finished, ads are not here",
].join("\n");
assert.equal(stripAds(nearMisses), nearMisses);

// Each documented marker word fires, including 'promo code' and whole-line banners.
assert.equal(stripAds("a\nSponsorship\nb"), "a\nb");
assert.equal(stripAds("a\nPromo code inside\nb"), "a\nb");
assert.equal(stripAds("a\nAD\nb"), "a\nb");
assert.equal(stripAds("a\nAds:\nb"), "a\nb");
assert.equal(stripAds("a\nad-\nb"), "a\nb"); // trailing dash is allowed edge punctuation

// --- ANSI handling edges --------------------------------------------------------------

// 8-bit CSI (\\x9b, no bracket) sequences are stripped for detection too.
const csi8 = "a\n\x9b33mSponsored\x9b0m by Acme\nb";
assert.equal(stripAds(csi8), "a\nb");

// An OSC hyperlink sequence is stripped; the remaining text is still judged.
const osc = "a\n\u001b]8;;https://example.com\u0007Sponsored\u001b]8;;\u0007\nb";
assert.equal(stripAds(osc), "a\nb");

// Kept lines are returned byte-for-byte: escapes on surviving lines are untouched.
const keepAnsi = "\u001b[1mbold\u001b[0m stays\nSponsored\n\u001b[32mgreen\u001b[0m stays";
assert.equal(stripAds(keepAnsi), "\u001b[1mbold\u001b[0m stays\n\u001b[32mgreen\u001b[0m stays");

// --- Output shape ---------------------------------------------------------------------

// Removing the only line yields the empty string.
assert.equal(stripAds("Sponsored"), "");
assert.equal(stripAds("Ad"), "");

// A trailing newline survives removal of a middle line.
assert.equal(stripAds("x\nSponsored\ny\n"), "x\ny\n");
// A leading newline survives too.
assert.equal(stripAds("\nSponsored\nx"), "\nx");

// CRLF input: \r rides along on kept lines and does not break marker detection.
assert.equal(stripAds("a\r\nSponsored\r\nb\r\n"), "a\r\nb\r\n");

// Bare \r is not a line separator for this module (split is on \n only): the whole
// "line" is judged at once and a marker word anywhere kills it entirely.
assert.equal(stripAds("a\rb"), "a\rb");
assert.equal(stripAds("a\rSponsored\rb"), "");

// Adjacency: marker directly against borders on both sides is one cluster.
const tight = ["──", "Sponsored", "──", "keep"].join("\n");
assert.equal(stripAds(tight), "keep");

// Large ad-free input returns identical (smoke test for accidental quadratic blowup).
const big = Array(5000).fill("ordinary output line").join("\n");
assert.equal(stripAds(big), big);

// --- Known bug (kept commented, NOT fixed — reported to the owner) ---------------------

// BUG: AD_LINE's edge classes only allow vertical box chars (│┃║┃╎╏╵╷·) and
// colon/dash punctuation, so a whole-line "AD"/"Ads" banner framed by HORIZONTAL
// rules is never detected: "──── AD ────" classifies as plain text and survives
// stripAds entirely, while the equivalent "│ Ad │" box is removed. Either AD_LINE
// needs the horizontal rule chars (─━═│ etc.) in its edge classes, or this is a
// deliberate conservative choice that should be documented.
// assert.equal(stripAds("a\n────── AD ──────\nb"), "a\nb"); // currently returns input unchanged

console.log("freebuff-ads.deep ok");
