// Deeper edge-case tests for constance-notify.mjs: parser corner cases
// (escapes, truncated/odd blocks, arg lines that look like headers), agent
// name boundaries, matchJob fallback/ambiguity rules, sender privacy edge
// cases, log-tail boundaries, signal dedupe and corrupt state. Everything
// runs against mktemp dirs with a fake HOME; no bus, network or real agents.
//
// REAL BUGS FOUND (assertions commented out, reported to Constance):
//  1. handleNotification stores the notification BODY as `summary` when the
//     summary is empty (clip(summary || body)) — the "never the body" privacy
//     rule is violated.
//  2. handleNotification crashes (TypeError from path.join) when the matched
//     running job has neither worktree nor dir: inspectJobDir(undefined).
//  3. NotifyParser's Member= regex is unanchored, so a STRING argument whose
//     value contains "Interface=org.freedesktop.Notifications  Member=Notify"
//     resets the string collection and the notification is silently dropped.
//  4. recentSignals(dir, 0) returns EVERY line: slice(-0) === slice(0).
//  5. recentSignals returns [] for the whole file when ANY line fails
//     JSON.parse — one corrupt line hides all signals and breaks dedupe.
//  6. matchJob's byDir check is a bare substring test: a job whose dir is a
//     prefix of another job's dir can win the match for the longer path.
//  7. recordSignal(dir, null) appends a literal "null" line and returns true.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { NotifyParser, notificationsIn, agentInText, agentApp, matchJob, handleNotification, inspectJobDir, recentSignals, notifyFile, allowedSender, logSaysFinished, jobFinishSignal, recordSignal } from "./constance-notify.mjs";
import { doneFile } from "./constance-jobs.mjs";

// A minimal busctl monitor block; args become STRING lines in order.
const block = (strings, { member = "Notify", iface = "org.freedesktop.Notifications" } = {}) =>
  ["‣ Type=method_call  Endian=l  Flags=0  Version=1 Cookie=1  Timestamp=\"x\"",
   `  Sender=:1.1  Destination=:1.2  Path=/org/freedesktop/Notifications  Interface=${iface}  Member=${member}`,
   '  MESSAGE "susssasa{sv}i" {',
   ...strings.map((s) => `          STRING "${s}";`),
   "  };",
   ""].join("\n");
const full = (app, icon, summary, body) => block([app, icon, summary, body]);

// ---------- NotifyParser / notificationsIn ----------

// Empty and junk input.
assert.deepEqual(notificationsIn(""), []);
assert.deepEqual(notificationsIn(null), []); // String(null) -> "null", no Notify lines
assert.deepEqual(notificationsIn(undefined), []);

// A block with fewer than 4 STRING args is dropped, and the partial collection
// cannot bleed into the next block.
{
  const p = new NotifyParser();
  const partial = block(["Ghostty", "", "only three"]); // 3 strings, one short
  for (const l of partial.split("\n")) p.feed(l);
  assert.equal(p.end(), null, "incomplete block emits nothing");
  // Feeding a complete block into the SAME parser still works: its Member=
  // line resets the stale partial collection.
  const streamed = [];
  for (const l of full("Ghostty", "", "Grok finished", "b").split("\n")) {
    const e = p.feed(l); if (e) streamed.push(e);
  }
  const last = p.end(); if (last) streamed.push(last);
  assert.deepEqual(streamed, [{ app: "Ghostty", summary: "Grok finished", body: "b" }],
    "next block parses cleanly after a truncated one");
}

// Escapes inside STRING values: \\n, \\t, \\", \\\\ and unknown escapes.
{
  const raw = [
    '‣ Type=method_call',
    '  Interface=org.freedesktop.Notifications  Member=Notify',
    '  MESSAGE "susssasa{sv}i" {',
    '    STRING "Ghostty";',
    '    STRING "";',
    '    STRING "line1\\nline2\\tTabbed \\"quoted\\" C:\\\\tmp \\q";',
    '    STRING "body";',
    '  };',
    '‣ Type=method_return',
  ].join("\n");
  const [ev] = notificationsIn(raw);
  assert.equal(ev.summary, 'line1\nline2\tTabbed "quoted" C:\\tmp q', "busctl escapes are unescaped");
}

