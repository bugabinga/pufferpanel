import test from 'node:test';
import assert from 'node:assert/strict';
import { activeRejections, changedFiles, repeatRejected, sameArea, validChanged, validFindings, validateRejections } from './task.mjs';
import { foldRejections } from './controller.mjs';
import { rejectionMemory } from './maintain.mjs';
import { reportFor } from './report.mjs';

const now = Date.parse('2026-11-16T04:17:00Z'), day = offset => new Date(now - offset * 86_400_000).toISOString().slice(0, 10);
const backup = ['client/src/backup.js', 'web/backup/download.go', 'web/backup/download_test.go'];
const entry = (runId, offset, paths = backup) => ({ runId, day: day(offset), ...changedFiles(paths), findings: [{ id: 'unbounded-range', impact: 'serves bytes past the archive end' }] });
const record = (id, settlement, kind = 'maintenance', taskDay = '2026-11-02') => ({ run: { id }, lease: { task: { kind, day: taskDay } }, settlement });
const rejected = (paths, extra = {}) => { const report = reportFor({ taskKind: 'maintenance', phase: 'rejected', changedFiles: changedFiles(paths), review: { approve: false, reason: 'review-rejected', findings: ['[blocking] unbounded-range: x'], checked: ['diff'], blocking: [{ id: 'unbounded-range', impact: 'serves bytes\u0007 past the archive end' }] }, ...extra }); return report; };

test('areas: same files or Jaccard ≥ 0.6 on complete lists; a repeat needs two rejections within 30 days', () => {
  const candidate = changedFiles([...backup].reverse());
  assert.deepEqual(candidate, changedFiles(backup)); assert.equal(candidate.count, 3);
  assert.equal(repeatRejected(candidate, [entry(1, 14)], now), false, 'one rejection is not a pattern');
  assert.equal(repeatRejected(candidate, [entry(1, 14), entry(2, 7)], now), true, 'the 11-02 and 11-09 rejections');
  assert.equal(repeatRejected(candidate, [entry(1, 31), entry(2, 7)], now), false, 'older than 30 days');
  // Jaccard 3/5 = 0.6 matches; 2/4 = 0.5 does not; unrelated changes pass.
  assert.equal(sameArea(changedFiles(backup), changedFiles([...backup, 'docs/a.md', 'docs/b.md'])), true);
  assert.equal(sameArea(changedFiles(backup.slice(0, 2)), changedFiles([...backup.slice(0, 2), 'go.mod', 'go.sum'])), false);
  assert.equal(repeatRejected(changedFiles(['go.mod', 'go.sum']), [entry(1, 14), entry(2, 7)], now), false);
  // Partial lists (over 20 paths or unsafe names) match by the digest of every path only.
  const many = Array.from({ length: 25 }, (_, index) => `pkg/file${String(index).padStart(2, '0')}.go`), partial = changedFiles(many);
  assert.deepEqual([partial.files.length, partial.count], [20, 25]);
  assert.equal(sameArea(partial, changedFiles([...many.slice(0, 24), 'pkg/other.go'])), false);
  assert.equal(sameArea(partial, changedFiles([...many].reverse())), true);
  assert.deepEqual(changedFiles(['ok.go', 'we ird\tname.go']).files, ['ok.go']);
});

