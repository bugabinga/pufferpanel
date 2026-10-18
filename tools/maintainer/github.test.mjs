import assert from 'node:assert/strict';
import test from 'node:test';
import { collectGitHubSnapshot, authorTrust } from './github.mjs';

const response = (value, status = 200, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => value });
test('bounded GitHub intake uses fixed API paths and never serializes token', async () => {
  const token = 'github_pat_secret_sentinel_value_abcdefghijklmnopqrstuvwxyz123'; const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, init }); if (url.includes('/issues?') && url.includes('bugabinga')) return response({}, 410); if (url.includes('/git/ref/')) return response({ object: { sha: 'a'.repeat(40) } }); if (url.includes('/repos/') && !url.includes('/issues') && !url.includes('/pulls')) return response({ default_branch: 'trunk' }); return response([{ number: 4, title: `title ${token}`, body: token, user: { login: 'author' }, updated_at: '2026-04-03T00:00:00Z' }], 200, { link: '<next>; rel="next"' }); };
  const intake = await collectGitHubSnapshot({ fetchImpl, token }); const serialized = JSON.stringify(intake);
  assert.equal(intake.own.issues.disabled, true); assert.equal(intake.upstream.prs.truncated, true); assert.ok(!serialized.includes(token));
  assert.ok(seen.every(request => request.url.startsWith('https://api.github.com/repos/'))); assert.ok(seen.every(request => !request.url.includes(token)));
  assert.equal(seen.filter(request => request.init.headers.Authorization).length, 4);
});
test('author trust uses current permission or push and fails closed', async () => {
  for (const [body, eligible] of [[{ permission: 'write' }, true], [{ permission: 'read', permissions: { push: true } }, true], [{ permission: 'read' }, false], [null, false]]) {
    const value = await authorTrust('maintainer', { token: 'x', fetchImpl: async () => body === null ? response({}, 500) : response(body) }); assert.equal(value.eligible, eligible);
  }
  assert.equal((await authorTrust('../bad')).eligible, false);
});