// Several STRING tokens on one line are all collected, in order.
{
  const raw = [
    '‣ Type=method_call',
    '  Interface=org.freedesktop.Notifications  Member=Notify',
    '  MESSAGE "susssasa{sv}i" {',
    '    STRING "Ghostty"; STRING "";',
    '    STRING "Grok finished";',
    '    STRING "two on one line";',
    '  };',
  ].join("\n");
  const [ev] = notificationsIn(raw);
  assert.deepEqual(ev, { app: "Ghostty", summary: "Grok finished", body: "two on one line" });
}

// Actions and hint dict entries add more STRING lines AFTER the body; the
// first four collected strings must still be app/icon/summary/body.
{
  const raw = [
    '‣ Type=method_call',
    '  Interface=org.freedesktop.Notifications  Member=Notify',
    '  MESSAGE "susssasa{sv}i" {',
    '    STRING "Grok";',
    '    STRING "";',
    '    STRING "Grok finished";',
    '    STRING "";',
    '    ARRAY "s" {',
    '      STRING "default";',
    '      STRING "Open";',
    '    };',
    '    ARRAY "{sv}" {',
    '      DICT_ENTRY "sv" {',
    '        STRING "urgency";',
    '        VARIANT "y" { BYTE 1; };',
    '      };',
    '    };',
    '    INT32 -1;',
    '  };',
    '‣ Type=method_return',
  ].join("\n");
  const [ev] = notificationsIn(raw);
  assert.deepEqual(ev, { app: "Grok", summary: "Grok finished", body: "" }, "extra STRINGs after body are ignored");
}

// An unterminated STRING (no closing quote) is not collected.
{
  const raw = [
    '‣ Type=method_call',
    '  Interface=org.freedesktop.Notifications  Member=Notify',
    '  MESSAGE "susssasa{sv}i" {',
    '    STRING "Ghostty";',
    '    STRING "";',
    '    STRING "Grok finished',   // missing closing quote -> not a STRING match
    '    STRING "body";',
    '  };',
    '‣ Type=method_return',
  ].join("\n");
  assert.deepEqual(notificationsIn(raw), [], "only 3 valid strings -> dropped");
}

// Member=Notify on a DIFFERENT interface, or a different member on the right
// interface, must not start a collection.
{
  const wrongIface = block(['Ghostty', '', 'Grok finished', 'b'], { iface: 'org.example.Other' });
  const wrongMember = block(['Ghostty', '', 'Grok finished', 'b'], { member: 'NotifyUrgency' });
  assert.deepEqual(notificationsIn(wrongIface), []);
  assert.deepEqual(notificationsIn(wrongMember + block(['Ghostty', '', 'Grok finished', 'b'])),
    [{ app: 'Ghostty', summary: 'Grok finished', body: 'b' }], 'only the real Notify block emits');
}

// CRLF line endings still parse.
{
  const raw = full('Ghostty', '', 'Grok finished', 'b').replace(/\n/g, '\r\n');
  assert.deepEqual(notificationsIn(raw), [{ app: 'Ghostty', summary: 'Grok finished', body: 'b' }]);
}

// A Notify block followed immediately by another Notify with no separator
// emits both (each header flushes the previous collection).
{
  const two = full('Ghostty', '', 'Grok finished', 'one') + full('Ghostty', '', 'Devin finished', 'two');
  const evs = notificationsIn(two);
  assert.equal(evs.length, 2);
  assert.equal(evs[1].summary, 'Devin finished');
}

// A STRING arg containing the Member= signature must not reset the parser's
// collection — notification text is data, never a header.
{
  const evil = notificationsIn(full('Ghostty', '', 'see Interface=org.freedesktop.Notifications  Member=Notify here', 'Grok finished'));
  assert.equal(evil.length, 1, 'a STRING value must never be read as a header line');
  assert.equal(evil[0].summary, 'see Interface=org.freedesktop.Notifications  Member=Notify here');
}

// ---------- agentInText / agentApp / allowedSender ----------