test('memory validation is strict and fails closed with one message; trusted input expires after 30 days', () => {
  const valid = [entry(1, 14), entry(2, 40)];
  assert.deepEqual(validateRejections(valid), valid);
  assert.deepEqual(rejectionMemory(JSON.stringify(valid), now), [valid[0]]); assert.deepEqual(rejectionMemory('', now), []); assert.deepEqual(rejectionMemory(undefined, now), []);
  for (const bad of ['{', '{}', JSON.stringify([{ ...valid[0], extra: 1 }]), JSON.stringify([{ ...valid[0], day: '9999-99-99' }]), JSON.stringify([{ ...valid[0], day: '2026-02-30' }]), JSON.stringify([valid[0], valid[0]]),
    JSON.stringify([{ ...valid[0], files: ['b', 'a'] }]), JSON.stringify([{ ...valid[0], files: ['../x y'] }]), JSON.stringify([{ ...valid[0], count: 0 }]), JSON.stringify([{ ...valid[0], digest: 'x' }]),
    JSON.stringify([{ ...valid[0], findings: [{ id: 'Bad ID', impact: 'x' }] }]), JSON.stringify([{ ...valid[0], findings: [{ id: 'ok', impact: 'line\nbreak' }] }]), JSON.stringify(Array.from({ length: 21 }, (_, index) => entry(index + 1, 1)))]) assert.throws(() => rejectionMemory(bad, now), /malformed rejection memory/, bad);
});

test('reports carry bounded changed files and blocking finding ids that the controller accepts, idempotently', () => {
  const report = rejected(backup);
  assert.deepEqual(report.changedFiles, changedFiles(backup)); assert.deepEqual(report.blockingFindings, [{ id: 'unbounded-range', impact: 'serves bytes  past the archive end' }]);
  assert.equal(report.reason, 'review-rejected'); assert.ok(validChanged(report.changedFiles) && validFindings(report.blockingFindings, 10));
  assert.deepEqual(reportFor(report).changedFiles, report.changedFiles); assert.deepEqual(reportFor(report).blockingFindings, report.blockingFindings);
  // A tampered run cannot make the report invalid for the controller: sorted, safe, count never below its paths.
  const tampered = reportFor({ changedFiles: { files: ['b', 'a', 'a', 'bad path', 7], count: 1, digest: 'f'.repeat(64) } }).changedFiles;
  assert.deepEqual(tampered, { files: ['a', 'b'], count: 2, digest: 'f'.repeat(64) }); assert.ok(validChanged(tampered));
  assert.equal(reportFor({ changedFiles: { files: [], count: 3, digest: 'nope' } }).changedFiles, null);
  assert.deepEqual(reportFor({ phase: 'published', reason: 'repeat-rejected' }).outcome, 'repeat-rejected');
});

test('memory accumulates review-rejected maintenance areas only, dedupes by run, keeps 20, and expires after 30 days', () => {
  const records = [
    record(10, rejected(backup)), record(10, rejected(backup)),
    record(11, rejected(backup), 'pr'), record(12, rejected(backup), 'harness'),
    record(13, { ...rejected(backup), reason: 'invalid-review' }), record(14, { ...rejected(backup), phase: 'published', reason: 'repeat-rejected' }),
    record(15, { ...rejected(backup), changedFiles: null }), record(16, null), { run: { id: 17 }, lease: null, settlement: rejected(backup) },
  ];
  const first = foldRejections([], records, now);
  assert.deepEqual(first, [{ runId: 10, day: '2026-11-02', ...changedFiles(backup), findings: [{ id: 'unbounded-range', impact: 'serves bytes  past the archive end' }] }]);
  assert.deepEqual(validateRejections(first), first);
  const second = foldRejections(first, [record(20, rejected(backup), 'maintenance', '2026-11-09')], now);
  assert.deepEqual(second.map(item => [item.runId, item.day]), [[10, '2026-11-02'], [20, '2026-11-09']]);
  assert.equal(repeatRejected(changedFiles(backup), second, now), true);
  // On 12-06 the 11-02 rejection is 34 days old and gone; 11-09 is 27 days old and still held.
  assert.deepEqual(foldRejections(second, [], now + 20 * 86_400_000).map(item => item.runId), [20]);
  assert.deepEqual(foldRejections(second, [], now + 40 * 86_400_000), []);
  const crowded = foldRejections([], Array.from({ length: 25 }, (_, index) => record(100 + index, rejected(backup))), now);
  assert.deepEqual([crowded.length, crowded[0].runId, crowded.at(-1).runId], [20, 105, 124]);
  assert.deepEqual(activeRejections(crowded, now).length, 20);
});
