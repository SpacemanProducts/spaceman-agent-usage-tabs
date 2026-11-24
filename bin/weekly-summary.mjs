// Weekly summary over the shared history.json format:
// { schemaVersion: 1, days: { "YYYY-MM-DD": { agentId: { tokens, peaks, resets } } } }
// Pure functions, no dependencies.

function localDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return localDateKey(dt);
}

export function formatTokens(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e6) return trim((n / 1e6).toFixed(1)) + 'M';
  if (abs >= 1e3) return trim((n / 1e3).toFixed(1)) + 'K';
  return String(Math.round(n));

  function trim(s) {
    return s.endsWith('.0') ? s.slice(0, -2) : s;
  }
}

export function weeklySummary(history, now = Date.now(), names = {}) {
  const todayKey = localDateKey(new Date(now));
  const keys = [];
  for (let i = 6; i >= 0; i--) keys.push(addDays(todayKey, -i));

  const days = (history && history.days) || {};
  const agents = new Map(); // id -> { tokens, resets, peaks, sawRecord }
  const perDayTotals = new Map(); // date -> total non-null tokens

  for (const key of keys) {
    const day = days[key];
    if (!day) continue;
    for (const [id, rec] of Object.entries(day)) {
      let a = agents.get(id);
      if (!a) {
        a = { id, tokens: null, tokensSeen: false, resets: 0, peaks: {} };
        agents.set(id, a);
      }
      if (typeof rec.tokens === 'number' && Number.isFinite(rec.tokens)) {
        a.tokens = (a.tokens ?? 0) + rec.tokens;
        a.tokensSeen = true;
        perDayTotals.set(key, (perDayTotals.get(key) ?? 0) + rec.tokens);
      }
      if (typeof rec.resets === 'number' && Number.isFinite(rec.resets)) {
        a.resets += rec.resets;
      }
      if (rec.peaks && typeof rec.peaks === 'object') {
        for (const [title, frac] of Object.entries(rec.peaks)) {
          if (typeof frac === 'number' && Number.isFinite(frac)) {
            if (!(title in a.peaks) || frac > a.peaks[title]) a.peaks[title] = frac;
          }
        }
      }
    }
  }

  let busiestDay = null;
  let best = -Infinity;
  for (const key of keys) {
    const total = perDayTotals.get(key);
    if (total === undefined) continue;
    if (total > best) {
      best = total;
      busiestDay = { date: key, tokens: total };
    }
  }

  const list = [...agents.values()]
    .map((a) => ({
      id: a.id,
      name: names[a.id] || a.id,
      tokens: a.tokensSeen ? a.tokens : null,
      resets: a.resets,
      peaks: a.peaks,
    }))
    .sort((x, y) => {
      if (x.tokens === null && y.tokens === null) return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
      if (x.tokens === null) return 1;
      if (y.tokens === null) return -1;
      if (y.tokens !== x.tokens) return y.tokens - x.tokens;
      return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
    });

  const resetsHit = list.reduce((s, a) => s + a.resets, 0);

  return {
    from: keys[0],
    to: keys[keys.length - 1],
    agents: list,
    resetsHit,
    busiestDay,
  };
}