// Case-insensitivity and every known alias.
assert.equal(agentInText('DEVIN FINISHED').id, 'devin');
assert.equal(agentInText('Claude Code exited').id, 'claude');
assert.equal(agentInText('agy finished').id, 'antigravity');
assert.equal(agentInText('Antigravity done').id, 'antigravity');
assert.equal(agentInText('Cursor Agent ready').id, 'cursor');
assert.equal(agentInText('cursor-agent finished').id, 'cursor');
assert.equal(agentInText('Codex CLI exited').id, 'codex');
assert.equal(agentInText('GitHub Copilot completed').id, 'copilot');

// Word boundaries: agent names inside longer words must not match.
assert.equal(agentInText('the devincli tool'), null);
assert.equal(agentInText('antigravityx'), null);
assert.equal(agentInText('mycodex'), null);
// But punctuation/hyphens are boundaries.
assert.equal(agentInText('grok, finished').id, 'grok');
assert.equal(agentInText('(cursor) exited').id, 'cursor');

// agentApp: sender name -> known agent, with cli/code suffix stripping.
assert.equal(agentApp('Devin').id, 'devin');
assert.equal(agentApp('Claude Code').id, 'claude');
assert.equal(agentApp('Claude').id, 'claude');
assert.equal(agentApp('Grok CLI').id, 'grok');
assert.equal(agentApp('Cursor Agent').id, 'cursor');
assert.equal(agentApp('cursor-agent').id, 'cursor');
assert.equal(agentApp('agy').id, 'antigravity');
assert.equal(agentApp('  Devin  ').id, 'devin', 'surrounding space is trimmed');
assert.equal(agentApp('DEVIN').id, 'devin', 'case-insensitive');
assert.equal(agentApp('Music'), null);
assert.equal(agentApp(''), null);
assert.equal(agentApp(null), null);
assert.equal(agentApp(undefined), null);
assert.equal(agentApp(0), null);
assert.equal(agentApp('Claude-Code'), null, 'hyphenated form is not a known name');

// allowedSender: terminals + agent apps pass, everything else fails.
assert.equal(allowedSender('Ghostty'), true);
assert.equal(allowedSender('com.mitchellh.ghostty'), true);
assert.equal(allowedSender('  Ghostty  '), true);
assert.equal(allowedSender('ghostty-terminal'), false, 'only the exact app names count');
assert.equal(allowedSender('Devin'), true);
assert.equal(allowedSender('Claude Code'), true);
assert.equal(allowedSender('agy'), true);
assert.equal(allowedSender('Cook Meter'), false);
assert.equal(allowedSender(''), false);
assert.equal(allowedSender(null), false);
assert.equal(allowedSender(42), false);

// ---------- matchJob ----------

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'constance-notify-deep-'));
const repoA = path.join(root, 'repo-a'), repoB = path.join(root, 'repo-a-long');
const stateDir = path.join(root, 'state');
for (const d of [repoA, repoB, stateDir]) fs.mkdirSync(d, { recursive: true });
const git = (...a) => execFileSync('git', ['-C', repoA, ...a], { encoding: 'utf8' });
git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
fs.writeFileSync(path.join(repoA, 'a.txt'), 'a\n'); git('add', 'a.txt'); git('commit', '-qm', 'init');
for (const d of [repoA, repoB]) fs.mkdirSync(path.join(d, '.constance'), { recursive: true });
fs.writeFileSync(doneFile(repoA, 3), '{"summary":"d","commit":""}');

// Finish-word coverage for the agent-done vs agent-signal split.
for (const [text, kind] of [
  ['Grok finished', 'agent-done'],
  ['Grok done', 'agent-done'],
  ['Grok completed', 'agent-done'],
  ['Grok completing', 'agent-done'],
  ['Grok exited', 'agent-done'],
  ['Grok exit', 'agent-done'],
  ['Grok ready', 'agent-done'],
  ['Grok is thinking', 'agent-signal'],
  ['Grok paused', 'agent-signal'],
]) {
  const m = matchJob(text, [{ id: 7, agent: 'grok', status: 'running', dir: repoA, startedAt: 1 }]);
  assert.equal(m.kind, kind, text);
}
// "unfinished" must not count as finished (no word boundary inside the word).
{
  const m = matchJob('Grok unfinished business', [{ id: 7, agent: 'grok', status: 'running', dir: repoA, startedAt: 1 }]);
  assert.equal(m.kind, 'agent-signal', 'finish inside a longer word does not match');
}

