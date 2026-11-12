import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestFingerprint } from './incident.mjs';
import { controller, digest, harnessFingerprint, retryEffects, verifyUploadedLease, POLICY_PATH } from './controller.mjs';
const OWN = 'bugabinga/pufferpanel', now = Date.parse('2026-04-03T04:17:00Z'), base = 'a'.repeat(40), U = 'b'.repeat(40), tree = { tree: [{ path: '.github', sha: 'c'.repeat(40) }, { path: 'tools', sha: 'd'.repeat(40) }] };
const response = body => new Response(JSON.stringify(body));
function zip(value, name) {
  const data = Buffer.from(JSON.stringify(value)), filename = Buffer.from(name), local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + filename.length, 12); end.writeUInt32LE(30 + filename.length + data.length, 16);
  return Buffer.concat([local, filename, data, central, filename, end]);
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'annie-flow-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ANNIE_MODE: 'maintain', GITHUB_REPOSITORY: OWN, GITHUB_REF: 'refs/heads/trunk', GITHUB_SHA: base, GITHUB_REPOSITORY_ID: '7', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1', GITHUB_EVENT_NAME: 'schedule', GITHUB_EVENT_PATH: join(dir, 'event.json'), ANNIE_OUTPUT_DIR: dir, ANNIE_BOOTSTRAP: '42', HONEST_ANNIE_ENABLED: 'true', GH_TOKEN: 'readonly-sentinel' };
  await writeFile(env.GITHUB_EVENT_PATH, JSON.stringify({ schedule: '17 4 * * *' }));
  const runs = [], artifacts = new Map(), bodies = new Map(), comments = new Map(), calls = [], issues = [], jobs = [], prs = [], files = [], closedPRs = [], jobsByAttempt = new Map(), pullsAll = { fail: false };
  let clock = now, currentId = 42, registry = 404, protectedBranch = false, role = 'write', head = base, registryImpl = null, changedPolicy = null, compareImpl = null;
  const run = id => ({ id, run_attempt: 1, workflow_id: 8, path: POLICY_PATH, repository: { id: 7 }, head_repository: { id: 7 }, head_branch: 'trunk', head_sha: base, event: 'schedule', status: 'completed', created_at: new Date(clock).toISOString(), updated_at: new Date(clock).toISOString() });
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.startsWith('https://registry.')) return registryImpl ? registryImpl(url, options) : new Response(null, { status: registry });
    const u = new URL(url), path = u.pathname;
    if (path.includes('/actions/artifacts/')) return new Response(bodies.get(Number(path.split('/').at(-2))));
    const artifactRun = path.match(/\/actions\/runs\/(\d+)\/artifacts$/);
    if (artifactRun) { const items = artifacts.get(Number(artifactRun[1])) ?? []; return response({ total_count: items.length, artifacts: items }); }
    if (path.includes('/jobs') && options.method === 'POST') return new Response(null, { status: 201 });
    if (path.endsWith('/jobs')) { const selected = jobsByAttempt.get(Number(path.match(/attempts\/(\d+)/)?.[1])) ?? jobs; return response({ total_count: selected.length, jobs: selected }); }
    if (path.endsWith('/actions/workflows/8/runs')) return response({ total_count: runs.length + 1, workflow_runs: [run(currentId), ...runs] });
    if (path.endsWith('/actions/workflows/honest-annie.yml')) return response({ id: 8, path: POLICY_PATH });
    const byId = path.match(/\/actions\/runs\/(\d+)$/);
    if (byId) return response(Number(byId[1]) === currentId ? run(currentId) : runs.find(run => run.id === Number(byId[1])));
    if (path.includes('/compare/')) return compareImpl ? compareImpl(path.split('/compare/')[1]) : response({ status: 'ahead' });
    if (path.includes('/rules/branches/')) return response([]);
    if (path.endsWith('/branches/trunk')) return response({ protected: protectedBranch, commit: { sha: head } });
    if (path.endsWith(`/git/trees/${'d'.repeat(40)}`)) return response({ tree: [{ path: 'maintainer', sha: 'e'.repeat(40) }] });
    if (path.includes('/git/trees/')) return response(path.endsWith(`/${changedPolicy}`) ? { tree: [{ path: '.github', sha: '1'.repeat(40) }, tree.tree[1]] } : tree);
    if (path.includes('/git/ref/heads/')) return response({ object: { sha: U } });
    // Open PRs by default; state=all with head=owner:branch also sees closed ones, filtered like GitHub.
    if (path.endsWith('/pulls') && u.searchParams.get('state') === 'all') return pullsAll.fail ? new Response('{}', { status: 403 }) : response([...prs, ...closedPRs].filter(pr => !u.searchParams.get('head') || `bugabinga:${pr.head?.ref}` === u.searchParams.get('head')));
    if (path.endsWith('/pulls')) return response(prs);
    if (/\/pulls\/\d+\/files$/.test(path)) return response(files);
    if (/\/pulls\/\d+$/.test(path)) return response(prs.find(pr => path.endsWith(`/${pr.number}`)));
    if (path.endsWith('/permission')) return response({ permission: role });
    if (path.endsWith('/status')) return response({ statuses: [], total_count: 0 });
    if (path.endsWith('/check-runs')) return response({ check_runs: [{ status: 'completed', conclusion: 'success' }], total_count: 1 });
    if (path.endsWith('/issues')) return response(issues);
    const thread = path.match(/\/issues\/(\d+)\/comments$/);
    if (thread) return response(comments.get(Number(thread[1])) ?? []);
    if (path === `/repos/${OWN}`) return response({ id: 7, default_branch: 'trunk', has_issues: true });
    if (path === '/repos/pufferpanel/pufferpanel') return response({ default_branch: 'main' });
    throw Error('unexpected offline request ' + path);
  };
  function artifact(runId, name, filename, value, at = clock) {
    const bytes = zip(value, filename), id = bodies.size + 1;
    const meta = { id, name, expired: false, size_in_bytes: bytes.length, digest: `sha256:${digest(bytes)}`, created_at: new Date(at).toISOString() };
    bodies.set(id, bytes); artifacts.set(runId, [...artifacts.get(runId) ?? [], meta]); return meta;
  }
  const execute = async changes => controller({ env: { ...env, ...changes }, fetchImpl, now: clock, delays: [] });
  const json = async name => JSON.parse(await readFile(join(dir, name), 'utf8'));
  return { env, dir, runs, artifacts, comments, calls, issues, jobs, jobsByAttempt, prs, files, closedPRs, pullsAll, setRole: value => { role = value; }, artifact, execute, json, fetchImpl, run, setClock: v => { clock = v; }, setCurrent: id => { currentId = id; env.GITHUB_RUN_ID = String(id); }, setRegistry: v => { registry = v; }, setProtected: v => { protectedBranch = v; }, setHead: v => { head = v; }, setRegistryImpl: v => { registryImpl = v; }, setChangedPolicy: v => { changedPolicy = v; }, setCompareImpl: v => { compareImpl = v; } };
}
test('faux controller: cheap observe has no lease/registry/retry; maintain wires exact B/U task and creation-deadline lease', async t => {
  const f = await fixture(t);
  const observed = await f.execute({ ANNIE_MODE: 'observe' }); assert.equal(observed.paid, false); assert.equal(observed.bootstrap, true);
  assert.equal(f.calls.some(c => c.url.includes('registry.')), false);
  await assert.rejects(readFile(join(f.dir, 'lease.json')));
  const admitted = await f.execute(); assert.equal(admitted.state, 'admitted'); assert.equal(admitted.paid, true);
  const lease = await f.json('lease.json'); assert.equal(lease.task.base, base); assert.equal(lease.task.upstreamSha, U); assert.equal(lease.task.day, '2026-04-03'); assert.equal(lease.deadline, now + 7200000);
  assert.equal(f.calls.filter(c => c.url.includes('registry.')).length, 1);
});
test('healthy checkpoint refresh suppresses unchanged daily/noop/rejection; own labels/comments do not create paid work', async t => {
  const f = await fixture(t);
  f.issues.push({ number: 1, title: 'human input', body: 'ephemeral', state: 'open', user: { type: 'User' }, labels: [] });
  await f.execute(); const checkpoint = await f.json('checkpoint.json'), lease = await f.json('lease.json');
  f.runs.push(f.run(42)); f.artifact(42, 'annie-checkpoint-42-1', 'checkpoint.json', checkpoint); f.artifact(42, 'annie-lease-42-1', 'lease.json', lease);
  f.artifact(42, 'honest-annie-model-report-42-1', 'report.json', { ledgerReservation: lease.hash, fingerprint: lease.task.fingerprint, taskKind: lease.task.kind, day: lease.task.day, base, managementApproved: false, commit: null, releaseCommit: null, phase: 'published', usageComplete: true, reportedUsage: { status: 'known', cost: 1 } });
  f.setCurrent(43); f.issues[0].labels.push({ name: 'reviewed-by-annie' }); f.issues[0].updated_at = '2099-01-01';
  const unchanged = await f.execute(); assert.equal(unchanged.paid, false); assert.equal(unchanged.state, 'no-op');
  const refreshed = await f.json('checkpoint.json'); assert.ok(refreshed.handled.includes(lease.task.fingerprint)); assert.equal(refreshed.runId, 43); assert.deepEqual(refreshed.slots, []);
  assert.doesNotMatch(JSON.stringify(refreshed), /ephemeral|human input|readonly-sentinel/);
});
test('source-approved unpersisted pending with candidate blocks new source across midnight, no new lease', async t => {
  const f = await fixture(t); await f.execute(); const checkpoint = await f.json('checkpoint.json'), lease = await f.json('lease.json');
  f.runs.push(f.run(42)); f.artifact(42, 'annie-checkpoint-42-1', 'checkpoint.json', checkpoint); f.artifact(42, 'annie-lease-42-1', 'lease.json', lease);
  f.artifact(42, 'honest-annie-model-report-42-1', 'report.json', { ledgerReservation: lease.hash, fingerprint: lease.task.fingerprint, taskKind: lease.task.kind, day: lease.task.day, base, managementApproved: false, phase: 'publishing', commit: 'e'.repeat(40), releaseCommit: 'e'.repeat(40), usageComplete: true, reportedUsage: { status: 'known', cost: 1 } });
  f.artifact(42, 'honest-annie-candidate-42-1', 'not-downloaded', {});
  f.setClock(now + 24 * 3600000); f.setCurrent(43);
  const before = f.calls.filter(c => c.url.includes('registry.')).length;
  const pending = await f.execute(); assert.equal(pending.paid, false); assert.equal(pending.state, 'effects-pending'); assert.equal(pending.pendingEffects[0].runId, 42);
  assert.equal(f.calls.filter(c => c.url.includes('registry.')).length, before);
  assert.deepEqual((await f.json('checkpoint.json')).pendingRuns, [42]);
});
test('healthy CP → offline check without artifacts → maintain retains allowance and dedupe', async t => {
  const f = await fixture(t); await f.execute({ ANNIE_MODE: 'observe' });
  f.runs.push(f.run(42)); f.artifact(42, 'annie-checkpoint-42-1', 'checkpoint.json', await f.json('checkpoint.json'));
  f.runs.push({ ...f.run(43), event: 'workflow_dispatch' });
  f.jobs.push({ id: 201, name: 'maintain', conclusion: 'skipped' });
  f.setCurrent(44);
  const result = await f.execute(); assert.equal(result.allowance, 15); assert.equal(result.paid, true);
});
test('pre-dispatch failure frees flight/calendar, shared environment cooldown stops another PR', async t => {
  const f = await fixture(t);
  for (const number of [7, 8]) f.prs.push({ number, state: 'open', draft: false, user: { login: 'trusted', type: 'User' }, head: { sha: String(number).repeat(40), ref: 'feature' }, base: { ref: 'trunk', repo: { full_name: OWN } } });
  await f.execute(); const cp = await f.json('checkpoint.json');
  assert.deepEqual(cp.handled, []); assert.equal(cp.flights.length, 1);
  f.runs.push(f.run(42)); f.artifact(42, 'annie-checkpoint-42-1', 'checkpoint.json', cp);
  f.jobs.push({ id: 201, name: 'maintain', conclusion: 'failure', steps: [{ name: 'Validate private Podman store before model runtime and credentials', conclusion: 'failure' }, { name: 'Maintain or review selected task', conclusion: 'skipped' }] });
  f.setCurrent(43); const result = await f.execute(); assert.equal(result.allowance, 0); assert.equal(result.paid, false); assert.equal(result.readyPRs, 2);
  const next = await f.json('checkpoint.json'); assert.deepEqual(next.slots, [cp.flights[0].task.day]); assert.deepEqual(next.flights, [cp.flights[0]]);
  f.runs.push(f.run(43)); f.artifact(43, 'annie-checkpoint-43-1', 'checkpoint.json', next);
  f.setClock(now + 27 * 3600000); f.setCurrent(44);
  assert.equal((await f.execute({ ANNIE_CONFIG_REVISION: 'repaired-1' })).paid, true);
});
test('pre-lease cancelled flight holds full cap, then proves skipped effects or surfaces actionable blocker', async t => {
  const f = await fixture(t); await f.execute(); const cp = await f.json('checkpoint.json');
  f.runs.push(f.run(42)); f.artifact(42, 'annie-checkpoint-42-1', 'checkpoint.json', cp);
  f.jobs.push({ id: 201, name: 'maintain', conclusion: 'cancelled', steps: [{ name: 'Maintain or review selected task', conclusion: 'cancelled' }] });
  f.setCurrent(43);
  const blocked = await f.execute({ ANNIE_MODE: 'observe' });
  assert.equal(blocked.allowance, 0); assert.deepEqual(blocked.observationBlockers, [{ runId: 42, reason: 'admission-unreconciled' }]);
  assert.deepEqual((await f.json('checkpoint.json')).flights.map(flight => flight.runId), [42]);
  f.runs.push(f.run(43)); f.artifact(43, 'annie-checkpoint-43-1', 'checkpoint.json', await f.json('checkpoint.json'));
  f.jobs[0] = { id: 202, name: 'maintain', conclusion: 'failure', steps: [{ name: 'Maintain or review selected task', conclusion: 'skipped' }] };
  f.setClock(now + 3 * 3600000); f.setCurrent(44);
  const stillHeld = await f.execute({ ANNIE_MODE: 'observe' });
  assert.equal(stillHeld.allowance, 0); assert.equal(stillHeld.observationBlockers.length, 0);
  assert.deepEqual((await f.json('checkpoint.json')).flights.map(flight => flight.runId), [42]);
  f.runs.push(f.run(44)); f.artifact(44, 'annie-checkpoint-44-1', 'checkpoint.json', await f.json('checkpoint.json'));
  f.setClock(now + 27 * 3600000); f.setCurrent(45);
  const reconciled = await f.execute();
  assert.equal(reconciled.allowance, 15); assert.equal(reconciled.observationBlockers.length, 0); assert.equal(reconciled.paid, true);
  assert.deepEqual((await f.json('checkpoint.json')).flights.map(flight => flight.runId), [45]);
});
test('ambiguous maintain without markers holds full cap; skipped check alone never refunds foreign run', async t => {
  const f = await fixture(t); await f.execute({ ANNIE_MODE: 'observe' });
  f.runs.push(f.run(42)); f.artifact(42, 'annie-checkpoint-42-1', 'checkpoint.json', await f.json('checkpoint.json'));
  f.runs.push(f.run(41)); f.jobs.push({ id: 201, name: 'maintain', conclusion: 'cancelled' }); f.setCurrent(43);
  assert.equal((await f.execute()).allowance, 0);
  f.runs[1].path = 'foreign.yml'; f.jobs[0].conclusion = 'skipped'; assert.equal((await f.execute()).allowance, 0);
});
test('invalid JSON is bounded bot retry, never permanent PR blame; known retries remain separately charged', async t => {
  const f = await fixture(t); let result = await f.execute();
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal(result.paid, true);
    const id = 41 + attempt, cp = await f.json('checkpoint.json'), lease = await f.json('lease.json');
    f.runs.push(f.run(id)); f.artifact(id, `annie-checkpoint-${id}-1`, 'checkpoint.json', cp); f.artifact(id, `annie-lease-${id}-1`, 'lease.json', lease);
    f.artifact(id, `honest-annie-model-report-${id}-1`, 'report.json', { ledgerReservation: lease.hash, fingerprint: lease.task.fingerprint, taskKind: lease.task.kind, day: lease.task.day, base, managementApproved: false, phase: 'rejected', reason: 'invalid-review', commit: null, releaseCommit: null, usageComplete: true, reportedUsage: { status: 'known', cost: 0.1 } });
    f.setClock(now + attempt * 3600000 + 1); f.setCurrent(id + 1); result = await f.execute();
    const next = await f.json('checkpoint.json'); assert.equal(next.handled.includes(lease.task.fingerprint), false); assert.equal(next.outcomes[0].attempts, attempt);
  }
  assert.equal(result.paid, false); assert.ok(Math.abs(result.allowance - 14.7) < 1e-9);
});
test('release fallback leaves unknown completion pending; expired day14 receipt refresh abandons unpersisted candidate without handling it', async t => {
  const f = await fixture(t); await f.execute(); const lease = await f.json('lease.json');
  f.runs.push({ ...f.run(42), run_attempt: 2 });
  f.artifact(42, 'annie-checkpoint-42-1', 'checkpoint.json', await f.json('checkpoint.json'));
  f.artifact(42, 'annie-lease-42-1', 'lease.json', lease);
  f.artifact(42, 'honest-annie-model-report-42-1', 'report.json', { ledgerReservation: lease.hash, fingerprint: lease.task.fingerprint, taskKind: lease.task.kind, day: lease.task.day, base, managementApproved: false, phase: 'publishing', commit: 'e'.repeat(40), releaseCommit: 'e'.repeat(40), usageComplete: false, reportedUsage: { status: 'unknown' } });
  f.artifact(42, 'honest-annie-candidate-42-1', 'not-downloaded', {});
  f.artifact(42, 'honest-annie-release-report-42-3', 'report.json', { fingerprint: null, ledgerReservation: null, reportedUsage: { status: 'unknown' } });
  f.setCurrent(43); const first = await f.execute(); assert.equal(first.state, 'effects-pending'); assert.equal(first.allowance, 0);
  const refreshed = await f.json('checkpoint.json');
  f.setClock(now + 14 * 86400000); f.runs.push(f.run(43)); f.artifact(43, 'annie-checkpoint-43-1', 'checkpoint.json', refreshed);
  for (const meta of f.artifacts.get(42)) meta.expired = true;
  assert.deepEqual(refreshed.pendingRuns, [42]); assert.equal(refreshed.receipts.length, 1);
  f.setCurrent(44); const expired = await f.execute(); assert.deepEqual(expired.pendingEffects, []);
  assert.deepEqual(expired.abandonedEffects, [{ runId: 42, source: 'e'.repeat(40), reason: 'candidate-expired' }]); assert.equal(expired.paid, true);
  const next = await f.json('checkpoint.json'); assert.equal(next.handled.includes(lease.task.fingerprint), false); assert.equal(next.pendingRuns.includes(42), false);
});
test('missing model settlement permits only proven exported candidate effects retry; latest check-only attempt discovers prior effects failure', async t => {
  const f = await fixture(t);
  f.prs.push({ number: 7, state: 'open', draft: false, user: { login: 'trusted', type: 'User' }, head: { sha: 'f'.repeat(40), ref: 'feature' }, base: { ref: 'trunk', repo: { full_name: OWN } } });
  await f.execute(); const lease = await f.json('lease.json');
  f.runs.push({ ...f.run(42), run_attempt: 2 }); f.artifact(42, 'annie-checkpoint-42-1', 'checkpoint.json', await f.json('checkpoint.json')); f.artifact(42, 'annie-lease-42-1', 'lease.json', lease);
  f.artifact(42, 'honest-annie-candidate-42-1', 'do-not-download', {});
  f.jobsByAttempt.set(2, [{ id: 202, name: 'check', conclusion: 'success' }]);
  f.jobsByAttempt.set(1, [{ id: 200, name: 'maintain', conclusion: 'success', steps: [{ name: 'Export only approved candidates or valid rejection feedback', conclusion: 'success' }] }, { id: 201, name: 'Annie effects (model-free)', conclusion: 'failure' }]);
  f.setCurrent(43); f.setClock(now + 3600000);
  const result = await f.execute(); assert.equal(result.allowance, 0); assert.equal(result.paid, false); assert.equal(result.effectsRetry.jobAttempt, 1); assert.equal(result.effectsRetry.attempt, 2);
  const retried = await retryEffects({ env: { ...f.env, ANNIE_RETRY: JSON.stringify(result.effectsRetry) }, fetchImpl: f.fetchImpl, now: now + 3600000 });
  assert.equal(retried.jobId, 201); assert.equal(f.calls.filter(c => c.options.method === 'POST').length, 1);
  assert.equal(f.calls.some(c => c.url.includes('/actions/artifacts/3/zip')), false);
});
test('same-day slot, unknown registry, current protection and rerun guard prevent paid admission', async t => {
  for (const mode of ['collision', 'outage', 'protected', 'rerun']) {
    const f = await fixture(t);
    if (mode === 'collision') f.setRegistry(200);
    if (mode === 'outage') f.setRegistry(401);
    if (mode === 'protected') f.setProtected(true);
    else assert.equal((await f.execute(mode === 'rerun' ? { GITHUB_RUN_ATTEMPT: '2' } : {})).paid, false);
  }
});
test('registry outage holds only source work: observe completes, writes its checkpoint, and a harness request still runs', async t => {
  for (const outage of [() => new Response(null, { status: 503 }), () => { throw new TypeError('fetch failed'); }]) {
    const f = await fixture(t); f.setRegistryImpl(outage);
    const held = await f.execute();
    assert.equal(held.state, 'registry-unknown'); assert.equal(held.paid, false);
    await assert.rejects(readFile(join(f.dir, 'lease.json'))); assert.deepEqual((await f.json('checkpoint.json')).slots, []);
    assert.equal((await f.json('observer.json')).state, 'registry-unknown');
  }
  const f = await fixture(t); f.setRegistryImpl(() => { throw new TypeError('fetch failed'); });
  f.issues.push({ number: 4, title: 'latest models', body: 'pin it', state: 'open', user: { login: 'bugabinga', type: 'User' }, labels: [{ name: 'annie-harness' }] });
  const admitted = await f.execute();
  assert.equal(admitted.state, 'admitted'); assert.equal((await f.json('lease.json')).task.kind, 'harness');
});
test('lost/expired decision checkpoint fails closed even when bootstrap flag remains on', async t => {
  const f = await fixture(t);
  f.runs.push(f.run(41));
  const meta = f.artifact(41, 'annie-checkpoint-41-1', 'checkpoint.json', { schema: 1, runId: 41, repoId: 7, handled: [], slots: [] }); meta.expired = true;
  await assert.rejects(f.execute(), /checkpoint missing/);
});
test('effects retry POST targets ONLY isolated known release job; policy mismatch/legacy/max attempts defer without writes', async t => {
  const f = await fixture(t), old = { ...f.run(41), run_attempt: 1, updated_at: new Date(now - 3600000).toISOString() }; f.runs.push(old);
  f.jobs.push({ id: 99, name: 'Annie effects (model-free)', conclusion: 'failure' });
  const env = { ...f.env, ANNIE_RETRY: JSON.stringify({ runId: 41, jobId: 99, originalSha: base, attempt: 1 }) };
  assert.equal((await retryEffects({ env, fetchImpl: f.fetchImpl, now })).state, 'effects-retry-dispatched');
  assert.equal(f.calls.filter(c => c.options.method === 'POST').length, 1);
  for (const name of ['maintain', 'legacy release']) { f.jobs[0].name = name; await assert.rejects(retryEffects({ env, fetchImpl: f.fetchImpl, now })); }
  f.jobs[0].name = 'Annie effects (model-free)'; f.setProtected(true); await assert.rejects(retryEffects({ env, fetchImpl: f.fetchImpl, now }));
  assert.equal(f.calls.filter(c => c.options.method === 'POST').length, 1);
  assert.ok(f.calls.filter(c => c.options.method === 'POST').every(c => /\/actions\/jobs\/99\/rerun$/.test(c.url)));
});

