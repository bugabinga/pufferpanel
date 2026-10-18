import { readFile } from 'node:fs/promises';
export const OWN = 'bugabinga/pufferpanel';
export const REF = 'refs/heads/trunk';
export const isSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export function validateTask(value) {
  const keys = ['kind', 'day', 'repo', 'ref', 'base', 'upstreamSha', 'upstreamRef', 'number', 'head', 'author', 'fingerprint'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw Error('invalid selected task fields');
  if (!['maintenance', 'pr', 'management'].includes(value.kind) || value.repo !== OWN || value.ref !== REF || !/^\d{4}-\d{2}-\d{2}$/.test(value.day ?? '') || new Date(value.day + 'T00:00:00Z').toISOString().slice(0, 10) !== value.day || !isSha(value.base) || !isSha(value.upstreamSha) || !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(value.upstreamRef ?? '') || value.upstreamRef.includes('..') || value.upstreamRef.includes('//') || value.upstreamRef.endsWith('/') || value.upstreamRef.split('/').some(part => part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock')) || !/^[a-f0-9]{64}$/.test(value.fingerprint ?? '')) throw Error('invalid selected task identity');
  if (value.kind === 'pr') {
    if (!Number.isSafeInteger(value.number) || value.number < 1 || value.number > 2147483647 || !isSha(value.head) || !/^[A-Za-z0-9-]{1,39}$/.test(value.author ?? '')) throw Error('invalid selected PR');
  } else if (['number', 'head', 'author'].some(key => key in value)) throw Error('unexpected PR fields');
  return Object.freeze({ ...value });
}
export const selectedTask = (env = process.env) => env.PUFFER_MAINT_TASK ? validateTask(JSON.parse(env.PUFFER_MAINT_TASK)) : null;
export function bindTask(run, task) {
  if (!task) { if (run.taskKind === 'pr') throw Error('trusted PR task required'); return; }
  if (run.taskKind !== task.kind || run.day !== task.day || run.base !== task.base || run.upstreamSha !== task.upstreamSha || run.upstreamRef !== task.upstreamRef || run.fingerprint !== task.fingerprint || (task.kind === 'pr' && (run.prNumber !== task.number || run.prHead !== task.head || run.prAuthor !== task.author || run.releaseCommit !== task.head))) throw Error('candidate differs from trusted task');
}
export const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
