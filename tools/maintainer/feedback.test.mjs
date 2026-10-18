import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewFeedback } from './feedback.mjs';
const task = { kind: 'pr', day: '2026-04-03', repo: 'bugabinga/pufferpanel', ref: 'refs/heads/trunk', base: 'a'.repeat(40), head: 'b'.repeat(40), number: 7, author: 'trusted', upstreamSha: 'c'.repeat(40), upstreamRef: 'refs/heads/trunk', fingerprint: 'd'.repeat(64) };
const run = { taskKind: 'pr', day: task.day, phase: 'rejected', base: task.base, prHead: task.head, prNumber: 7, prAuthor: task.author, upstreamSha: task.upstreamSha, upstreamRef: task.upstreamRef, fingerprint: task.fingerprint, review: { approve: false, reason: 'review-rejected', findings: ['Missing regression test.'] } };

test('optional reviewer feedback posts COMMENT on exact current H, sanitized/idempotent, never rejected executor proposal', async () => {
  const posts = [], reviews = [];
  const fetchImpl = async (url, init = {}) => {
    if (init.method === 'POST') { const body = JSON.parse(init.body); posts.push(body); reviews.push({ commit_id: body.commit_id, body: body.body }); }
    return { ok: true, status: 200, headers: new Headers(), json: async () => url.includes('/reviews?') ? reviews : { number: 7, state: 'open', draft: false, head: { sha: task.head }, base: { ref: 'trunk', repo: { full_name: task.repo } } } };
  };
  const options = { fetchImpl, token: 'native' };
  assert.equal((await reviewFeedback({ ...run, proposedActions: [{ kind: 'delete-repository' }] }, task, options)).status, 'applied');
  assert.equal((await reviewFeedback(run, task, options)).status, 'skipped');
  assert.equal(posts.length, 1); assert.equal(posts[0].event, 'COMMENT'); assert.equal(posts[0].commit_id, task.head); assert.match(posts[0].body, /automated maintainer/); assert.doesNotMatch(posts[0].body, /delete-repository/);
});

test('invalid review output is bot failure, no PR blame; head/lifecycle races and truncated review lookup block feedback', async () => {
  for (const reason of ['invalid-review', 'contradictory-review']) await assert.rejects(reviewFeedback({ ...run, review: { ...run.review, reason } }, task, { fetchImpl: () => assert.fail('no feedback fetch'), token: 'native' }));
  for (const scenario of ['head', 'closed', 'truncated', 'race']) {
    let reads = 0;
    const fetchImpl = async (url, init = {}) => {
      assert.notEqual(init.method, 'POST');
      const pr = { number: 7, state: 'open', draft: false, head: { sha: task.head }, base: { ref: 'trunk', repo: { full_name: task.repo } } };
      if (scenario === 'head' || scenario === 'race' && ++reads > 2) pr.head.sha = task.base;
      if (scenario === 'closed') pr.state = 'closed';
      return { ok: true, status: 200, headers: new Headers(scenario === 'truncated' && url.includes('/reviews?') ? { link: '<next>; rel="next"' } : {}), json: async () => url.includes('/reviews?') ? [] : pr };
    };
    await assert.rejects(reviewFeedback(run, task, { fetchImpl, token: 'native' }));
  }
});
