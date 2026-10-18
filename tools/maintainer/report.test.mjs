import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collect, reportFor } from './report.mjs';

async function scratch(t) { const dir = await mkdtemp(join(tmpdir(), 'maintainer-report-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
test('report labels no-op as not released and preserves bounded review diagnostics', () => {
  const report = reportFor({ day: '2026-04-03', phase: 'published', spent: 0, version: '2026.4.3', review: { findings: ['ignored'] }, timeline: [{ phase: 'admitted', at: 1 }], modelPhaseCost: { executing: { cost: 0, status: 'known' } } });
  assert.equal(report.outcome, 'noop'); assert.equal(report.commit, null); assert.deepEqual(report.findings, ['ignored']);
});
test('sanitizes explicit, encoded, token, control, and markdown secrets from JSON and summary', async t => {
  const dir = await scratch(t); const reportPath = join(dir, 'input.json'); const out = join(dir, 'artifact'); const summary = join(dir, 'summary.md');
  const secret = 'github_pat_secret_sentinel_value_abcdefghijklmnopqrstuvwxyz123'; const prior = process.env.ZAI_API_KEY; process.env.ZAI_API_KEY = secret;
  t.after(() => { if (prior === undefined) delete process.env.ZAI_API_KEY; else process.env.ZAI_API_KEY = prior; });
  await writeFile(reportPath, JSON.stringify({ day: '2026-04-03', phase: 'rejected', spent: 1, review: { reason: `bad ${secret}`, findings: [`*${secret}*`, Buffer.from(secret).toString('base64'), 'ghp_abcdefghijklmnopqrstuvwxyz123456'] }, error: { message: secret } }));
  await collect({ reportPath, reportDir: out, summaryPath: summary });
  const written = `${await readFile(join(out, 'report.json'), 'utf8')}\n${await readFile(summary, 'utf8')}`;
  assert.ok(!written.includes(secret));
  assert.ok(!written.includes(Buffer.from(secret).toString('base64')));
  assert.doesNotMatch(written, /ghp_abcdefghijklmnopqrstuvwxyz123456/);
  assert.match(written, /\\\*/);
});
test('collector parses JSONL timings and marks release only from verified publish receipt', async t => {
  const dir = await scratch(t); const reportPath = join(dir, 'input.json'); const gates = join(dir, 'gates.jsonl'); const published = join(dir, 'publish.ok');
  await writeFile(reportPath, JSON.stringify({ phase: 'publishing', commit: 'a'.repeat(40), version: '2026.4.3', spent: 1 }));
  await writeFile(gates, '{"name":"fixed-gate","durationMs":12,"exitCode":0}\n{"name":"second-gate","durationMs":8,"exitCode":0}\n');
  await writeFile(published, 'a'.repeat(40) + '\n');
  await writeFile(join(dir, 'remote-proof'), `revision=${'a'.repeat(40)}\nversion=2026.4.3\ndigest=sha256:${'b'.repeat(64)}\n`);
  const result = await collect({ reportPath, gateEventsPath: gates, publishedPath: published, reportDir: join(dir, 'artifact') });
  assert.equal(result.outcome, 'released'); assert.equal(result.publicationDigest, `sha256:${'b'.repeat(64)}`); assert.deepEqual(result.gates, [{ name: 'fixed-gate', durationMs: 12, status: 'passed' }, { name: 'second-gate', durationMs: 8, status: 'passed' }]);
});
test('serialized report retains costs, source and findings through collection', async t => {
  const dir = await scratch(t); const input = join(dir, 'report.json');
  const before = reportFor({ day: '2026-04-03', phase: 'rejected', spent: 1.25, reportedUsage: 1.25, base: 'a'.repeat(40), head: 'b'.repeat(40), tree: 'c'.repeat(40), review: { reason: 'review-rejected', findings: ['Fix actual caller.'] } });
  await writeFile(input, JSON.stringify(before));
  const after = await collect({ reportPath: input, reportDir: join(dir, 'artifact'), summaryPath: join(dir, 'summary.md') });
  assert.equal(after.spend, 1.25); assert.deepEqual(after.reportedUsage, { status: 'known', cost: 1.25 });
  assert.equal(after.sourceIdentity.head, 'b'.repeat(40)); assert.deepEqual(after.findings, ['Fix actual caller.']);
  assert.match(await readFile(join(dir, 'summary.md'), 'utf8'), /Fix actual caller/);
});
test('malformed review and gate failure have distinct observable outcomes', () => {
  assert.equal(reportFor({ phase: 'rejected', review: { reason: 'invalid-review' } }).outcome, 'invalid-review');
  assert.equal(reportFor({ phase: 'gating', reason: 'maintenance-phase-failed' }).outcome, 'gate-failed');
});
test('an arbitrary publish marker cannot claim a verified release', async t => {
  const dir = await scratch(t); const input = join(dir, 'report.json'); const marker = join(dir, 'publish.ok');
  await writeFile(input, JSON.stringify({ phase: 'publishing', commit: 'a'.repeat(40), version: '2026.4.3' }));
  await writeFile(marker, 'verified');
  assert.equal((await collect({ reportPath: input, publishedPath: marker, reportDir: join(dir, 'artifact') })).outcome, 'pending');
});
test('PR source identity, ordered parents, budget/ledger and task fields roundtrip without plan bodies', async t => {
  const dir = await scratch(t), path = join(dir, 'input.json');
  const run = { phase: 'publishing', day: '2026-04-03', taskKind: 'pr', base: 'a'.repeat(40), tree: 'b'.repeat(40), commit: 'c'.repeat(40), releaseCommit: 'd'.repeat(40), prHead: 'd'.repeat(40), prNumber: 7, prAuthor: 'trusted', fingerprint: 'e'.repeat(64), expectedParents: ['a'.repeat(40)], trustedUpstreamPin: 'f'.repeat(40), budgetRemainder: 12.5, ledgerReservation: '1'.repeat(64), plans: [{ body: 'private proposal' }], version: '2026.4.3' };
  await writeFile(path, JSON.stringify(reportFor(run)));
  const report = await collect({ reportPath: path, reportDir: join(dir, 'out') });
  for (const key of ['releaseCommit', 'prHead', 'prNumber', 'prAuthor', 'fingerprint', 'budgetRemainder', 'ledgerReservation']) assert.deepEqual(report[key], run[key]);
  assert.deepEqual(report.sourceIdentity.expectedParents, run.expectedParents); assert.equal(report.sourceIdentity.trustedUpstreamPin, run.trustedUpstreamPin); assert.equal(JSON.stringify(report).includes('private proposal'), false);
});

test('published claims with missing/wrong source marker or remote proof never count as released', async t => {
  const dir = await scratch(t), path = join(dir, 'input.json'), marker = join(dir, 'publish.ok');
  await writeFile(path, JSON.stringify({ phase: 'published', commit: 'a'.repeat(40), releaseCommit: 'b'.repeat(40), version: '2026.4.3' }));
  for (const scenario of ['missing', 'synthetic-marker', 'wrong-version', 'bad-digest']) {
    await writeFile(marker, (scenario === 'synthetic-marker' ? 'a' : 'b').repeat(40));
    await writeFile(join(dir, 'remote-proof'), `revision=${'b'.repeat(40)}\nversion=${scenario === 'wrong-version' ? '2026.4.4' : '2026.4.3'}\ndigest=${scenario === 'bad-digest' ? 'invalid' : 'sha256:' + 'f'.repeat(64)}\n`);
    if (scenario === 'missing') await rm(marker);
    const report = await collect({ reportPath: path, publishedPath: marker, reportDir: join(dir, 'out') }); assert.equal(report.outcome, 'pending', scenario);
  }
});

test('management kind survives serialization and hash-shaped known secrets never bypass redaction', () => {
  const before = reportFor({ phase: 'managing', management: true, sourceChanged: false, spent: 0.25, reportedUsage: 0.25 });
  assert.equal(reportFor(before).kind, 'github-management');
  const key = 'f'.repeat(64); const masked = reportFor({ day: key, phase: 'failed', fingerprint: key, diffHash: key, managementPlanHash: key, ledgerReservation: key }, { env: { ZAI_API_KEY: key } });
  assert.equal(masked.day, null); assert.equal(masked.fingerprint, null); assert.equal(masked.sourceIdentity.diffHash, null);
  assert.equal(JSON.stringify(masked).includes(key), false);
});
test('sarcastic voice keeps no-op and failed outcomes explicit', async t => {
  const dir = await scratch(t); const input = join(dir, 'input.json'); const summary = join(dir, 'summary.md');
  await writeFile(input, JSON.stringify({ phase: 'published', commit: null, spent: 0, reportedUsage: 0 }));
  await collect({ reportPath: input, reportDir: join(dir, 'noop'), summaryPath: summary });
  const noop = await readFile(summary, 'utf8');
  assert.match(noop, /incident ledger/); assert.match(noop, /do not breed commits for sport/); assert.match(noop, /no-op, not released/);
  await writeFile(input, JSON.stringify({ phase: 'failed', reason: 'budget-or-deadline', spent: 1 }));
  await collect({ reportPath: input, reportDir: join(dir, 'failed'), summaryPath: summary });
  const failed = await readFile(summary, 'utf8');
  assert.match(failed, /Optimism has been escorted off/); assert.match(failed, /Outcome: \*\*failed\*\*/); assert.match(failed, /budget-or-deadline/);
});
test('missing report creates truthful interrupted fallback only in explicit artifact directory', async t => {
  const dir = await scratch(t); const out = join(dir, 'artifact');
  const result = await collect({ reportPath: join(dir, 'missing.json'), reportDir: out });
  assert.equal(result.outcome, 'unknown/interrupted'); assert.equal(JSON.parse(await readFile(join(out, 'report.json'), 'utf8')).outcome, 'unknown/interrupted');
});