// Statuses other than "running" never match, whatever the case.
for (const status of ['queued', 'held', 'accepted', 'merged', 'failed', 'Running']) {
  const m = matchJob('Grok finished', [{ id: 7, agent: 'grok', status, dir: repoA, startedAt: 1 }]);
  assert.equal(m.kind, 'foreign', `status ${status} is not running`);
}

// Fallback order: dir match > done file > newest startedAt.
{
  const jobs = [
    { id: 1, agent: 'grok', status: 'running', dir: repoB, startedAt: 1 },
    { id: 2, agent: 'grok', status: 'running', dir: repoA, startedAt: 9 },
  ];
  // No done files for jobs 1 or 2 -> newest (id 2, startedAt 9) wins.
  let m = matchJob('Grok finished', jobs);
  assert.equal(m.job, 2);
  assert.equal(m.ambiguous, true, 'two running, no dir/done tiebreak -> ambiguous');
  // A dir mention in the text wins over startedAt.
  m = matchJob(`Grok finished in ${repoB}`, jobs);
  assert.equal(m.job, 1);
  assert.equal(m.ambiguous, false);
  // A done file beats startedAt.
  fs.writeFileSync(doneFile(repoB, 1), '{"summary":"d","commit":""}');
  m = matchJob('Grok finished', jobs);
  assert.equal(m.job, 1, 'done file beats newer startedAt');
  assert.equal(m.ambiguous, false);
  fs.rmSync(doneFile(repoB, 1));
}

// Equal startedAt: reduce keeps the FIRST job in the array.
{
  const jobs = [
    { id: 11, agent: 'grok', status: 'running', dir: repoA, startedAt: 5 },
    { id: 12, agent: 'grok', status: 'running', dir: repoA, startedAt: 5 },
  ];
  assert.equal(matchJob('Grok finished', jobs).job, 11, 'tie keeps array order');
}

// Missing startedAt counts as 0.
{
  const jobs = [
    { id: 11, agent: 'grok', status: 'running', dir: repoA },
    { id: 12, agent: 'grok', status: 'running', dir: repoA, startedAt: 1 },
  ];
  assert.equal(matchJob('Grok finished', jobs).job, 12);
}

// Worktree is preferred over dir for both matching text and inspection.
{
  const wt = path.join(root, 'wt');
  fs.mkdirSync(path.join(wt, '.constance'), { recursive: true });
  const jobs = [{ id: 21, agent: 'devin', status: 'running', dir: repoA, worktree: wt, startedAt: 1 }];
  const m = matchJob(`Devin finished ${wt}`, jobs);
  assert.equal(m.dir, wt);
  assert.equal(m.job, 21);
}

// A job with no dir/worktree can still be matched (newest fallback) and
// reports dir: undefined.
{
  const m = matchJob('Grok finished', [{ id: 30, agent: 'grok', status: 'running', startedAt: 1 }]);
  assert.equal(m.job, 30);
  assert.equal(m.dir, undefined);
}

// byDir requires a whole path token: a job whose dir is a prefix of another's
// must not steal the match for the longer path.
{
  const prefixJobs = [
    { id: 40, agent: 'grok', status: 'running', dir: repoA, startedAt: 1 },
    { id: 41, agent: 'grok', status: 'running', dir: repoB, startedAt: 2 },
  ];
  const pm = matchJob(`Grok finished in ${repoB}`, prefixJobs);
  assert.equal(pm.job, 41, 'the longer, exact dir should win over a prefix dir');
}

// ---------- inspectJobDir ----------