test('prepaid uploader seam verifies immutable original ID/digest/payload; duplicate or wrong upload prevents models', async t => {
  const f = await fixture(t); await f.execute(); const lease = await f.json('lease.json');
  const meta = f.artifact(42, 'annie-lease-42-1', 'lease.json', lease);
  const env = { ...f.env, PUFFER_MAINT_LEASE: join(f.dir, 'lease.json'), PUFFER_MAINT_TASK: JSON.stringify(lease.task), ANNIE_LEASE_ARTIFACT_ID: String(meta.id), ANNIE_LEASE_ARTIFACT_DIGEST: meta.digest };
  assert.equal((await verifyUploadedLease({ env, fetchImpl: f.fetchImpl, now })).state, 'prepaid-lease-verified');
  await assert.rejects(verifyUploadedLease({ env: { ...env, ANNIE_LEASE_ARTIFACT_ID: '999' }, fetchImpl: f.fetchImpl, now }));
  f.artifact(42, 'annie-lease-42-1', 'lease.json', lease);
  await assert.rejects(verifyUploadedLease({ env, fetchImpl: f.fetchImpl, now }), /duplicate/);
});

test('half-hour native discovery prioritizes exact trusted ready PR B/H/U; foreign role never buys a review', async t => {
  for (const role of ['write', 'read']) {
    const f = await fixture(t); f.setRole(role);
    await writeFile(f.env.GITHUB_EVENT_PATH, JSON.stringify({ schedule: '7,37 * * * *' }));
    f.prs.push({ number: 7, state: 'open', draft: false, user: { login: 'trusted', type: 'User' }, head: { sha: 'f'.repeat(40), ref: 'feature' }, base: { ref: 'trunk', repo: { full_name: OWN } } });
    const result = await f.execute(); assert.equal(result.paid, role === 'write');
    if (result.paid) {
      const lease = await f.json('lease.json'); assert.equal(lease.task.kind, 'pr'); assert.equal(lease.task.number, 7); assert.equal(lease.task.head, 'f'.repeat(40)); assert.equal(lease.task.base, base); assert.equal(lease.task.upstreamSha, U);
    }
  }
});

