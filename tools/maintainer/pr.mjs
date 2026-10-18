import { execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import { authorTrust } from './github.mjs';
import { OWN, isSha } from './task.mjs';
const execFile = promisify(callback);
export const git = async (cwd, ...args) => (await execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
export const ancestor = async (cwd, a, b) => { try { await git(cwd, 'merge-base', '--is-ancestor', a, b); return true; } catch { return false; } };
export async function githubRead(path, { fetchImpl = fetch, token = process.env.GH_TOKEN } = {}) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'honest-annie' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res; try { res = await fetchImpl(`https://api.github.com/repos/${OWN}${path}`, { headers, signal: AbortSignal.timeout(10000) }); } catch { throw Error('GitHub read unavailable'); }
  if (!res.ok) throw Error(`GitHub read http-${res.status}`);
  if (/(?:^|,)\s*<[^>]+>;\s*rel="next"/.test(res.headers.get('link') ?? '')) throw Error('GitHub pagination truncated');
  const value = await res.json();
  if (Array.isArray(value) && value.length > 100) throw Error('GitHub pagination coverage exceeded');
  return value;
}
export async function protectedPolicy(read, commit) {
  const root = await read(`/git/trees/${commit}`);
  const entries = value => {
    if (!Array.isArray(value?.tree) || value.truncated) throw Error('protected policy tree unavailable');
    return value.tree;
  };
  const github = entries(root).find(entry => entry.path === '.github');
  const tools = root.tree.find(entry => entry.path === 'tools');
  if (!isSha(github?.sha) || !isSha(tools?.sha)) throw Error('protected policy tree incomplete');
  const maintainer = entries(await read(`/git/trees/${tools.sha}`)).find(entry => entry.path === 'maintainer');
  if (!isSha(maintainer?.sha)) throw Error('protected maintainer tree incomplete');
  return JSON.stringify({ github: github.sha, maintainer: maintainer.sha });
}
export async function checkPR(task, options = {}) {
  const read = path => githubRead(path, options);
  const pr = await read(`/pulls/${task.number}`);
  if (pr.number !== task.number || pr.state !== 'open' || pr.draft !== false || pr.head?.sha !== task.head || pr.user?.login !== task.author || pr.base?.repo?.full_name !== OWN || pr.base?.ref !== 'trunk') throw Error('PR head/target/author/lifecycle changed');
  const trust = await authorTrust(task.author, options);
  if (!trust.eligible) throw Error(`PR author blocked: ${trust.reason}`);
  const statuses = await read(`/commits/${task.head}/status?per_page=100`);
  const checks = await read(`/commits/${task.head}/check-runs?per_page=100&filter=latest`);
  if (!Array.isArray(statuses.statuses) || !Number.isInteger(statuses.total_count) || statuses.total_count !== statuses.statuses.length || statuses.statuses.length > 100 || !Array.isArray(checks.check_runs) || checks.total_count !== checks.check_runs.length || checks.check_runs.length > 100 || statuses.statuses.length + checks.check_runs.length < 1 || statuses.statuses.some(s => s.state !== 'success') || checks.check_runs.some(c => c.status !== 'completed' || !['success', 'neutral', 'skipped'].includes(c.conclusion))) throw Error('PR checks unsatisfied or unknown');
  // Read branch and effective rules last, never use an admin bypass.
  await checkBranchPolicy(options);
  return { authorRole: trust.reason, checks: 'satisfied', policy: 'unprotected' };
}
export async function checkBranchPolicy(options = {}) {
  const branch = await githubRead('/branches/trunk', options);
  const rules = await githubRead('/rules/branches/trunk?per_page=100', options);
  if (branch.protected !== false || !Array.isArray(rules) || rules.length) throw Error('PR protected/rules policy blocked or unknown');
}
export async function verifyPRHistory(cwd, task, tree = null) {
  if (!await ancestor(cwd, task.base, task.head)) throw Error('PR base not ancestor of head');
  const history = await git(cwd, 'rev-list', '--parents', `${task.base}..${task.head}`);
  if (!history || history.split('\n').some(line => line.split(' ').length !== 2)) throw Error('unsupported PR merge history');
  const protectedPaths = await git(cwd, 'log', '--format=', '--name-only', `${task.base}..${task.head}`, '--', '.github', 'tools/maintainer');
  if (protectedPaths) throw Error('PR introduced trusted harness or CI changes');
  const actual = await git(cwd, 'rev-parse', `${task.head}^{tree}`);
  if (tree && tree !== actual) throw Error('PR exact tree mismatch');
  return actual;
}
export async function materializePR(cwd, task, options = {}) {
  const diagnostics = await checkPR(task, options);
  if (options.diagnostics) Object.assign(options.diagnostics, diagnostics);
  if (await git(cwd, 'rev-parse', 'HEAD') !== task.base || await git(cwd, 'status', '--porcelain')) throw Error('PR preparation requires clean pinned base');
  await git(cwd, 'fetch', '--no-tags', options.ownUrl ?? 'origin', `refs/pull/${task.number}/head`);
  if (await git(cwd, 'rev-parse', 'FETCH_HEAD') !== task.head) throw Error('fetched PR head changed');
  const tree = await verifyPRHistory(cwd, task);
  await git(cwd, 'read-tree', '--reset', '-u', task.head);
  return tree;
}
