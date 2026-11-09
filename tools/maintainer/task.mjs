import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
export const OWN = 'bugabinga/pufferpanel';
export const REF = 'refs/heads/trunk';
// Trusted harness and CI policy: bot edits are refused here (guard.mjs) and by every post-hoc source check.
export const PROTECTED_PATHS = Object.freeze(['tools/maintainer', '.github']);
// Harness self-repair: a $5 cap, delivery only as a PR from its own branch, never trunk; Annie never integrates these PRs.
export const HARNESS_CAP = 5;
export const HARNESS_BRANCH_PREFIX = 'annie/harness/';
export const harnessBranch = fingerprint => `${HARNESS_BRANCH_PREFIX}${fingerprint.slice(0, 12)}`;
// Every fixed gate step name: product gate.sh, then harness-gate.sh.
export const GATE_NAMES = Object.freeze(['whitespace', 'node', 'ace', 'tests-image', 'go-normal', 'go-race', 'go-vet', 'actionlint', 'harness-scope', 'harness-whitespace', 'harness-npm-ci', 'harness-test', 'harness-shell', 'harness-yaml', 'harness-actionlint']);
export const isSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export const versionFor = day => day.split('-').map(Number).join('.');
export const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const providerId = value => typeof value === 'string' && PROVIDER_ID.test(value);
// Cross-run provider holds from trusted observation: unique bounded provider ids, quota|auth, epoch-ms expiry.
export function validateHolds(value) {
  if (!Array.isArray(value) || value.length > 64 || value.some(hold => !hold || typeof hold !== 'object' || Object.keys(hold).sort().join() !== 'provider,reason,until' || !providerId(hold.provider) || !['quota', 'auth'].includes(hold.reason) || !Number.isSafeInteger(hold.until) || hold.until <= 0) || new Set(value.map(hold => hold.provider)).size !== value.length) throw Error('malformed provider holds');
  return value;
}
// Cross-run rejection memory: changed-file areas of review-rejected maintenance candidates, held 30 days by trusted observation.
export const REJECTION_DAYS = 30;
export const SAFE_PATH = /^[A-Za-z0-9._@+=,~/-]{1,160}$/;
export const FINDING_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const realDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
// Candidate area: at most 20 sorted safe paths, the full count, and a digest of every changed path; fewer paths than count is partial.
export function changedFiles(paths) {
  const all = [...new Set(paths.filter(Boolean))].sort();
  return { files: all.filter(path => SAFE_PATH.test(path)).slice(0, 20), count: all.length, digest: createHash('sha256').update(all.join('\n')).digest('hex') };
}
export const validChanged = value => Boolean(value) && typeof value === 'object' && Object.keys(value).sort().join() === 'count,digest,files' && Array.isArray(value.files) && value.files.length <= 20 && value.files.every((path, index) => typeof path === 'string' && SAFE_PATH.test(path) && (index === 0 || value.files[index - 1] < path)) && Number.isSafeInteger(value.count) && value.count >= Math.max(1, value.files.length) && value.count <= 100_000 && /^[a-f0-9]{64}$/.test(value.digest ?? '');
export const validFindings = (value, max) => Array.isArray(value) && value.length <= max && value.every(item => item && typeof item === 'object' && Object.keys(item).sort().join() === 'id,impact' && FINDING_ID.test(item.id ?? '') && typeof item.impact === 'string' && item.impact.length <= 160 && !/[\x00-\x1f\x7f]/.test(item.impact));
export function validateRejections(value) {
  if (!Array.isArray(value) || value.length > 20 || value.some(entry => !entry || typeof entry !== 'object' || Object.keys(entry).sort().join() !== 'count,day,digest,files,findings,runId' || !Number.isSafeInteger(entry.runId) || entry.runId <= 0 || !realDay(entry.day) || !validChanged({ files: entry.files, count: entry.count, digest: entry.digest }) || !validFindings(entry.findings, 5)) || new Set(value.map(entry => entry.runId)).size !== value.length) throw Error('malformed rejection memory');
  return value;
}
export const activeRejections = (entries, now = Date.now()) => entries.filter(entry => Date.parse(`${entry.day}T00:00:00Z`) > now - REJECTION_DAYS * 86_400_000);
const jaccard = (a, b) => { const left = new Set(a), shared = b.filter(path => left.has(path)).length; return shared / (left.size + b.length - shared); };
// Same changed-path set, or Jaccard ≥ 0.6 between two complete path lists.
export const sameArea = (a, b) => a.digest === b.digest || a.count === a.files.length && b.count === b.files.length && jaccard(a.files, b.files) >= 0.6;
// A candidate repeats a rejected idea once its area was review-rejected at least twice within 30 days.
export const repeatRejected = (candidate, entries, now = Date.now()) => activeRejections(entries, now).filter(entry => sameArea(candidate, entry)).length >= 2;
export function validateTask(value) {
  const keys = ['kind', 'day', 'repo', 'ref', 'base', 'upstreamSha', 'upstreamRef', 'number', 'head', 'author', 'fingerprint', 'incident'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw Error('invalid selected task fields');
  if (!['maintenance', 'pr', 'management', 'harness'].includes(value.kind) || value.repo !== OWN || value.ref !== REF || !/^\d{4}-\d{2}-\d{2}$/.test(value.day ?? '') || new Date(value.day + 'T00:00:00Z').toISOString().slice(0, 10) !== value.day || !isSha(value.base) || !isSha(value.upstreamSha) || !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(value.upstreamRef ?? '') || value.upstreamRef.includes('..') || value.upstreamRef.includes('//') || value.upstreamRef.endsWith('/') || value.upstreamRef.split('/').some(part => part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock')) || !/^[a-f0-9]{64}$/.test(value.fingerprint ?? '')) throw Error('invalid selected task identity');
  if (value.kind === 'pr') {
    if (!Number.isSafeInteger(value.number) || value.number < 1 || value.number > 2147483647 || !isSha(value.head) || !/^[A-Za-z0-9-]{1,39}$/.test(value.author ?? '')) throw Error('invalid selected PR');
  } else if (['number', 'head', 'author'].some(key => key in value)) throw Error('unexpected PR fields');
  if (value.kind === 'harness' ? !/^[a-f0-9]{64}$/.test(value.incident ?? '') : 'incident' in value) throw Error('invalid harness incident');
  return Object.freeze({ ...value });
}
export const selectedTask = (env = process.env) => env.PUFFER_MAINT_TASK ? validateTask(JSON.parse(env.PUFFER_MAINT_TASK)) : null;
export function bindTask(run, task) {
  if (!task) { if (run.taskKind === 'pr') throw Error('trusted PR task required'); return; }
  if (run.taskKind !== task.kind || run.day !== task.day || run.base !== task.base || run.upstreamSha !== task.upstreamSha || run.upstreamRef !== task.upstreamRef || run.fingerprint !== task.fingerprint || (task.kind === 'pr' && (run.prNumber !== task.number || run.prHead !== task.head || run.prAuthor !== task.author || run.releaseCommit !== task.head)) || (task.kind === 'harness' && run.incident !== task.incident)) throw Error('candidate differs from trusted task');
}
export const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