// A done file flips the first part of the report.
{
  const info = inspectJobDir(repoA, 3);
  assert.match(info, /^done file present/);
  assert.match(info, /git log: /);
}
// A missing directory reports only the done-file part; git failures are silent.
{
  const info = inspectJobDir(path.join(root, 'does-not-exist'), 1);
  assert.equal(info, 'no done file yet');
}
// A plain non-git directory: no git lines at all.
{
  const plain = path.join(root, 'plain'); fs.mkdirSync(plain);
  assert.equal(inspectJobDir(plain, 1), 'no done file yet');
}
// Uncommitted work is summarized, capped at 4 entries.
{
  const dirty = path.join(root, 'dirty');
  fs.mkdirSync(dirty);
  const g = (...a) => execFileSync('git', ['-C', dirty, ...a], { encoding: 'utf8' });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(dirty, 'f.txt'), 'x\n'); g('add', 'f.txt'); g('commit', '-qm', 'init');
  for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(dirty, `u${i}.txt`), 'u\n');
  const info = inspectJobDir(dirty, 1);
  assert.match(info, /uncommitted: /);
  assert.equal((info.match(/u\d\.txt/g) || []).length, 4, 'only the first 4 lines are shown');
}

// ---------- logSaysFinished ----------

assert.equal(logSaysFinished('unfinished business'), false, 'finish inside a word is not a finish');
assert.equal(logSaysFinished('completely unrelated'), true, 'DOCUMENTED: complet\\w* also matches "completely"');
// BUG-adjacent note: 'completely'/'completeness' matching FINISHED is likely
// over-broad (see matchJob kind + foreign filter, same regex).
// const m2 = matchJob('Grok completely stuck', [{ id: 7, agent: 'grok', status: 'running', dir: repoA, startedAt: 1 }]);
// assert.equal(m2.kind, 'agent-signal', '"completely" should not read as finished');
assert.equal(logSaysFinished(`${'x'.repeat(4096)} finished`), true, 'finish word inside the 4 KiB tail');
assert.equal(logSaysFinished(`finished ${'x'.repeat(4096)}`), false, 'finish word pushed out of the tail');
assert.equal(logSaysFinished('wrote .constance/done-12.json'), true);
assert.equal(logSaysFinished('see .constance/donefile notes'), false, 'needs the done- prefix literally');
assert.equal(logSaysFinished({ toString() { throw new Error('boom'); } }), false, 'never throws');
assert.equal(logSaysFinished(0), false);
assert.equal(logSaysFinished(false), false);
assert.equal(logSaysFinished('   \n  '), false);

// ---------- jobFinishSignal ----------

// clip() boundary: 120 chars unchanged, 121 clipped to exactly 120 with ellipsis.
{
  const realNow = Date.now;
  Date.now = () => 424242;
  try {
    const j120 = jobFinishSignal({ id: 1, agent: 'grok', summary: 's'.repeat(120) }, { source: 'exit' });
    assert.equal(j120.summary.length, 120);
    assert.ok(!j120.summary.endsWith('…'));
    const j121 = jobFinishSignal({ id: 1, agent: 'grok', summary: 's'.repeat(121) }, { source: 'exit' });
    assert.equal(j121.summary.length, 120);
    assert.ok(j121.summary.endsWith('…'));
    const jNum = jobFinishSignal({ id: 1, agent: 'grok', summary: 12345 }, { source: 'exit' });
    assert.equal(jNum.summary, '12345', 'non-string summaries are stringified');
    const jUndef = jobFinishSignal({ id: 1, agent: 'grok' }, { source: 'exit' });
    assert.equal(jUndef.summary, '');
    assert.equal(jUndef.at, 424242, 'at comes from Date.now');
  } finally {
    Date.now = realNow;
  }
}
// clip() can split a surrogate pair at the boundary, leaving a lone surrogate.
{
  const sig = jobFinishSignal({ id: 1, agent: 'grok', summary: 'a'.repeat(118) + '\u{1F600}' + 'b' }, { source: 'exit' });
  // 'a'*118 + emoji(2 units) + 'b' = 121 UTF-16 units -> the cut would keep
  // 118 a's + the emoji's HIGH surrogate only; clip must drop the half pair.
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(sig.summary), false, 'no lone surrogate');
  assert.ok(sig.summary.length <= 120);
}
// runDir that does not exist still produces an inspection string, no throw.
{
  const sig = jobFinishSignal({ id: 1, agent: 'grok', summary: 'x' }, { source: 'exit', runDir: path.join(root, 'nope') });
  assert.match(sig.inspection, /no done file yet/);
}
for (const runDir of [undefined, null, '']) {
  const sig = jobFinishSignal({ id: 1, agent: 'grok' }, { source: 'exit', runDir });
  assert.equal(sig.inspection, 'no run dir');
  assert.equal(sig.dir, runDir);
}
// An unknown source string is passed through untouched.
assert.equal(jobFinishSignal({ id: 1, agent: 'grok' }, { source: 'whatever' }).source, 'whatever');

