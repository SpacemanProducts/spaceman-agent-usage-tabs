// usage-csv.mjs — turn the shared usage history into a CSV export.
//
// Shared history format (stateDir/history.json, schemaVersion 1):
//   { "schemaVersion": 1,
//     "days": { "YYYY-MM-DD": { "<agentId>": {
//       "tokens": <number or null>,
//       "peaks": { "<limit title e.g. Session>": <fraction 0..1> },
//       "resets": <integer> } } } }
// Dates are LOCAL calendar dates. tokens null means the source reported
// nothing for that day (never invent 0). peaks only hold limits whose
// percent was a finite number; resets counts that day's reset celebrations.

// RFC 4180: quote a cell that contains a comma, quote or line break.
const cell = (v) => {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// One CSV column per limit title seen anywhere: "peak_" + title lowercased
// with every non-alphanumeric character turned into "_".
const peakCol = (title) => `peak_${String(title).toLowerCase().replace(/[^a-z0-9]/g, "_")}`;

export function historyToCsv(history) {
  const days = (history && history.days) || {};

  const titles = new Set();
  for (const agents of Object.values(days))
    for (const entry of Object.values(agents || {}))
      for (const title of Object.keys((entry && entry.peaks) || {})) titles.add(title);
  const cols = [...new Set([...titles].map(peakCol))].sort();

  const lines = [["date", "agent", "tokens", "resets", ...cols].map(cell).join(",")];
  for (const date of Object.keys(days).sort()) {
    const agents = days[date] || {};
    for (const agent of Object.keys(agents).sort()) {
      const entry = agents[agent] || {};
      const row = [
        date,
        agent,
        entry.tokens == null ? "" : entry.tokens,
        Number.isFinite(entry.resets) ? entry.resets : "",
      ];
      const byCol = new Map();
      for (const [title, frac] of Object.entries(entry.peaks || {})) {
        if (!Number.isFinite(frac)) continue;
        const col = peakCol(title);
        if (!byCol.has(col)) byCol.set(col, Math.round(frac * 100));
      }
      for (const col of cols) row.push(byCol.has(col) ? byCol.get(col) : "");
      lines.push(row.map(cell).join(","));
    }
  }
  return lines.join("\n") + "\n";
}