const X = 'e'.repeat(40), DAYMS = 24 * 3600000;
// Prior paid run 42 with approved source X; current run 43 observes the next UTC day.
async function approved(f, { attempt = 1, candidate = true, settlement = {}, republish } = {}) {
  await f.execute(); const cp = await f.json('checkpoint.json'), lease = await f.json('lease.json');
  f.runs.push({ ...f.run(42), run_attempt: attempt }); f.artifact(42, 'annie-checkpoint-42-1', 'checkpoint.json', republish ? { ...cp, republish } : cp); f.artifact(42, 'annie-lease-42-1', 'lease.json', lease);
  f.artifact(42, 'honest-annie-model-report-42-1', 'report.json', { ledgerReservation: lease.hash, fingerprint: lease.task.fingerprint, taskKind: lease.task.kind, day: lease.task.day, base, managementApproved: false, phase: 'publishing', commit: X, releaseCommit: X, usageComplete: true, reportedUsage: { status: 'known', cost: 1 }, ...settlement });
  if (candidate) f.artifact(42, 'honest-annie-candidate-42-1', 'not-downloaded', {});
  f.setClock(now + DAYMS); f.setCurrent(43);
  return lease;
}
// Anonymous registry fake mirroring publish.sh reads: manifest -> config blob -> OCI labels.
function registry(f, images, status = null) {
  f.setRegistryImpl(async url => {
    if (status) return new Response(null, { status });
    const tag = url.match(/manifests\/(.+)$/)?.[1];
    if (tag) return images[tag] ? response({ config: { digest: `sha256:${digest(tag)}` } }) : new Response(null, { status: 404 });
    const image = Object.keys(images).find(name => url.endsWith(`/blobs/sha256:${digest(name)}`));
    return response({ config: { Labels: { 'org.opencontainers.image.revision': images[image].revision, 'org.opencontainers.image.version': images[image].version } } });
  });
}
test('failed management receipts never block released source or the queue; management-only receipts are terminal', async t => {
  for (const kind of ['source', 'management-only']) {
    const f = await fixture(t), source = kind === 'source';
    const lease = await approved(f, { settlement: { managementApproved: true, ...(source ? {} : { phase: 'managing', commit: null, releaseCommit: null }) } });
    f.artifact(42, 'honest-annie-release-report-42-1', 'report.json', { fingerprint: lease.task.fingerprint, ledgerReservation: lease.hash, base, day: lease.task.day, releaseCommit: source ? X : null, sourcePersisted: source, publicationDigest: source ? `sha256:${'f'.repeat(64)}` : null, actionReceipts: [{ kind: 'create-issue', number: null, status: 'failed', reason: 'GitHub mutation http-403' }] });
    if (source) f.setHead(X);
    const result = await f.execute();
    assert.deepEqual(result.pendingEffects, [], kind); assert.equal(result.republish, null); assert.equal(result.state, 'admitted', kind); assert.equal(result.paid, true);
    assert.equal((await f.json('checkpoint.json')).pendingRuns.includes(42), false);
  }
});
test('persisted unpublished source takes model-free republish lane: absent tag republishes, matching revision releases, newer latest supersedes, ceiling abandons, unknown holds', async t => {
  for (const scenario of ['absent', 'published', 'version-only', 'newer', 'ceiling', 'unknown', 'policy']) {
    const f = await fixture(t), out = join(f.dir, `output-${scenario}`);
    await approved(f, scenario === 'ceiling' ? { republish: [{ runId: 42, attempts: 3, nextAt: now }] } : {});
    f.setHead(X);
    // Trunk harness moved past X (e.g. this repair): persisted source is still republished by the trusted current harness.
    if (scenario === 'policy') { const later = 'c'.repeat(40); f.setHead(later); f.setChangedPolicy(X); }
    registry(f, scenario === 'published' ? { '2026.4.3': { revision: X, version: '2026.4.3' }, latest: { revision: X, version: '2026.4.3' } } : scenario === 'version-only' ? { '2026.4.3': { revision: X, version: '2026.4.3' }, latest: { revision: 'f'.repeat(40), version: '2026.4.1' } } : scenario === 'newer' ? { latest: { revision: 'f'.repeat(40), version: '2026.4.5' } } : {}, scenario === 'unknown' ? 503 : null);
    if (scenario === 'absent') {
      const observed = await f.execute({ ANNIE_MODE: 'observe' });
      assert.equal(observed.republish, null); assert.deepEqual(observed.pendingEffects, []); assert.equal(observed.republishEffects[0].runId, 42);
      const result = await f.execute({ GITHUB_OUTPUT: out });
      const plan = { runId: 42, releaseCommit: X, version: '2026.4.3', day: '2026-04-03' };
      assert.equal(result.state, 'republishing'); assert.equal(result.paid, false); assert.deepEqual(result.republish, plan);
      const outputs = await readFile(out, 'utf8'); assert.match(outputs, /^paid=false$/m); assert.match(outputs, /^task=$/m); assert.ok(outputs.includes(`republish=${JSON.stringify(plan)}\n`));
      const cp = await f.json('checkpoint.json'); assert.deepEqual(cp.republish, [{ runId: 42, attempts: 1, nextAt: now + DAYMS + 1800000 }]); assert.ok(cp.pendingRuns.includes(42)); assert.deepEqual(cp.flights, []);
      continue;
    }
    const result = await f.execute(scenario === 'unknown' ? { ANNIE_MODE: 'observe' } : {});
    if (scenario !== 'policy' && scenario !== 'version-only') assert.equal(result.republish, null, scenario);
    // Version pushed but latest never promoted: not released, resumes via the idempotent publisher path.
    if (scenario === 'version-only') { assert.equal(result.state, 'republishing'); assert.equal(result.paid, false); assert.equal(result.republish.version, '2026.4.3'); }
    assert.deepEqual(result.pendingEffects, [], scenario);
    const cp = await f.json('checkpoint.json');
    if (scenario === 'published') { assert.equal(result.paid, true); assert.equal(cp.pendingRuns.includes(42), false); }
    if (scenario === 'newer') { assert.equal(result.paid, true); assert.deepEqual(result.supersededEffects, [{ runId: 42, source: X, reason: 'newer-latest' }]); }
    if (scenario === 'ceiling') { assert.equal(result.paid, true); assert.deepEqual(result.abandonedEffects, [{ runId: 42, source: X, reason: 'republish-exhausted' }]); assert.equal(cp.pendingRuns.includes(42), false); }
    if (scenario === 'policy') { assert.equal(result.state, 'republishing'); assert.equal(result.paid, false); assert.equal(result.republish.releaseCommit, X); assert.deepEqual(result.abandonedEffects, []); assert.ok(cp.pendingRuns.includes(42)); assert.ok(f.calls.some(c => c.url.endsWith(`/compare/${X}...${'c'.repeat(40)}`))); }
    if (scenario === 'unknown') { assert.deepEqual(result.heldEffects, [{ runId: 42, source: X, reason: 'registry-unknown' }]); assert.notEqual(result.state, 'effects-pending'); assert.ok(cp.pendingRuns.includes(42)); }
  }
});
test('unpersisted candidate with exhausted effects retries or missing artifact is abandoned, admission allowed, fingerprint not handled', async t => {
  for (const scenario of ['effects-retry-exhausted', 'candidate-missing']) {
    const f = await fixture(t);
    const lease = await approved(f, scenario === 'effects-retry-exhausted' ? { attempt: 3 } : { candidate: false });
    const result = await f.execute();
    assert.deepEqual(result.pendingEffects, []); assert.deepEqual(result.abandonedEffects, [{ runId: 42, source: X, reason: scenario }]); assert.equal(result.paid, true);
    const cp = await f.json('checkpoint.json'); assert.equal(cp.handled.includes(lease.task.fingerprint), false); assert.equal(cp.pendingRuns.includes(42), false);
  }
});

