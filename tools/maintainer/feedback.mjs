import { createHash } from 'node:crypto';
import { githubRead } from './pr.mjs';
import { OWN, bindTask } from './task.mjs';
import { redact } from './report.mjs';
// Explicit opt-in only; rejected executor proposals are never interpreted as actions.
export async function reviewFeedback(run, task, { fetchImpl = fetch, token = process.env.GH_TOKEN } = {}) {
  if (task?.kind !== 'pr' || run.phase !== 'rejected' || (run.review?.reason ?? run.reason) !== 'review-rejected' || !Array.isArray(run.review?.findings ?? run.findings) || !(run.review?.findings ?? run.findings).length) throw Error('substantive trusted reviewer rejection required');
  bindTask({ ...run, releaseCommit: task.head }, task);
  if (!token) throw Error('missing native auth');
  const findings = (run.review?.findings ?? run.findings).slice(0, 20).map(value => redact(value).slice(0, 500));
  const marker = `<!-- annie-review:${createHash('sha256').update(JSON.stringify({ head: task.head, findings })).digest('hex')} -->`;
  const read = path => githubRead(path, { fetchImpl, token });
  const current = async () => {
    const pr = await read(`/pulls/${task.number}`);
    if (pr.number !== task.number || pr.state !== 'open' || pr.draft !== false || pr.head?.sha !== task.head || pr.base?.repo?.full_name !== OWN || pr.base?.ref !== 'trunk') throw Error('feedback PR head/target/lifecycle changed');
  };
  await current();
  const reviews = await read(`/pulls/${task.number}/reviews?per_page=100`);
  if (!Array.isArray(reviews)) throw Error('feedback idempotence coverage unknown');
  if (reviews.some(review => review.commit_id === task.head && review.body?.includes(marker))) return { kind: 'review-comment', number: task.number, status: 'skipped', reason: 'already-applied' };
  await current();
  const body = `☠️ Automated read-only review: blockers found. Confidence is not a test suite.\n${findings.map(finding => `* ${finding}`).join('\n')}\n\nAnnie, automated maintainer. Fix the evidence, not the verdict.\n${marker}`;
  let response;
  try { response = await fetchImpl(`https://api.github.com/repos/${OWN}/pulls/${task.number}/reviews`, { method: 'POST', headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'honest-annie', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ commit_id: task.head, event: 'COMMENT', body }), signal: AbortSignal.timeout(10000) }); } catch { throw Error('feedback unavailable'); }
  if (!response.ok) throw Error(`feedback http-${response.status}`);
  return { kind: 'review-comment', number: task.number, status: 'applied' };
}
