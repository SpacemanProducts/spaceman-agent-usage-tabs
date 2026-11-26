.pragma library
// 30-day usage bar chart helpers for agent tabs. Pure functions so
// bin/usage-chart.test.mjs can run them in node; UsageChart.qml imports this
// as Chart. series is [{date:'YYYY-MM-DD', tokens:number|null}] oldest
// first — null means the source reported nothing that day, and it stays null
// all the way through (a tick, never a fake bar: honest data).

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// 'YYYY-MM-DD' -> 'Nov 24'. Anything else comes back as the raw string.
function dayLabel(date) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date === undefined || date === null ? "" : date));
  if (!m) return String(date === undefined || date === null ? "" : date);
  var mon = Number(m[2]);
  if (mon < 1 || mon > 12) return String(date);
  return MONTHS[mon - 1] + " " + Number(m[3]);
}

// Same compact style as bin/constance-tokens.mjs fmtTokens: 1.2M, 900K, 3B.
function fmtTokens(n) {
  if (n >= 1e9) return (+(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)) + "B";
  if (n >= 1e6) return (+(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)) + "M";
  if (n >= 1e3) return (+(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)) + "K";
  return String(Math.round(n));
}

function num(d) {
  return d && typeof d.tokens === "number" && isFinite(d.tokens) ? d.tokens : null;
}

// One bar per day, bottom-aligned by the caller. height is 0..maxHeight scaled
// to the largest non-null tokens; tokens 0 gives height 0; null gives -1.
function bars(series, maxHeight) {
  var days = Array.isArray(series) ? series : [];
  var h = Number(maxHeight);
  if (!isFinite(h) || h < 0) h = 0;
  var peak = 0;
  days.forEach(function (d) { var t = num(d); if (t !== null && t > peak) peak = t; });
  return days.map(function (d) {
    var t = num(d), day = dayLabel(d ? d.date : "");
    if (t === null) return { date: d ? d.date : "", tokens: null, height: -1, label: day + ": no data" };
    var height = peak > 0 ? Math.round((t / peak) * h * 100) / 100 : 0;
    return { date: d.date, tokens: t, height: height, label: day + ": " + fmtTokens(t) + " tokens" };
  });
}

// 'peak 1.2M' for the busiest reported day, '' when nothing was reported.
function peakLabel(series) {
  var peak = 0, found = false;
  (Array.isArray(series) ? series : []).forEach(function (d) {
    var t = num(d);
    if (t !== null && (!found || t > peak)) { peak = t; found = true; }
  });
  return found ? "peak " + fmtTokens(peak) : "";
}

// False when every day is null — the chart hides itself rather than show a
// placeholder. A reported 0 still counts as data.
function hasData(series) {
  return (Array.isArray(series) ? series : []).some(function (d) { return num(d) !== null; });
}