test('unpersisted PR compatibility compare: behind/diverged supersede, ahead/identical stay pending, unknown status or error stays pending', async t => {
  const F = 'f'.repeat(40), C = 'c'.repeat(40), moved = '9'.repeat(40);
  for (const [sinceBase, untilHead, expected] of [['ahead', 'ahead', 'pending'], ['ahead', 'identical', 'pending'], ['behind', 'ahead', 'superseded'], ['ahead', 'behind', 'superseded'], ['ahead', 'diverged', 'superseded'], ['ahead', 'mystery', 'pending'], ['ahead', 500, 'pending']]) {
    const f = await fixture(t), label = `${sinceBase}/${untilHead}`;
    f.prs.push({ number: 7, state: 'open', draft: false, user: { login: 'trusted', type: 'User' }, head: { sha: F, ref: 'feature' }, base: { ref: 'trunk', repo: { full_name: OWN } } });
    const lease = await approved(f, { settlement: { taskKind: 'pr', commit: C, releaseCommit: F } });
    assert.equal(lease.task.kind, 'pr');
    f.setHead(moved);
    f.setCompareImpl(range => {
      const status = range === `${F}...${moved}` ? 'diverged' : range === `${base}...${moved}` ? sinceBase : range === `${moved}...${F}` ? untilHead : assert.fail('unexpected compare ' + range);
      return typeof status === 'number' ? new Response(null, { status }) : response({ status });
    });
    const result = await f.execute({ ANNIE_MODE: 'observe' });
    if (expected === 'pending') { assert.deepEqual(result.pendingEffects.map(e => e.runId), [42], label); assert.equal(result.state, 'effects-pending', label); }
    else { assert.deepEqual(result.pendingEffects, [], label); assert.deepEqual(result.supersededEffects, [{ runId: 42, source: F, reason: 'trunk-advanced' }], label); }
  }
});
test('incident replay: run 41687463110 attempt 3, persisted 79df79c9 with failed create-issue and no digest, ends in model-free republish of 2026.11.3', async t => {
  // literal: trunk head is still 79df79c9; merged: S0 landed on top with a changed harness policy.
  for (const variant of ['literal', 'merged']) {
  const f = await fixture(t), T = '79df79c950afe3e2f30681bee5002a811734b215', id = 41687463110, later = 41700000000, current = 41800000000, out = join(f.dir, 'incident-output');
  f.setClock(Date.parse('2026-11-03T04:17:00Z')); f.setCurrent(id);
  await f.execute({ ANNIE_BOOTSTRAP: String(id) }); const cp = await f.json('checkpoint.json'), lease = await f.json('lease.json');
  assert.equal(lease.task.day, '2026-11-03');
  f.runs.push({ ...f.run(id), run_attempt: 3 });
  f.artifact(id, `annie-checkpoint-${id}-1`, 'checkpoint.json', cp); f.artifact(id, `annie-lease-${id}-1`, 'lease.json', lease);
  f.artifact(id, `honest-annie-model-report-${id}-1`, 'report.json', { ledgerReservation: lease.hash, fingerprint: lease.task.fingerprint, taskKind: lease.task.kind, day: lease.task.day, base, managementApproved: true, phase: 'publishing', commit: T, releaseCommit: T, usageComplete: true, reportedUsage: { status: 'known', cost: 1 } });
  f.artifact(id, `honest-annie-candidate-${id}-1`, 'not-downloaded', {});
  for (const attempt of [1, 2, 3]) f.artifact(id, `honest-annie-release-report-${id}-${attempt}`, 'report.json', { fingerprint: lease.task.fingerprint, ledgerReservation: lease.hash, base, day: lease.task.day, releaseCommit: T, sourcePersisted: true, publicationDigest: null, actionReceipts: [{ kind: 'create-issue', number: null, status: 'failed', reason: 'unknown or insufficient permission class' }] });
  // A later deadlocked observer checkpoint carries the record beyond the 26h observation window.
  f.setClock(Date.parse('2026-11-04T07:07:00Z')); f.runs.unshift(f.run(later));
  f.artifact(later, `annie-checkpoint-${later}-1`, 'checkpoint.json', { ...cp, runId: later, paid: false, flights: [], pendingRuns: [id] });
  f.setClock(Date.parse('2026-11-09T07:37:00Z')); f.setCurrent(current); f.setHead(T);
  if (variant === 'merged') { f.setHead('5'.repeat(40)); f.setChangedPolicy(T); }
  registry(f, { latest: { revision: 'b6ef86a3098a5335b3c96eaf35d4a2f9971a1096', version: '2026.11.1' } });
  const result = await f.execute({ GITHUB_OUTPUT: out });
  const plan = { runId: id, releaseCommit: T, version: '2026.11.3', day: '2026-11-03' };
  assert.equal(result.state, 'republishing'); assert.equal(result.paid, false); assert.deepEqual(result.republish, plan);
  assert.deepEqual(result.pendingEffects, []); assert.deepEqual(result.observationBlockers, []); assert.deepEqual(result.abandonedEffects, []);
  assert.ok((await readFile(out, 'utf8')).includes(`republish=${JSON.stringify(plan)}\n`));
  const next = await f.json('checkpoint.json'); assert.deepEqual(next.republish, [{ runId: id, attempts: 1, nextAt: Date.parse('2026-11-09T08:07:00Z') }]); assert.ok(next.pendingRuns.includes(id));
  }
});
// One paid run whose model report names provider failures; the next observation folds them into provider holds.
async function heldFixture(t, failures, report = {}) {
  const f = await fixture(t); await f.execute(); const checkpoint = await f.json('checkpoint.json'), lease = await f.json('lease.json');
  f.runs.push(f.run(42)); f.artifact(42, 'annie-checkpoint-42-1', 'checkpoint.json', checkpoint); f.artifact(42, 'annie-lease-42-1', 'lease.json', lease);
  f.artifact(42, 'honest-annie-model-report-42-1', 'report.json', { ledgerReservation: lease.hash, fingerprint: lease.task.fingerprint, taskKind: lease.task.kind, day: lease.task.day, base, managementApproved: false, commit: null, releaseCommit: null, phase: 'failed', reason: 'model-or-phase-failed', modelFailure: 'environment', usageComplete: true, reportedUsage: { status: 'known', cost: 1 }, providers: ['zai', 'minimax'], providerFailures: failures, ...report });
  return f;
}
const iso = at => new Date(at).toISOString();
test('provider holds: all available providers held admits nothing until the earliest reset; a config revision clears them', async t => {
  const f = await heldFixture(t, [{ provider: 'zai', kind: 'quota', observedAt: iso(now + 600000), resetAt: iso(now + 5 * 3600000) }, { provider: 'minimax', kind: 'auth', observedAt: iso(now + 1200000) }]);
  f.setClock(now + 2 * 3600000); f.setCurrent(43);
  const held = await f.execute({ GITHUB_OUTPUT: join(f.dir, 'out-43') });
  assert.equal(held.state, 'providers-held'); assert.equal(held.paid, false); assert.equal(held.holdsExpireAt, iso(now + 5 * 3600000));
  const holds = [{ provider: 'zai', until: now + 5 * 3600000, reason: 'quota' }, { provider: 'minimax', until: now + 1200000 + 24 * 3600000, reason: 'auth' }];
  const cp = await f.json('checkpoint.json'); assert.deepEqual(cp.providerHolds, holds); assert.deepEqual(cp.providers.available, ['zai', 'minimax']);
  assert.equal(cp.environment, null, 'provider-attributed failures never start the shared cooldown');
  assert.ok((await readFile(join(f.dir, 'out-43'), 'utf8')).includes(`holds=${JSON.stringify(holds)}\n`));
  f.runs.push(f.run(43)); f.artifact(43, 'annie-checkpoint-43-1', 'checkpoint.json', cp);
  f.setClock(now + 2 * 3600000 + 60000); f.setCurrent(44);
  const rotated = await f.execute({ ANNIE_CONFIG_REVISION: 'rotated-1' });
  assert.equal(rotated.state, 'admitted'); assert.deepEqual(rotated.providerHolds, []); assert.deepEqual((await f.json('checkpoint.json')).providers.available, []);
});
test('provider holds expire, the next provider still runs, and malformed provider evidence fails closed', async t => {
  const f = await heldFixture(t, [{ provider: 'zai', kind: 'quota', observedAt: iso(now + 600000), resetAt: iso(now + 5 * 3600000) }, { provider: 'minimax', kind: 'transient', observedAt: iso(now + 1200000) }]);
  f.setClock(now + 2 * 3600000); f.setCurrent(43);
  const partial = await f.execute({ GITHUB_OUTPUT: join(f.dir, 'out-43') });
  assert.equal(partial.state, 'admitted'); assert.deepEqual(partial.providerHolds, [{ provider: 'zai', until: iso(now + 5 * 3600000), reason: 'quota' }]);
  assert.ok((await readFile(join(f.dir, 'out-43'), 'utf8')).includes(`holds=${JSON.stringify([{ provider: 'zai', until: now + 5 * 3600000, reason: 'quota' }])}\n`));
  const cp = await f.json('checkpoint.json');
  for (const [failures, error] of [[[{ provider: 'zai', kind: 'quota', observedAt: 'yesterday' }], /malformed settlement provider evidence/], [[{ provider: 'zai', kind: 'gone', observedAt: iso(now) }], /malformed settlement provider evidence/]]) {
    const bad = await heldFixture(t, failures); bad.setClock(now + 2 * 3600000); bad.setCurrent(43);
    await assert.rejects(bad.execute(), error);
  }
  const forged = await fixture(t); forged.runs.push(forged.run(41)); forged.artifact(41, 'annie-checkpoint-41-1', 'checkpoint.json', { ...cp, runId: 41, providerHolds: [{ provider: 'zai', until: 1, reason: 'quota', extra: true }] });
  await assert.rejects(forged.execute(), /malformed provider holds/);
  f.runs.push(f.run(43)); f.artifact(43, 'annie-checkpoint-43-1', 'checkpoint.json', { ...cp, paid: false, flights: [] });
  f.setClock(now + 5 * 3600000 + 60000); f.setCurrent(44);
  const expired = await f.execute(); assert.deepEqual(expired.providerHolds, []); assert.equal(expired.holdsExpireAt, null);
});

