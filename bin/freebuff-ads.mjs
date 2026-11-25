// Freebuff is the free, ad-supported Codebuff CLI; with adsEnabled on, its captured
// output can carry sponsor banners between the real agent output. stripAds() removes
// those before the text is logged or reviewed, and leaves everything else untouched.
//
// No real ad sample was available when this was written (the CLI only shows ads on a
// live run, and the sandbox hides ~/.config/manicode), so the patterns below are
// deliberately conservative: a line counts as an ad only when it is clearly marked,
// and a whole block is removed only when it is set off by borders/separators or made
// of nothing but ad markers and decoration.
//
// What counts as an ad marker (matched on the ANSI-stripped line):
//  - the words sponsored/sponsor/sponsorship/advertisement/promo (any case)
//  - a whole-line banner word "Ad"/"Ads"/"AD" (box-drawing and punctuation allowed)
//  - a line that is essentially just a freebuff.com / codebuff.com URL
// A line that merely mentions such a URL inside a sentence is NOT a seed; it is
// absorbed only when it sits inside an ad block already being removed.
//
// Block removal:
//  1. Frame rule: lines between two decorative border/separator lines (box drawing,
//     dashes, '=', '*', ...) with no blank line between, at most 30 lines apart, that
//     contain an ad marker are removed whole, borders included.
//  2. Cluster rule: from each remaining marker, absorb neighbouring marker lines,
//     promo-URL lines and decorative lines (at most 8 decorative lines per side;
//     blank and ordinary text lines always stop the spread).
// ANSI escape sequences are matched through for detection only; lines that survive
// are returned byte-for-byte, so ad-free input comes back identical.

const ANSI_RE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])|\x9b[0-?]*[ -/]*[@-~]/g;
const stripAnsi = (s) => s.replace(ANSI_RE, "");

// A marker word anywhere on the line. "ad" alone is NOT here: it is too common
// inside real words ("load", "bad") and only counts as a whole-line banner (AD_LINE).
const AD_WORD = /\b(?:sponsored?|sponsorship|advertisements?|promos?|promo\s+codes?)\b/i;
const AD_LINE = /^[\s│┃║┃|╎╏╵╷·]*\b(?:ad|ads)\b[\s│┃║┃|╎╏╵╷·:：\-–—]*$/i;
const PROMO_URL = /(?<![A-Za-z0-9.-])(?:https?:\/\/)?(?:www\.)?(?:freebuff|codebuff)\.com(?:\/[^\s"'<>)\]]*)?/i;

// Decoration only: whitespace, box drawing and rule characters, no letters/digits.
const DECOR_RE = /^[\s─-╿═-╬█-▟\-_=*~·•.■□▪▫►▸→|]+$/u;

const MAX_FRAME = 30;   // lines between two borders that may hold one ad block
const MAX_DECOR = 8;    // decorative lines absorbed on each side of a marker cluster

// kind: "blank" (empty), "decor" (rules/borders/ANSI-only), "text", or "marker" (ad).
function classify(raw, clean) {
  if (!clean.trim()) return raw.trim() ? "decor" : "blank";   // ANSI-only line -> decor
  if (DECOR_RE.test(clean)) return "decor";
  return isMarker(clean) ? "marker" : "text";
}

// The promo URL is the whole line apart from box-drawing and punctuation.
function isPromoOnly(clean) {
  const m = PROMO_URL.exec(clean);
  if (!m) return false;
  const edge = /^[\s│┃║┃|╎╏╵╷·<>()\[\]"'“”‘’.,;:!?-]*$/;
  return edge.test(clean.slice(0, m.index)) && edge.test(clean.slice(m.index + m[0].length));
}

function isMarker(clean) {
  return AD_WORD.test(clean) || AD_LINE.test(clean) || isPromoOnly(clean);
}

export function stripAds(text) {
  const src = String(text ?? "");
  if (!src) return src;
  const lines = src.split("\n");
  const n = lines.length;
  const clean = lines.map(stripAnsi);
  const kind = new Array(n);
  const promoMention = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    kind[i] = classify(lines[i], clean[i]);
    if (kind[i] === "text") promoMention[i] = PROMO_URL.test(clean[i]);
  }
  const kill = new Array(n).fill(false);

  // Pass 1: frames. Each decorative line pairs with the next decorative line below
  // it (no blank between, MAX_FRAME apart); a marker inside kills the whole frame.
  for (let i = 0; i < n; i++) {
    if (kill[i] || kind[i] !== "decor") continue;
    for (let j = i + 1; j < n && j - i <= MAX_FRAME; j++) {
      if (kind[j] === "blank") break;
      if (kind[j] !== "decor") continue;
      let hasMarker = false;
      for (let k = i + 1; k < j; k++) if (kind[k] === "marker") { hasMarker = true; break; }
      if (hasMarker) for (let k = i; k <= j; k++) kill[k] = true;
      break;
    }
  }

  // Pass 2: clusters around any surviving marker.
  const absorbable = (i) => kind[i] === "marker" || kind[i] === "decor" || promoMention[i];
  for (let i = 0; i < n; i++) {
    if (kind[i] !== "marker" || kill[i]) continue;
    let a = i, b = i, dl = 0, dr = 0;
    while (a > 0 && !kill[a - 1] && absorbable(a - 1)) {
      if (kind[a - 1] === "decor" && ++dl > MAX_DECOR) break;
      if (kind[a - 1] !== "decor") dl = 0;
      a--;
    }
    while (b < n - 1 && !kill[b + 1] && absorbable(b + 1)) {
      if (kind[b + 1] === "decor" && ++dr > MAX_DECOR) break;
      if (kind[b + 1] !== "decor") dr = 0;
      b++;
    }
    for (let k = a; k <= b; k++) kill[k] = true;
  }

  if (!kill.some(Boolean)) return src;
  return lines.filter((_, i) => !kill[i]).join("\n");
}
