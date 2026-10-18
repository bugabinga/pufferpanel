import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { defineDoc, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { Type } from '@earendil-works/pi-ai';
import { createHash } from 'node:crypto';
import { redact } from './report.mjs';

const execFile = promisify(execFileCallback);
const API = 'https://api.github.com';
const OWN = 'bugabinga/pufferpanel';
const UPSTREAM = 'pufferpanel/pufferpanel';
const limit = 30;
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) ? value : null;
const issueNumber = value => Number.isInteger(value) && value > 0 && value <= 2_147_483_647;
const safe = (value, token = null) => redact(String(value ?? '')).split(token || '\u0000').join('[redacted]').slice(0, 4000);
const git = async (cwd, ...args) => (await execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 })).stdout.trim();
export const RootDoc = defineDoc({ kind: 'pufferpanel.github.plans', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({ allowlist: ['add-label', 'comment', 'create-issue', 'enable-issues'], plans: [] }) });
export const GitHubPlansDoc = RootDoc;

async function request(fetchImpl, path, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'honest-annie' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetchImpl(`${API}${path}`, { method: 'GET', headers, signal: controller.signal });
    if (!response.ok) return { error: `http-${response.status}` };
    return { value: await response.json(), truncated: /(?:^|,)\s*<[^>]+>;\s*rel="next"/.test(response.headers.get('link') ?? '') };
  } catch { return { error: 'network-or-timeout' }; } finally { clearTimeout(timer); }
}
const summary = (item, token) => ({ number: item?.number, title: safe(item?.title, token).slice(0, 500), updatedAt: typeof item?.updated_at === 'string' ? item.updated_at : null, author: typeof item?.user?.login === 'string' ? item.user.login.slice(0, 100) : null, head: sha(item?.head?.sha), draft: Boolean(item?.draft), body: safe(item?.body, token) });
async function queue(fetchImpl, repo, kind, token, redactionToken = token) {
  const response = await request(fetchImpl, `/repos/${repo}/${kind}?state=open&per_page=${limit}`, token);
  if (response.error) return { error: response.error, items: [], truncated: true };
  return { items: Array.isArray(response.value) ? response.value.slice(0, limit).map(item => summary(item, redactionToken)) : [], truncated: response.truncated };
}
export async function collectGitHubSnapshot({ fetchImpl = fetch, token = null } = {}) {
  const [own, upstream] = await Promise.all([request(fetchImpl, `/repos/${OWN}`, token), request(fetchImpl, `/repos/${UPSTREAM}`, null)]);
  const ownBranch = own.value?.default_branch;
  const upstreamBranch = upstream.value?.default_branch;
  const ref = (repo, branch, auth) => /^[A-Za-z0-9._/-]{1,255}$/.test(branch ?? '') ? request(fetchImpl, `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, auth) : Promise.resolve({ error: 'invalid-default-branch' });
  const [ownHead, ownIssues, ownPrs, upstreamHead, upstreamIssues, upstreamPrs] = await Promise.all([
    ref(OWN, ownBranch, token), queue(fetchImpl, OWN, 'issues', token), queue(fetchImpl, OWN, 'pulls', token),
    ref(UPSTREAM, upstreamBranch, null), queue(fetchImpl, UPSTREAM, 'issues', null, token), queue(fetchImpl, UPSTREAM, 'pulls', null, token),
  ]);
  const disabled = ownIssues.error === 'http-410';
  return {
    own: { repo: OWN, metadata: own.error ? { error: own.error } : { defaultBranch: ownBranch ?? null }, head: ownHead.error ? { error: ownHead.error } : { sha: sha(ownHead.value?.object?.sha) }, issues: disabled ? { disabled: true, items: [], truncated: false } : ownIssues, prs: ownPrs },
    upstream: { repo: UPSTREAM, metadata: upstream.error ? { error: upstream.error } : { defaultBranch: upstreamBranch ?? null }, head: upstreamHead.error ? { error: upstreamHead.error } : { sha: sha(upstreamHead.value?.object?.sha) }, issues: upstreamIssues, prs: upstreamPrs },
  };
}
export async function writeIntake(snapshot) {
  const dir = await mkdtemp(join(tmpdir(), 'pufferpanel-intake-'));
  const path = join(dir, 'snapshot.json');
  await writeFile(path, JSON.stringify(snapshot), { mode: 0o600 });
  return path;
}
export async function authorTrust(login, { fetchImpl = fetch, token = null } = {}) {
  if (!/^[A-Za-z0-9-]{1,39}$/.test(login ?? '')) return { eligible: false, reason: 'invalid-login' };
  const response = await request(fetchImpl, `/repos/${OWN}/collaborators/${encodeURIComponent(login)}/permission`, token);
  if (response.error) return { eligible: false, reason: response.error };
  const permission = response.value?.permission;
  const eligible = ['write', 'maintain', 'admin'].includes(permission) || response.value?.user?.permissions?.push === true || response.value?.permissions?.push === true;
  return { eligible, reason: eligible ? `permission-${permission ?? 'push'}` : 'insufficient-permission' };
}
export function validateActions(actions) {
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 10) throw Error('actions must contain 1..10 entries');
  return actions.map(action => {
    if (!action || typeof action !== 'object' || Object.keys(action).some(key => !['kind', 'number', 'labels', 'title', 'body', 'expectedUpdatedAt'].includes(key)) || !['add-label', 'comment', 'create-issue', 'enable-issues'].includes(action.kind)) throw Error('unsupported GitHub action');
    if (action.kind !== 'create-issue' && action.kind !== 'enable-issues' && !issueNumber(action.number)) throw Error('invalid GitHub object number');
    if (action.kind === 'add-label' && (!Array.isArray(action.labels) || action.labels.length < 1 || action.labels.length > 10 || action.labels.some(label => typeof label !== 'string' || !label.trim() || label.length > 80))) throw Error('invalid labels');
    if (action.kind === 'create-issue' && (typeof action.title !== 'string' || !action.title.trim() || action.title.length > 500)) throw Error('invalid issue title');
    if (['comment', 'create-issue'].includes(action.kind) && (typeof action.body !== 'string' || !action.body.trim() || action.body.length > 4000)) throw Error('invalid action body');
    if (action.kind !== 'create-issue' && action.kind !== 'enable-issues' && (typeof action.expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(action.expectedUpdatedAt)))) throw Error('invalid expectedUpdatedAt');
    return { kind: action.kind, number: action.number ?? null, labels: action.labels?.map(label => safe(label).trim()) ?? null, title: action.kind === 'create-issue' ? safe(action.title).trim() : null, body: action.body ? safe(action.body) : null, expectedUpdatedAt: action.expectedUpdatedAt ?? null };
  });
}
const actionSchema = Type.Object({ kind: Type.String(), number: Type.Optional(Type.Integer()), labels: Type.Optional(Type.Array(Type.String())), title: Type.Optional(Type.String()), body: Type.Optional(Type.String()), expectedUpdatedAt: Type.Optional(Type.String()) }, { additionalProperties: false });
const gitOk = async (cwd, ...args) => { try { await git(cwd, ...args); return true; } catch { return false; } };
export function installGitHubTools(registry, { root, worktree, runDoc }) {
  const merge = defineTool({ name: 'merge_upstream', description: 'Merge only upstream SHA pinned by trusted preparation. Never commits.', parameters: Type.Object({}), replay: 'unsafe', execute: async (_args, api, context) => {
    const run = (await api.snapshot(runDoc, root.id, context))?.run;
    if (!sha(run?.upstreamSha) || !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(run?.upstreamRef ?? '')) throw Error('prepared upstream pin unavailable');
    const base = await git(worktree, 'rev-parse', 'HEAD');
    if (base !== run.base) throw Error('prepared base changed');
    if (await gitOk(worktree, 'merge-base', '--is-ancestor', run.upstreamSha, 'HEAD')) return { output: [{ type: 'text', text: JSON.stringify({ base, upstreamSha: run.upstreamSha, conflicts: [], merged: false, alreadyContained: true }) }] };
    try { await git(worktree, 'merge', '--no-commit', '--no-ff', run.upstreamSha); } catch { /* inspect conflict state below */ }
    await git(worktree, 'restore', '--source', base, '--staged', '--worktree', '--', '.github', 'tools/maintainer');
    const conflicts = (await git(worktree, 'diff', '--name-only', '--diff-filter=U')).split('\n').filter(Boolean);
    if (conflicts.length) return { output: [{ type: 'text', text: JSON.stringify({ base, upstreamSha: run.upstreamSha, conflicts, merged: false }) }] };
    const mergeHead = await git(worktree, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').catch(() => null);
    if (mergeHead !== run.upstreamSha) throw Error('upstream merge refused');
    if (await gitOk(worktree, 'diff', '--quiet', base, '--', '.github', 'tools/maintainer')) return { output: [{ type: 'text', text: JSON.stringify({ base, upstreamSha: run.upstreamSha, conflicts: [], merged: true }) }] };
    throw Error('protected paths changed by upstream merge');
  } });
  const propose = defineTool({ name: 'propose_github', description: 'Persist one bounded non-executing GitHub management proposal for this run.', parameters: Type.Object({ actions: Type.Array(actionSchema, { minItems: 1, maxItems: 10 }) }), replay: 'safe', execute: async ({ actions }, api, context) => {
    const run = (await api.snapshot(runDoc, root.id, context))?.run;
    if (!run?.requestId || !run?.day) throw Error('active maintenance run unavailable');
    const plan = { actions: validateActions(actions), at: Date.now(), runId: run.requestId };
    plan.hash = createHash('sha256').update(JSON.stringify(plan.actions)).digest('hex');
    await api.commit(async tx => {
      const doc = await tx.doc(GitHubPlansDoc, root.id);
      doc.plans = (doc.plans ?? []).filter(item => item.runId === run.requestId);
      if (doc.plans.some(item => item.hash === plan.hash)) return;
      if (doc.plans.reduce((count, item) => count + item.actions.length, 0) + plan.actions.length > 10) throw Error('active GitHub plan exceeds ten actions');
      doc.plans.push(plan);
    }, context);
    return { output: [{ type: 'text', text: JSON.stringify({ proposed: plan.actions.map(action => ({ kind: action.kind, number: action.number, title: action.title, labels: action.labels })) }) }] };
  } });
  const extension = defineExtension({ name: 'pufferpanel-github', tools: [merge, propose] }); registry.install(extension); return extension;
}
export function installGitHubPlanReader(registry, root) {
  const reader = defineTool({ name: 'read_github_plans', description: 'Read persisted bounded GitHub management proposals. Read only.', parameters: Type.Object({}), replay: 'safe', execute: async (_args, api, context) => {
    const plans = (await api.snapshot(GitHubPlansDoc, root.id, context))?.plans ?? [];
    return { output: [{ type: 'text', text: JSON.stringify(plans) }] };
  } });
  const extension = defineExtension({ name: 'pufferpanel-github-plan-reviewer', tools: [reader] }); registry.install(extension); return extension;
}