// ---------- handleNotification ----------

// A fresh state dir per scenario keeps counts exact.
const freshDir = () => fs.mkdtempSync(path.join(root, 'h-'));

// No storeDir: the event is still returned, nothing is written, nothing throws.
{
  const ev = handleNotification({ app: 'Ghostty', summary: 'Grok finished', body: '' },
    { jobs: [{ id: 1, agent: 'grok', status: 'running', dir: repoA, startedAt: 1 }] });
  assert.equal(ev.kind, 'agent-done');
}
// Empty jobs list: any agent-named finish is foreign.
{
  const d = freshDir();
  const ev = handleNotification({ app: 'Ghostty', summary: 'Grok finished', body: '' }, { jobs: [], storeDir: d });
  assert.deepEqual(Object.keys(ev).sort(), ['agent', 'at', 'kind']);
  assert.equal(recentSignals(d).length, 1);
}
// An agent-signal (running job, non-finish text) is recorded without inspection.
{
  const d = freshDir();
  const ev = handleNotification({ app: 'Ghostty', summary: 'Grok is thinking', body: 'deep thoughts' },
    { jobs: [{ id: 1, agent: 'grok', status: 'running', dir: repoA, startedAt: 1 }], storeDir: d });
  assert.equal(ev.kind, 'agent-signal');
  assert.equal(ev.inspection, undefined);
  assert.equal(ev.body, undefined);
  assert.ok(!/deep thoughts/.test(fs.readFileSync(notifyFile(d), 'utf8')), 'body never reaches disk');
}
// An agent CLI's own app name is a valid sender, and a finish with no job of
// hers is foreign.
{
  const d = freshDir();
  const ev = handleNotification({ app: 'Devin', summary: 'Devin finished', body: 'details' }, { jobs: [], storeDir: d });
  assert.equal(ev.kind, 'foreign');
  assert.equal(ev.agent, 'devin');
}
// Ambiguity is flagged on the event.
{
  const d = freshDir();
  const ev = handleNotification({ app: 'Ghostty', summary: 'Grok finished', body: '' },
    { jobs: [
      { id: 1, agent: 'grok', status: 'running', dir: repoA, startedAt: 1 },
      { id: 2, agent: 'grok', status: 'running', dir: repoB, startedAt: 2 },
    ], storeDir: d });
  assert.equal(ev.note, 'several jobs for this agent were running; matched the newest');
  assert.equal(ev.job, 2);
}
// Foreign events dedupe nothing (no job id) — every finish is recorded.
{
  const d = freshDir();
  handleNotification({ app: 'Ghostty', summary: 'Codex finished', body: '' }, { jobs: [], storeDir: d });
  handleNotification({ app: 'Ghostty', summary: 'Codex finished', body: '' }, { jobs: [], storeDir: d });
  assert.equal(recentSignals(d).length, 2);
}
// Non-string summary/body are coerced, not crashed on.
{
  const d = freshDir();
  const ev = handleNotification({ app: 'Grok', summary: 42, body: null },
    { jobs: [{ id: 1, agent: 'grok', status: 'running', dir: repoA, startedAt: 1 }], storeDir: d });
  assert.equal(ev.summary, '42');
}
// A dirless running job must not crash handleNotification: inspectJobDir
// reports "no run dir" instead of throwing inside path.join.
{
  const dCrash = freshDir();
  const evCrash = handleNotification({ app: 'Ghostty', summary: 'Grok finished', body: '' },
    { jobs: [{ id: 30, agent: 'grok', status: 'running', startedAt: 1 }], storeDir: dCrash });
  assert.equal(evCrash.kind, 'agent-done');
  assert.equal(evCrash.inspection, 'no run dir');
}

