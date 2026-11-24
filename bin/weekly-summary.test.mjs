import assert from 'node:assert/strict';
import { weeklySummary, formatTokens } from './weekly-summary.mjs';

// Fixed "now": 2026-11-24 is a Tuesday. Week = 2026-11-18 .. 2026-11-24.
const NOW = new Date(2026, 10, 24, 15, 30).getTime();

function hist(days) {
  return { schemaVersion: 1, days };
}

// --- week boundaries ---
{
  const h = hist({
    '2026-11-17': { claude: { tokens: 999, peaks: {}, resets: 9 } }, // outside week
    '2026-11-18': { claude: { tokens: 10, peaks: { Session: 0.5 }, resets: 1 } },
    '2026-11-24': { claude: { tokens: 20, peaks: { Session: 0.9 }, resets: 2 } },
  });
  const s = weeklySummary(h, NOW);
  assert.equal(s.from, '2026-11-18');
  assert.equal(s.to, '2026-11-24');
  assert.equal(s.agents.length, 1);
  assert.equal(s.agents[0].tokens, 30);
  assert.equal(s.agents[0].resets, 3);
  assert.deepEqual(s.agents[0].peaks, { Session: 0.9 });
  assert.equal(s.resetsHit, 3);
  assert.deepEqual(s.busiestDay, { date: '2026-11-24', tokens: 20 });
}

// --- null handling ---
{
  const h = hist({
    '2026-11-20': {
      grok: { tokens: null, peaks: { Weekly: 0.4 }, resets: 0 },
      devin: { tokens: 500, peaks: {}, resets: 1 },
    },
    '2026-11-21': {
      grok: { tokens: null, peaks: {}, resets: 0 },
      devin: { tokens: null, peaks: {}, resets: 0 },
    },
  });
  const s = weeklySummary(h, NOW, { devin: 'Devin' });
  const grok = s.agents.find((a) => a.id === 'grok');
  const devin = s.agents.find((a) => a.id === 'devin');
  assert.equal(grok.tokens, null); // every day null -> null, not 0
  assert.deepEqual(grok.peaks, { Weekly: 0.4 });
  assert.equal(devin.name, 'Devin');
  assert.equal(devin.tokens, 500);
  // devin sorts before grok (tokens desc, null last)
  assert.equal(s.agents[0].id, 'devin');
  assert.equal(s.agents[1].id, 'grok');
  // busiest day counts only non-null tokens
  assert.deepEqual(s.busiestDay, { date: '2026-11-20', tokens: 500 });
}

// --- busiest day ties: earliest date wins ---
{
  const h = hist({
    '2026-11-19': { a: { tokens: 100, peaks: {}, resets: 0 } },
    '2026-11-22': { b: { tokens: 100, peaks: {}, resets: 0 } },
    '2026-11-23': { a: { tokens: null, peaks: {}, resets: 0 } },
  });
  const s = weeklySummary(h, NOW);
  assert.deepEqual(s.busiestDay, { date: '2026-11-19', tokens: 100 });
}

// --- empty / missing history ---
{
  const s = weeklySummary(hist({}), NOW);
  assert.deepEqual(s.agents, []);
  assert.equal(s.resetsHit, 0);
  assert.equal(s.busiestDay, null);
  assert.equal(s.from, '2026-11-18');
  assert.equal(s.to, '2026-11-24');

  const s2 = weeklySummary(null, NOW);
  assert.deepEqual(s2.agents, []);
  assert.equal(s2.busiestDay, null);
}

// --- agents with no tokens but resets/peaks still appear, sorted last ---
{
  const h = hist({
    '2026-11-24': {
      quiet: { tokens: null, peaks: { Session: 0.7 }, resets: 2 },
      busy: { tokens: 10, peaks: {}, resets: 0 },
    },
  });
  const s = weeklySummary(h, NOW);
  assert.equal(s.agents.length, 2);
  assert.equal(s.agents[0].id, 'busy');
  assert.equal(s.agents[1].id, 'quiet');
  assert.equal(s.agents[1].tokens, null);
  assert.equal(s.resetsHit, 2);
}

// --- formatTokens ---
{
  assert.equal(formatTokens(null), '—');
  assert.equal(formatTokens(512), '512');
  assert.equal(formatTokens(1200000), '1.2M');
  assert.equal(formatTokens(3400), '3.4K');
  assert.equal(formatTokens(1000000), '1M');
}

console.log('weekly-summary tests passed');
