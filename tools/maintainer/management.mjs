import { createHash } from 'node:crypto';
import { validateActions } from './github.mjs';
import { redact } from './report.mjs';
import { OWN, isSha } from './task.mjs';
import { githubRead } from './pr.mjs';
export const planHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clean = action => Object.fromEntries(Object.entries(action).map(([key, value]) => [key, typeof value === 'string' ? redact(value) : Array.isArray(value) ? value.map(v => redact(v)) : value]));
export function approvedPlan(run, plans) {
  if (run.review?.approve !== true) throw Error('explicit management approval required');
  const actions = validateActions(plans.flatMap(plan => plan.actions)).map(clean);
  if (actions.some(a => a.kind === 'enable-issues') && run.taskKind !== 'management') throw Error('enable-issues requires selected management task');
  const payload = { repo: OWN, day: run.day, base: run.base, tree: run.tree, taskKind: run.taskKind ?? 'maintenance', fingerprint: run.fingerprint ?? null, prHead: run.prHead ?? null, approved: true, actions };
  return { ...payload, hash: planHash(payload) };
}
export function validatePlan(plan, run) {
  if (!plan || Object.keys(plan).sort().join(',') !== ['repo', 'day', 'base', 'tree', 'taskKind', 'fingerprint', 'prHead', 'approved', 'actions', 'hash'].sort().join(',')) throw Error('invalid management artifact fields');
  const { hash, ...payload } = plan;
  if (hash !== planHash(payload) || plan.repo !== OWN || plan.approved !== true || !isSha(plan.base) || !isSha(plan.tree) || plan.base !== run.base || plan.tree !== run.tree || plan.day !== run.day || plan.taskKind !== (run.taskKind ?? 'maintenance') || plan.fingerprint !== (run.fingerprint ?? null) || plan.prHead !== (run.prHead ?? null)) throw Error('management approval/hash/source mismatch');
  const actions = validateActions(plan.actions).map(clean);
  if (run.managementPlanHash && run.managementPlanHash !== planHash(actions)) throw Error('management plan differs from reviewed checkpoint');
  if (JSON.stringify(actions) !== JSON.stringify(plan.actions) || actions.some(a => a.kind === 'enable-issues') && plan.taskKind !== 'management') throw Error('management artifact not sanitized or authorized');
  return actions;
}
const footer = '\n\n🌻 Annie, automated maintainer.';
export async function executePlan(plan, run, { fetchImpl = fetch, token = process.env.GH_TOKEN, adminToken = process.env.ANNIE_GH_TOKEN } = {}) {
  const actions = validatePlan(plan, run);
  const receipts = [];
  const read = (path, auth = token) => githubRead(path, { fetchImpl, token: auth });
  const mutate = async (path, method, body, auth) => {
    let response;
    try { response = await fetchImpl(`https://api.github.com/repos/${OWN}${path}`, { method, headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'honest-annie', Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) }); } catch { throw Error('GitHub mutation unavailable'); }
    if (!response.ok) throw Error(`GitHub mutation http-${response.status}`);
  };
  for (const action of actions) {
    const receipt = { kind: action.kind, number: action.number, status: 'failed' };
    try {
      const admin = action.kind === 'enable-issues'; const auth = admin ? adminToken : token;
      if (!auth) throw Error(admin ? 'missing admin auth' : 'missing native auth');
      const repo = await read('', auth);
      if (repo.full_name !== OWN || (admin ? repo.permissions?.admin !== true : repo.permissions?.push !== true)) throw Error('unknown or insufficient permission class');
      if (admin) {
        if (repo.has_issues === true) { receipt.status = 'skipped'; receipt.reason = 'already-enabled'; }
        else if (repo.has_issues !== false) throw Error('unknown issues setting');
        else { await mutate('', 'PATCH', { has_issues: true }, auth); receipt.status = 'applied'; }
      } else {
        if (action.kind === 'create-issue' && repo.has_issues !== true) throw Error('issues-disabled-or-unknown');
        const { expectedUpdatedAt, ...stable } = action;
        const marker = `<!-- annie:${planHash({ repo: OWN, action: stable })} -->`;
        let target = null;
        if (action.number) {
          target = await read(`/issues/${action.number}`);
          if (target.number !== action.number) throw Error('wrong target identity');
          if (!target.pull_request && repo.has_issues !== true) throw Error('issues-disabled-or-unknown');
          if (target.pull_request && run.taskKind === 'pr') {
            const pr = await read(`/pulls/${action.number}`);
            if (action.number !== run.prNumber || pr.head?.sha !== run.prHead) throw Error('PR management head changed');
          }
        }
        if (action.kind === 'add-label') {
          const labels = await read(`/issues/${action.number}/labels?per_page=100`);
          if (!Array.isArray(labels)) throw Error('unknown labels');
          if (action.labels.every(label => labels.some(item => item.name === label))) { receipt.status = 'skipped'; receipt.reason = 'already-applied'; }
        } else {
          const existing = await read(action.kind === 'comment' ? `/issues/${action.number}/comments?per_page=100` : '/issues?state=all&per_page=100');
          if (!Array.isArray(existing)) throw Error('unknown idempotence coverage');
          if (existing.some(item => typeof item.body === 'string' && item.body.includes(marker))) { receipt.status = 'skipped'; receipt.reason = 'already-applied'; }
        }
        if (receipt.status !== 'skipped' && target && (target.state !== 'open' || target.updated_at !== expectedUpdatedAt)) { receipt.status = 'skipped'; receipt.reason = 'stale-target'; }
        if (receipt.status !== 'skipped' && target) {
          const fresh = await read(`/issues/${action.number}`);
          if (fresh.number !== action.number || fresh.state !== 'open' || fresh.updated_at !== expectedUpdatedAt) { receipt.status = 'skipped'; receipt.reason = 'stale-target'; }
        }
        if (receipt.status !== 'skipped') {
          if (action.kind === 'add-label') await mutate(`/issues/${action.number}/labels`, 'POST', { labels: action.labels }, auth);
          if (action.kind === 'comment') await mutate(`/issues/${action.number}/comments`, 'POST', { body: action.body + footer + '\n' + marker }, auth);
          if (action.kind === 'create-issue') await mutate('/issues', 'POST', { title: action.title, body: action.body + footer + '\n' + marker }, auth);
          receipt.status = 'applied';
        }
      }
    } catch (error) { receipt.reason = redact(error.message).slice(0, 200); }
    receipts.push(receipt);
  }
  return receipts;
}
