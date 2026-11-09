import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { controller, digest, retryEffects, verifyUploadedLease, POLICY_PATH } from './controller.mjs';
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
  const runs = [], artifacts = new Map(), bodies = new Map(), calls = [], issues = [], jobs = [], prs = [], jobsByAttempt = new Map();
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
    if (path.endsWith('/pulls')) return response(prs);
    if (/\/pulls\/\d+$/.test(path)) return response(prs.find(pr => path.endsWith(`/${pr.number}`)));
    if (path.endsWith('/permission')) return response({ permission: role });
    if (path.endsWith('/status')) return response({ statuses: [], total_count: 0 });
    if (path.endsWith('/check-runs')) return response({ check_runs: [{ status: 'completed', conclusion: 'success' }], total_count: 1 });
    if (path.endsWith('/issues')) return response(issues);
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
  return { env, dir, runs, artifacts, calls, issues, jobs, jobsByAttempt, prs, setRole: value => { role = value; }, artifact, execute, json, fetchImpl, run, setClock: v => { clock = v; }, setCurrent: id => { currentId = id; env.GITHUB_RUN_ID = String(id); }, setRegistry: v => { registry = v; }, setProtected: v => { protectedBranch = v; }, setHead: v => { head = v; }, setRegistryImpl: v => { registryImpl = v; }, setChangedPolicy: v => { changedPolicy = v; }, setCompareImpl: v => { compareImpl = v; } };
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
  for (const number of [7, 8]) f.prs.push({ number, state: 'open', draft: false, user: { login: 'trusted', type: 'User' }, head: { sha: String(number).repeat(40) }, base: { ref: 'trunk', repo: { full_name: OWN } } });
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
  f.prs.push({ number: 7, state: 'open', draft: false, user: { login: 'trusted', type: 'User' }, head: { sha: 'f'.repeat(40) }, base: { ref: 'trunk', repo: { full_name: OWN } } });
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
    if (mode === 'outage') await assert.rejects(f.execute(), /availability unknown/);
    else assert.equal((await f.execute(mode === 'rerun' ? { GITHUB_RUN_ATTEMPT: '2' } : {})).paid, false);
  }
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
    f.prs.push({ number: 7, state: 'open', draft: false, user: { login: 'trusted', type: 'User' }, head: { sha: 'f'.repeat(40) }, base: { ref: 'trunk', repo: { full_name: OWN } } });
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
    f.prs.push({ number: 7, state: 'open', draft: false, user: { login: 'trusted', type: 'User' }, head: { sha: F }, base: { ref: 'trunk', repo: { full_name: OWN } } });
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
