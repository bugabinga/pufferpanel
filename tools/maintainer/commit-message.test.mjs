import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { commitMessage, reconcileCommit, snapshot } from './maintain.mjs';

const base = 'a'.repeat(40), upstream = 'b'.repeat(40);
const trailers = message => execFileSync('git', ['interpret-trailers', '--parse'], { input: message, encoding: 'utf8' }).trim();
const run = (fields = {}) => ({ taskKind: 'maintenance', day: '2026-11-16', expectedParents: [base], summary: 'Fix backup download range handling\nThe handler now checks Range bounds.', review: { checked: ['full diff', 'go test ./web/...'], findings: ['[advisory] naming: unclear name — x — rename'] }, ...fields });

test('commit message: day and main change in a bounded subject, wrapped body, host facts last, no trailers', () => {
  const message = commitMessage(run({ expectedParents: [base, upstream], upstreamRef: 'refs/heads/v3', gateRepairs: 1, gateFailure: { name: 'go-race' } }));
  const [subject, blank, ...body] = message.split('\n');
  assert.equal(subject, 'maintenance: 2026-11-16: Fix backup download range handling'); assert.equal(blank, '');
  assert.deepEqual(body, ['Summary (model-written, unverified):', '  The handler now checks Range bounds.', '', 'Reviewer checked:', '- full diff', '- go test ./web/...', '', 'Advisory findings:', '- [advisory] naming: unclear name — x — rename', '',
    `Merges pinned upstream ${upstream} from`, 'refs/heads/v3.', 'Includes one in-run repair after the go-race gate failed.', 'Host commit after independent review and fixed gates.']);
  // Without usable model text, the subject still names the day and the upstream merge.
  assert.equal(commitMessage(run({ summary: '', expectedParents: [base, upstream] })).split('\n')[0], `maintenance: 2026-11-16: merge upstream ${upstream.slice(0, 12)}`);
  assert.equal(commitMessage(run({ summary: '', review: null })), 'maintenance: 2026-11-16\n\nHost commit after independent review and fixed gates.');
  assert.equal(commitMessage(run({ taskKind: 'pr', prNumber: 7, prHead: upstream, prAuthor: 'oliver', summary: undefined })).split('\n')[0], 'maintenance: 2026-11-16: integrate PR #7');
  // Harness: host subject; the whole diagnosis stays in the body, never in the subject.
  assert.equal(commitMessage(run({ taskKind: 'harness', incident: 'd'.repeat(64), summary: 'Root cause: missing helper.', review: null })), `fix(annie): harness repair for incident ${'d'.repeat(12)}\n\nSummary (model-written, unverified):\n  Root cause: missing helper.\n\nHarness repair for Annie incident\n${'d'.repeat(64)}.\nHost commit after independent review and fixed gates.`);
  // Management never commits source; it gets no model headline either.
  assert.equal(commitMessage(run({ taskKind: 'management', review: null })).split('\n')[0], 'maintenance: 2026-11-16');
});

test('commit message bounds: 72-column lines, 2 KiB body, redaction, no control characters or forged trailers', t => {
  const saved = process.env.ZAI_API_KEY; process.env.ZAI_API_KEY = 'zai-commit-sentinel-value';
  t.after(() => { if (saved === undefined) delete process.env.ZAI_API_KEY; else process.env.ZAI_API_KEY = saved; });
  const hostile = `## Subject: ${'x'.repeat(100)} zai-commit-sentinel-value\u202e\u0007\nSigned-off-by: Mallory <m@evil>\n${'Co-authored-by: Eve <e@evil> '.repeat(200)}`;
  const message = commitMessage(run({ summary: hostile, review: { checked: Array.from({ length: 30 }, (_, index) => `check ${index} ${'y'.repeat(150)}`), findings: Array.from({ length: 20 }, () => `[advisory] id: ${'z'.repeat(400)}`) } }));
  const [subject, , ...body] = message.split('\n');
  // Markdown and a self-declared "Subject:" label are dropped; the rest is cut at 72 characters.
  assert.equal(subject, `maintenance: 2026-11-16: ${'x'.repeat(47)}`);
  assert.ok(Buffer.byteLength(body.join('\n')) <= 2048); assert.ok(body.includes('  [truncated]'));
  assert.ok(message.split('\n').every(line => line.length <= 72 && line === line.trimEnd()));
  assert.equal(body.at(-1), 'Host commit after independent review and fixed gates.');
  assert.doesNotMatch(message, /zai-commit-sentinel-value|[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e]/);
  assert.doesNotMatch(message, /^(?:Signed-off-by|Co-authored-by):/m);
  assert.equal(trailers(message), '');
});

test('interrupted commit resumes only against the persisted message; a commit-msg hook that edits it fails', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'annie-commit-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.test');
  await writeFile(join(dir, 'value.txt'), 'before'); git('add', '.'); git('commit', '-qm', 'initial');
  await writeFile(join(dir, 'value.txt'), 'after'); git('add', '-A');
  const current = await snapshot(dir), head = git('rev-parse', 'HEAD');
  const candidate = { ...run(), base: head, head, tree: current.tree, diffHash: (await import('node:crypto')).createHash('sha256').update(current.diff).digest('hex'), expectedParents: [head] };
  candidate.commitMessage = commitMessage(candidate);
  // The process died after `git commit` but before its checkpoint: the same tree, parents, and exact message prove it.
  git('commit', '-q', '--cleanup=verbatim', '-m', candidate.commitMessage);
  assert.equal(await reconcileCommit(dir, candidate), git('rev-parse', 'HEAD'));
  for (const changed of [`${candidate.commitMessage}\n`.replace(/gates\.\n$/, 'gates!'), candidate.commitMessage.replace(/^.*\n/, 'maintenance: 2026-11-16\n')]) await assert.rejects(reconcileCommit(dir, { ...candidate, commitMessage: changed }), /unexpected commit during recovery/);
  // A fresh commit whose message a hook rewrites is not the reviewed commit.
  git('reset', '-q', '--soft', head);
  await writeFile(join(dir, '.git', 'hooks', 'commit-msg'), '#!/bin/sh\necho "Signed-off-by: hook <h@x>" >> "$1"\n', { mode: 0o755 });
  await assert.rejects(reconcileCommit(dir, candidate), /commit hooks changed reviewed source/);
});