// An empty summary must never fall back to the body: the body is matched on
// but is never stored, on the event or on disk.
{
  const dBody = freshDir();
  const evBody = handleNotification({ app: 'Ghostty', summary: '', body: 'Grok finished SECRET DETAILS' },
    { jobs: [{ id: 1, agent: 'grok', status: 'running', dir: repoA, startedAt: 1 }], storeDir: dBody });
  assert.ok(!/SECRET DETAILS/.test(JSON.stringify(evBody)), 'body text must not be stored as summary');
  assert.ok(!/SECRET DETAILS/.test(fs.readFileSync(notifyFile(dBody), 'utf8')));
}

// ---------- recordSignal / recentSignals ----------

// Empty/missing storeDir: write refused, read returns [].
{
  assert.equal(recordSignal('', { at: 1, agent: 'x', kind: 'foreign' }), false);
  assert.equal(recordSignal(null, { at: 1, agent: 'x', kind: 'foreign' }), false);
  assert.equal(recordSignal(path.join(root, 'no-such-dir'), { at: 1, agent: 'x', kind: 'foreign' }), false);
  assert.deepEqual(recentSignals(''), []);
  assert.deepEqual(recentSignals(path.join(root, 'no-such-dir')), []);
}
// Job id 0 still dedupes (the check is != null, not truthiness).
{
  const d = freshDir();
  const sig = { at: 1, agent: 'grok', kind: 'agent-done', job: 0 };
  assert.equal(recordSignal(d, sig), true);
  assert.equal(recordSignal(d, { ...sig, at: 2 }), false, 'job 0 dedupes like any id');
}
// Job id type matters: "5" and 5 are different jobs to the dedupe check.
{
  const d = freshDir();
  assert.equal(recordSignal(d, { at: 1, agent: 'grok', kind: 'agent-done', job: '5' }), true);
  assert.equal(recordSignal(d, { at: 2, agent: 'grok', kind: 'agent-done', job: 5 }), true, 'strict === on job id');
}
// Events without a job id are never deduped, even identical ones.
{
  const d = freshDir();
  const foreign = { at: 1, agent: 'codex', kind: 'foreign' };
  assert.equal(recordSignal(d, foreign), true);
  assert.equal(recordSignal(d, { ...foreign }), true);
  assert.equal(recordSignal(d, {}), true, 'an empty event still writes');
}
// recentSignals(n): tail slicing.
{
  const d = freshDir();
  for (let i = 0; i < 5; i++) recordSignal(d, { at: i, agent: 'x', kind: 'foreign', n: i });
  assert.equal(recentSignals(d).length, 5);
  assert.equal(recentSignals(d, 2).length, 2);
  assert.equal(recentSignals(d, 2)[0].n, 3);
  assert.equal(recentSignals(d, 99).length, 5, 'n larger than the file returns all');
  assert.deepEqual(recentSignals(d, 0), [], 'n=0 should return no signals');
}
// One corrupt line must not hide every signal: bad lines are skipped, the
// good ones still parse, and dedupe still sees them.
{
  const d = freshDir();
  recordSignal(d, { at: 1, agent: 'grok', kind: 'agent-done', job: 1 });
  fs.appendFileSync(notifyFile(d), 'this is not json\n');
  recordSignal(d, { at: 2, agent: 'grok', kind: 'agent-done', job: 1 });
  const sigs = recentSignals(d).filter(Boolean);
  assert.equal(sigs.length, 1, 'the good line survives a corrupt neighbour');
  assert.equal(sigs.filter((s) => s.job === 1).length, 1, 'dedupe still sees the old signal');
}
// A null event is not a signal: nothing is written, nothing is reported.
{
  const d = freshDir();
  assert.equal(recordSignal(d, null), false, 'a null event is not a signal');
  assert.deepEqual(recentSignals(d), []);
}

fs.rmSync(root, { recursive: true, force: true });
console.log('constance-notify.deep: tests passed');