test('rejection memory: a review-rejected maintenance report reaches the checkpoint and the maintain output; malformed evidence fails closed', async t => {
  const area = { files: ['web/backup/download.go'], count: 1, digest: 'e'.repeat(64) }, findings = [{ id: 'unbounded-range', impact: 'serves bytes past the end' }];
  const f = await heldFixture(t, [], { phase: 'rejected', reason: 'review-rejected', modelFailure: null, changedFiles: area, blockingFindings: findings });
  f.setClock(now + 2 * 3600000); f.setCurrent(43);
  const observed = await f.execute({ GITHUB_OUTPUT: join(f.dir, 'out-43') });
  const memory = [{ runId: 42, day: '2026-04-03', ...area, findings }], cp = await f.json('checkpoint.json');
  assert.deepEqual(cp.rejections, memory); assert.notEqual(observed.state, 'blocked');
  assert.ok((await readFile(join(f.dir, 'out-43'), 'utf8')).includes(`rejections=${JSON.stringify(memory)}\n`));
  // The next observation carries it from the checkpoint alone; a forged checkpoint entry blocks observation.
  f.runs.push(f.run(43)); f.artifact(43, 'annie-checkpoint-43-1', 'checkpoint.json', { ...cp, paid: false, flights: [] });
  f.setClock(now + 2 * 3600000 + 60000); f.setCurrent(44); await f.execute();
  assert.deepEqual((await f.json('checkpoint.json')).rejections, memory);
  const forged = await fixture(t); forged.runs.push(forged.run(41)); forged.artifact(41, 'annie-checkpoint-41-1', 'checkpoint.json', { ...cp, runId: 41, rejections: [{ ...memory[0], files: ['../x y'] }] });
  await assert.rejects(forged.execute(), /malformed rejection memory/);
  const bad = await heldFixture(t, [], { phase: 'rejected', reason: 'review-rejected', changedFiles: { ...area, count: 0 } }); bad.setClock(now + 2 * 3600000); bad.setCurrent(43);
  await assert.rejects(bad.execute(), /malformed settlement rejection evidence/);
});

test('incidents: failed effects jobs dedupe across observes, then admit one $5 harness repair without a calendar slot, once per incident and policy', async t => {
  const f = await fixture(t), outputPath = join(f.dir, 'outputs'), outputs = async () => Object.fromEntries((await readFile(outputPath, 'utf8')).trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  await f.execute({ ANNIE_MODE: 'observe' }); const first = await f.json('checkpoint.json');
  // Two earlier runs whose model-free effects failed at the same step; their checkpoints prove no paid work was pending.
  for (const id of [40, 41]) { f.runs.push({ ...f.run(id), conclusion: 'failure' }); f.artifact(id, `annie-checkpoint-${id}-1`, 'checkpoint.json', { ...first, runId: id }); }
  f.runs.push(f.run(42)); f.artifact(42, 'annie-checkpoint-42-1', 'checkpoint.json', first);
  f.jobs.push({ id: 9, name: 'Annie effects (model-free)', conclusion: 'failure', steps: [{ name: 'Persist source before registry auth', conclusion: 'failure' }] });
  f.setCurrent(43); const seen = await f.execute({ ANNIE_MODE: 'observe' });
  assert.deepEqual(seen.incidents.map(({ kind, count, status, ready }) => ({ kind, count, status, ready })), [{ kind: 'job-failed', count: 1, status: 'open', ready: false }]);
  const second = await f.json('checkpoint.json'); assert.deepEqual(second.incidents[0].runs, [41, 40]);
  f.runs.push(f.run(43)); f.artifact(43, 'annie-checkpoint-43-1', 'checkpoint.json', second);
  f.setCurrent(44); await writeFile(outputPath, '');
  const admitted = await f.execute({ GITHUB_OUTPUT: outputPath });
  assert.equal(admitted.state, 'admitted'); assert.equal(admitted.incidents[0].count, 2); assert.equal(admitted.incidents[0].ready, true);
  const lease = await f.json('lease.json'), third = await f.json('checkpoint.json'), incident = third.incidents[0].fingerprint;
  assert.equal(lease.task.kind, 'harness'); assert.equal(lease.task.incident, incident); assert.equal(lease.cap, 5); assert.deepEqual(third.slots, []);
  assert.equal(lease.task.fingerprint, harnessFingerprint(incident, digest(JSON.stringify({ github: 'c'.repeat(40), maintainer: 'e'.repeat(40) }))));
  assert.deepEqual(admitted.harnessRepair, { incident, kind: 'job-failed', attempt: 1 });
  const written = await outputs(), digestOut = JSON.parse(written.incident);
  assert.equal(digestOut.incident, incident); assert.equal(digestOut.runs[0].jobs[0].name, 'Annie effects (model-free)'); assert.match(digestOut.runs[0].jobs[0].log, /^log unavailable/);
  assert.equal(JSON.parse(written.incidents)[0].fingerprint, incident);
  assert.doesNotMatch(JSON.stringify(third), /readonly-sentinel/);
  // The settled repair (any terminal outcome) is handled; the next daily round buys ordinary maintenance instead.
  f.runs.push(f.run(44)); f.artifact(44, 'annie-checkpoint-44-1', 'checkpoint.json', third); f.artifact(44, 'annie-lease-44-1', 'lease.json', lease);
  f.artifact(44, 'honest-annie-model-report-44-1', 'report.json', { ledgerReservation: lease.hash, fingerprint: lease.task.fingerprint, taskKind: 'harness', incident, day: lease.task.day, base, managementApproved: false, commit: null, releaseCommit: null, phase: 'rejected', reason: 'review-rejected', usageComplete: true, reportedUsage: { status: 'known', cost: 1 } });
  f.setCurrent(45); const next = await f.execute();
  assert.equal(next.state, 'admitted'); assert.equal((await f.json('lease.json')).task.kind, 'maintenance'); assert.equal(next.allowance, 14);
  assert.ok((await f.json('checkpoint.json')).handled.includes(lease.task.fingerprint));
});
test('operator request: a labelled issue from a write author admits a $5 harness repair at once with its Markdown body; others never pay', async t => {
  const request = { number: 4, title: 'latest models', body: '**Pin** an image model.\n\n- keep cost low', state: 'open', user: { login: 'bugabinga', type: 'User' }, labels: [{ name: 'annie-harness' }] };
  const f = await fixture(t), outputPath = join(f.dir, 'outputs'); f.issues.push(request); await writeFile(outputPath, '');
  const admitted = await f.execute({ GITHUB_OUTPUT: outputPath }), lease = await f.json('lease.json'), checkpoint = await f.json('checkpoint.json');
  assert.equal(admitted.state, 'admitted'); assert.equal(lease.task.kind, 'harness'); assert.equal(lease.task.incident, requestFingerprint(4)); assert.equal(lease.cap, 5);
  assert.deepEqual(admitted.harnessRepair, { incident: requestFingerprint(4), kind: 'operator-request', attempt: 1 });
  const written = Object.fromEntries((await readFile(outputPath, 'utf8')).trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  assert.deepEqual(JSON.parse(written.incident).request, { number: 4, url: `https://github.com/${OWN}/issues/4`, title: 'latest models', body: request.body, comments: [] });
  assert.equal(written.incidents, '', 'a request is already its own issue');
  // A labelled request never counts as queue input, so it cannot wake ordinary management.
  const empty = await fixture(t); await empty.execute({ ANNIE_MODE: 'observe' });
  assert.equal(checkpoint.queue, (await empty.json('checkpoint.json')).queue);
  // The attempt changes nothing: Annie answers on the issue and waits for feedback instead of buying the same guess again.
  f.runs.push(f.run(42)); f.artifact(42, 'annie-checkpoint-42-1', 'checkpoint.json', checkpoint); f.artifact(42, 'annie-lease-42-1', 'lease.json', lease);
  f.artifact(42, 'honest-annie-model-report-42-1', 'report.json', { ledgerReservation: lease.hash, fingerprint: lease.task.fingerprint, taskKind: 'harness', incident: lease.task.incident, day: lease.task.day, base, managementApproved: false, commit: null, releaseCommit: null, phase: 'published', reason: 'no-op', diagnosis: 'enabledModels already tracks provider defaults', usageComplete: true, reportedUsage: { status: 'known', cost: 1 } });
  f.setClock(now + 3600000); f.setCurrent(43); await writeFile(outputPath, '');
  const waiting = await f.execute({ GITHUB_OUTPUT: outputPath, ANNIE_MODE: 'observe' }), notices = JSON.parse(Object.fromEntries((await readFile(outputPath, 'utf8')).trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])).notices);
  assert.deepEqual(notices, [{ issue: 4, runId: 42, task: lease.task.fingerprint, phase: 'published', reason: 'no-op', diagnosis: 'enabledModels already tracks provider defaults', attempt: 1 }]);
  assert.equal(waiting.harnessRepair, null); assert.ok(waiting.harnessWaits.some(w => w.reason === 'awaiting-feedback'));
  // A later observation no longer re-emits an answered notice.
  f.runs.push(f.run(43)); f.artifact(43, 'annie-checkpoint-43-1', 'checkpoint.json', await f.json('checkpoint.json'));
  f.setClock(now + 3 * 3600000); f.setCurrent(45); await writeFile(outputPath, '');
  await f.execute({ GITHUB_OUTPUT: outputPath, ANNIE_MODE: 'observe' });
  assert.equal(Object.fromEntries((await readFile(outputPath, 'utf8')).trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])).notices, '');
  // Oliver replies; the next observation retries with his feedback in the digest.
  f.runs.push(f.run(45)); f.artifact(45, 'annie-checkpoint-45-1', 'checkpoint.json', await f.json('checkpoint.json'));
  f.comments.set(4, [{ user: { login: 'annie[bot]', type: 'Bot' }, created_at: new Date(now + 3700000).toISOString(), body: 'bot noise' }, { user: { login: 'bugabinga', type: 'User' }, author_association: 'OWNER', created_at: new Date(now + 3800000).toISOString(), body: 'Pin `zai/*glm*` first.' }]);
  f.setClock(now + 4 * 3600000); f.setCurrent(46); await writeFile(outputPath, '');
  const retried = await f.execute({ GITHUB_OUTPUT: outputPath }), again = await f.json('lease.json');
  assert.equal(again.task.kind, 'harness'); assert.equal(retried.harnessRepair.attempt, 2); assert.notEqual(again.task.fingerprint, lease.task.fingerprint);
  const retryDigest = JSON.parse(Object.fromEntries((await readFile(outputPath, 'utf8')).trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])).incident);
  assert.deepEqual(retryDigest.request.comments, [{ author: 'bugabinga', at: new Date(now + 3800000).toISOString(), body: 'Pin `zai/*glm*` first.' }]);
  const foreign = await fixture(t); foreign.setRole('read'); foreign.issues.push({ ...request, user: { login: 'stranger', type: 'User' } });
  const refused = await foreign.execute(); assert.equal((await foreign.json('lease.json')).task.kind, 'maintenance'); assert.equal(refused.harnessRepair, null);
});
// Shared path to a ready job-failed incident (two failing effects runs) whose first harness repair run 44 was just admitted.
async function admittedRepair(t, { beforeAdmission = () => {} } = {}) {
  const f = await fixture(t);
  await f.execute({ ANNIE_MODE: 'observe' }); const first = await f.json('checkpoint.json');
  for (const id of [40, 41]) { f.runs.push({ ...f.run(id), conclusion: 'failure' }); f.artifact(id, `annie-checkpoint-${id}-1`, 'checkpoint.json', { ...first, runId: id }); }
  f.runs.push(f.run(42)); f.artifact(42, 'annie-checkpoint-42-1', 'checkpoint.json', first);
  f.jobs.push({ id: 9, name: 'Annie effects (model-free)', conclusion: 'failure', steps: [{ name: 'Persist source before registry auth', conclusion: 'failure' }] });
  f.setCurrent(43); await f.execute({ ANNIE_MODE: 'observe' });
  f.runs.push(f.run(43)); f.artifact(43, 'annie-checkpoint-43-1', 'checkpoint.json', await f.json('checkpoint.json'));
  f.setCurrent(44); beforeAdmission(f); const admitted = await f.execute();
  return { f, admitted, lease: admitted.paid ? await f.json('lease.json') : null, checkpoint: await f.json('checkpoint.json') };
}
// Run 44 delivered its fix as PR #2; the PR body predates the incident marker, like the live PR #2.
function deliveredAsPR(f, lease, checkpoint) {
  const C = '9'.repeat(40);
  f.runs.push(f.run(44)); f.artifact(44, 'annie-checkpoint-44-1', 'checkpoint.json', checkpoint); f.artifact(44, 'annie-lease-44-1', 'lease.json', lease);
  const identity = { ledgerReservation: lease.hash, fingerprint: lease.task.fingerprint, taskKind: 'harness', incident: lease.task.incident, day: lease.task.day, base };
  f.artifact(44, 'honest-annie-model-report-44-1', 'report.json', { ...identity, managementApproved: false, commit: C, releaseCommit: C, phase: 'publishing', usageComplete: true, reportedUsage: { status: 'known', cost: 1 } });
  f.artifact(44, 'honest-annie-release-report-44-1', 'report.json', { ...identity, releaseCommit: C, phase: 'publishing', actionReceipts: [{ kind: 'harness-pr', number: 2, status: 'applied', reason: null }] });
  const pr = { number: 2, state: 'open', draft: false, user: { login: 'bugabinga', type: 'User' }, head: { sha: C, ref: `annie/harness/${lease.task.fingerprint.slice(0, 12)}`, repo: { full_name: OWN } }, base: { ref: 'trunk', repo: { full_name: OWN } }, body: 'legacy harness PR body without an incident marker' };
  f.prs.push(pr); return pr;
}
const changedPolicy = digest(JSON.stringify({ github: '1'.repeat(40), maintainer: 'e'.repeat(40) }));
test('live regression: an open harness PR blocks a second paid repair for its incident even after a policy change; closing it unmerged allows attempt 2', async t => {
  const { f, lease, checkpoint } = await admittedRepair(t), incident = lease.task.incident;
  assert.equal(lease.task.kind, 'harness'); assert.deepEqual(checkpoint.incidents[0].repair, { tasks: [lease.task.fingerprint], last: lease.task.fingerprint, runId: 44, at: now, policy: digest(JSON.stringify({ github: 'c'.repeat(40), maintainer: 'e'.repeat(40) })) });
  deliveredAsPR(f, lease, checkpoint);
  // An unrelated harness change lands: the trusted policy digest moves. Registry collision keeps maintenance out of the way.
  f.setChangedPolicy(base); f.setRegistry(200); f.setCurrent(45);
  const waiting = await f.execute();
  assert.equal(waiting.paid, false); assert.equal(waiting.harnessRepair, null);
  assert.deepEqual(waiting.harnessWaits, [{ incident, reason: 'awaiting-review', pr: 2 }]);
  const held = await f.json('checkpoint.json'); assert.equal(held.incidents[0].pr, 2); assert.deepEqual(held.incidents[0].repair.tasks, [lease.task.fingerprint]);
  // Oliver closes #2 unmerged while the incident persists: one more attempt, a new task and branch.
  f.runs.push(f.run(45)); f.artifact(45, 'annie-checkpoint-45-1', 'checkpoint.json', held);
  f.closedPRs.push({ ...f.prs.pop(), state: 'closed', merged_at: null });
  f.setCurrent(46); const retried = await f.execute();
  assert.equal(retried.state, 'admitted'); assert.deepEqual(retried.harnessRepair, { incident, kind: 'job-failed', attempt: 2 });
  const second = await f.json('lease.json'); assert.equal(second.task.fingerprint, harnessFingerprint(incident, changedPolicy, 2)); assert.notEqual(second.task.fingerprint.slice(0, 12), lease.task.fingerprint.slice(0, 12));
  const after = await f.json('checkpoint.json'); assert.equal(after.incidents[0].pr, undefined); assert.equal(after.incidents[0].repair.tasks.length, 2); assert.equal(after.incidents[0].repair.policy, changedPolicy);
  // An unknown PR lookup admits nothing.
  f.runs.push(f.run(46)); f.artifact(46, 'annie-checkpoint-46-1', 'checkpoint.json', { ...held, runId: 46 }); f.pullsAll.fail = true; f.setCurrent(47);
  const unknown = await f.execute(); assert.equal(unknown.harnessRepair, null); assert.deepEqual(unknown.harnessWaits, [{ incident, reason: 'harness-pr-lookup-unknown' }]);
});
test('harness repair waits while its run is in flight and fails closed on an unattributable open harness PR', async t => {
  const { f, lease, checkpoint } = await admittedRepair(t), incident = lease.task.incident;
  f.runs.push({ ...f.run(44), status: 'in_progress', conclusion: null }); f.artifact(44, 'annie-checkpoint-44-1', 'checkpoint.json', checkpoint); f.artifact(44, 'annie-lease-44-1', 'lease.json', lease);
  f.setChangedPolicy(base); f.setCurrent(45);
  const flying = await f.execute(); assert.equal(flying.harnessRepair, null); assert.deepEqual(flying.harnessWaits, [{ incident, reason: 'in-flight' }]);
  const stray = await admittedRepair(t, { beforeAdmission: g => g.prs.push({ number: 9, state: 'open', draft: false, user: { login: 'bugabinga', type: 'User' }, head: { sha: 'f'.repeat(40), ref: 'annie/harness/abcdefabcdef' }, base: { ref: 'trunk', repo: { full_name: OWN } }, body: 'no marker' }) });
  assert.equal(stray.lease?.task.kind === 'harness', false); assert.equal(stray.admitted.harnessRepair, null);
  assert.deepEqual(stray.admitted.harnessWaits.at(-1), { incident: null, reason: 'unattributed open harness PR #9' });
  // A marked PR from a fork or an unrelated branch prefix never counts.
  const fork = await admittedRepair(t, { beforeAdmission: g => g.prs.push({ number: 10, state: 'open', draft: false, user: { login: 'someone', type: 'User' }, head: { sha: 'f'.repeat(40), ref: 'annie/harness/abcdefabcdef', repo: { full_name: 'someone/pufferpanel' } }, base: { ref: 'trunk', repo: { full_name: OWN } }, body: 'fork' }) });
  assert.equal(fork.lease.task.kind, 'harness');
});
test('never self-integrate: harness repair branches and protected-path PRs are refused before any paid admission', async t => {
  const f = await fixture(t);
  f.prs.push({ number: 7, state: 'open', draft: false, user: { login: 'trusted', type: 'User' }, head: { sha: 'f'.repeat(40), ref: 'annie/harness/abcdef012345' }, base: { ref: 'trunk', repo: { full_name: OWN } } });
  let result = await f.execute(); assert.equal(result.readyPRs, 0); assert.notEqual((await f.json('lease.json')).task.kind, 'pr');
  f.prs[0] = { ...f.prs[0], head: { sha: 'f'.repeat(40), ref: 'feature' } }; f.files.push({ filename: 'tools/maintainer/controller.mjs' });
  f.setCurrent(43); f.env.ANNIE_BOOTSTRAP = '43'; result = await f.execute({ ANNIE_MODE: 'observe' }); assert.equal(result.readyPRs, 0);
  f.files[0] = { filename: 'docs/x.md', previous_filename: '.github/workflows/honest-annie.yml' }; result = await f.execute({ ANNIE_MODE: 'observe' }); assert.equal(result.readyPRs, 0);
  f.files[0] = { filename: 'docs/x.md' }; result = await f.execute({ ANNIE_MODE: 'observe' }); assert.equal(result.readyPRs, 1);
});
