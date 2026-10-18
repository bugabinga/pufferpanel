import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { approvedPlan, validatePlan, executePlan, planHash } from './management.mjs';
import { reportFor } from './report.mjs';
const time = '2026-04-03T00:00:00Z';
const run = () => ({ day: '2026-04-03', taskKind: 'management', base: 'a'.repeat(40), tree: 'b'.repeat(40), review: { approve: true }, phase: 'managing', version: '2026.4.3', fingerprint: 'c'.repeat(64), upstreamSha: 'd'.repeat(40), upstreamRef: 'refs/heads/trunk' });
const comment = { kind: 'comment', number: 7, expectedUpdatedAt: time, body: 'Useful finding.' };
const issue = { kind: 'create-issue', title: 'Follow-up', body: 'Specific follow-up.' };
const label = { kind: 'add-label', number: 7, expectedUpdatedAt: time, labels: ['triage'] };
function api() {
  const state = { calls: [], comments: [], issues: [], labels: [], target: { number: 7, state: 'open', updated_at: time }, hasIssues: true, nativePermissions: { push: true }, adminPermissions: { admin: true }, truncated: false };
  const fetchImpl = async (url, init = {}) => {
    const path = url.split('/repos/bugabinga/pufferpanel')[1], method = init.method ?? 'GET';
    const auth = init.headers.Authorization; state.calls.push({ path, method, auth, body: init.body ? JSON.parse(init.body) : null });
    let value;
    if (method !== 'GET') {
      const body = JSON.parse(init.body);
      if (path === '/issues/7/comments') { state.comments.push(body); state.target.updated_at = '2026-04-03T01:00:00Z'; }
      else if (path === '/issues/7/labels') { state.labels.push(...body.labels.map(name => ({ name }))); state.target.updated_at = '2026-04-03T01:00:00Z'; }
      else if (path === '/issues') state.issues.push(body);
      else if (path === '' && method === 'PATCH') { assert.deepEqual(body, { has_issues: true }); state.hasIssues = true; }
      else assert.fail('unexpected mutation ' + path);
      value = {};
    } else if (path === '') value = { full_name: 'bugabinga/pufferpanel', has_issues: state.hasIssues, permissions: auth === 'Bearer admin' ? state.adminPermissions : state.nativePermissions };
    else if (path === '/issues/7') value = { ...state.target };
    else if (path === '/issues/7/labels?per_page=100') value = state.labels;
    else if (path === '/issues/7/comments?per_page=100') value = state.comments;
    else if (path === '/issues?state=all&per_page=100') value = state.issues;
    else assert.fail('unexpected read ' + path);
    return { ok: true, status: 200, headers: new Headers(state.truncated && path.includes('per_page') ? { link: '<next>; rel="next"' } : {}), json: async () => value };
  };
  return { state, options: { fetchImpl, token: 'native', adminToken: 'admin' } };
}

test('management export requires explicit approval; hashes/source/repo/whole-plan allowlist validated before auth', async () => {
  const r = run(); assert.throws(() => approvedPlan({ ...r, review: { approve: false } }, [{ actions: [issue] }]), /approval/);
  const p = approvedPlan(r, [{ actions: [issue] }]);
  for (const bad of [{ ...p, repo: 'other/repo' }, { ...p, approved: false }, { ...p, base: 'e'.repeat(40) }, { ...p, actions: [{ kind: 'delete-repository' }] }, { ...p, rawTranscript: 'not exportable' }]) await assert.rejects(executePlan(bad, r, { fetchImpl: () => assert.fail('invalid plan cannot authenticate') }));
  assert.throws(() => validatePlan(p, { ...r, managementPlanHash: '0'.repeat(64) }), /reviewed checkpoint/);
  const { hash, ...payload } = p;
  assert.throws(() => validatePlan({ ...payload, repo: 'other/repo', hash: planHash({ ...payload, repo: 'other/repo' }) }, r));
  assert.throws(() => approvedPlan({ ...r, taskKind: 'maintenance' }, [{ actions: [{ kind: 'enable-issues' }] }]), /selected management/);
  assert.throws(() => approvedPlan(r, [{ actions: Array(11).fill(issue) }]));
});

test('host labels/comments/issues are idempotent across retries even after own updatedAt change; friendly static automated footer', async () => {
  for (const action of [comment, issue, label]) {
    const r = run(), p = approvedPlan(r, [{ actions: [action] }]), f = api();
    const first = await executePlan(p, r, f.options); assert.equal(first[0].status, 'applied');
    const second = await executePlan(p, r, f.options); assert.equal(second[0].status, 'skipped'); assert.equal(second[0].reason, 'already-applied');
    assert.equal(f.state.calls.filter(c => c.method !== 'GET').length, 1);
    assert.ok(f.state.calls.every(c => c.auth === 'Bearer native'));
    if (action !== label) assert.match(f.state.calls.find(c => c.method === 'POST').body.body, /Annie, automated maintainer.*\n<!-- annie:/s);
    assert.equal(JSON.stringify(second).includes('Useful finding'), false);
  }
});

test('host exact target open/currentUpdatedAt, wrong identity and bounded lookup coverage fail closed without mutation', async () => {
  for (const scenario of ['closed', 'stale', 'wrong-number', 'truncated', 'race']) {
    const r = run(), p = approvedPlan(r, [{ actions: [comment] }]), f = api();
    if (scenario === 'closed') f.state.target.state = 'closed';
    if (scenario === 'stale') f.state.target.updated_at = '2026-04-04T00:00:00Z';
    if (scenario === 'wrong-number') f.state.target.number = 8;
    if (scenario === 'truncated') f.state.truncated = true;
    const original = f.options.fetchImpl;
    if (scenario === 'race') f.options.fetchImpl = async (url, init) => { const res = await original(url, init); if (url.includes('/comments?')) f.state.target.updated_at = '2026-04-04T00:00:00Z'; return res; };
    const result = await executePlan(p, r, f.options); assert.notEqual(result[0].status, 'applied', scenario); assert.equal(f.state.calls.some(c => c.method !== 'GET'), false);
  }
});

test('native-vs-admin matrix: ordinary ops only native; enable-issues only explicit reviewed management using admin; missing/unknown permissions clear and token-free', async () => {
  const r = run(), p = approvedPlan(r, [{ actions: [{ kind: 'enable-issues' }] }]);
  let f = api(); f.state.hasIssues = false;
  let result = await executePlan(p, r, f.options); assert.equal(result[0].status, 'applied'); assert.equal(f.state.calls.find(c => c.method === 'PATCH').auth, 'Bearer admin');
  assert.equal((await executePlan(p, r, f.options))[0].reason, 'already-enabled');
  for (const adminToken of [null, 'admin']) {
    f = api(); f.state.adminPermissions = {};
    result = await executePlan(p, r, { ...f.options, adminToken }); assert.equal(result[0].status, 'failed'); assert.match(result[0].reason, /missing admin auth|permission class/); assert.equal(f.state.calls.some(c => c.method === 'PATCH'), false);
  }
  f = api(); result = await executePlan(approvedPlan(r, [{ actions: [comment] }]), r, { ...f.options, token: null }); assert.equal(result[0].reason, 'missing native auth');
  f = api(); f.state.nativePermissions = {}; result = await executePlan(approvedPlan(r, [{ actions: [comment] }]), r, f.options); assert.match(result[0].reason, /permission class/);
  f = api(); f.state.hasIssues = false; result = await executePlan(approvedPlan(r, [{ actions: [comment] }]), r, f.options); assert.equal(result[0].reason, 'issues-disabled-or-unknown');
});

test('known ZAI/native/admin keys redacted BEFORE export; host re-sanitizes, no bodies/creds in public report', () => {
  const prior = process.env.ZAI_API_KEY; process.env.ZAI_API_KEY = 'private-zai-key-sentinel';
  try {
    const r = run(), p = approvedPlan(r, [{ actions: [{ ...issue, title: process.env.ZAI_API_KEY, body: process.env.ZAI_API_KEY }] }]);
    assert.equal(JSON.stringify(p).includes(process.env.ZAI_API_KEY), false); assert.match(JSON.stringify(p), /redacted/);
    const raw = { ...p, actions: p.actions.map(a => ({ ...a, body: process.env.ZAI_API_KEY })) }; const { hash, ...payload } = raw; raw.hash = planHash(payload);
    assert.throws(() => validatePlan(raw, r), /sanitized/);
    assert.equal(JSON.stringify(reportFor({ ...r, proposedActions: [issue], plans: [p] })).includes(issue.body), false);
  } finally { if (prior === undefined) delete process.env.ZAI_API_KEY; else process.env.ZAI_API_KEY = prior; }
});

test('management-only CI export executes reviewed artifact without source bundle/gate/commit/publication', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'annie-management-ci-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'source'), origin = join(dir, 'origin.git');
  const git = (...args) => { const res = spawnSync('git', args, { encoding: 'utf8' }); assert.equal(res.status, 0, res.stderr); return res.stdout.trim(); };
  git('init', '--bare', '--initial-branch=trunk', origin); git('clone', origin, source);
  git('-C', source, 'config', 'user.name', 'fixture'); git('-C', source, 'config', 'user.email', 'fixture@example.invalid'); git('-C', source, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(source, 'app.txt'), 'unchanged source'); git('-C', source, 'add', '.'); git('-C', source, 'commit', '-m', 'fixture'); git('-C', source, 'push', 'origin', 'trunk');
  const base = git('-C', source, 'rev-parse', 'HEAD'), tree = git('-C', source, 'rev-parse', 'HEAD^{tree}');
  const r = { ...run(), base, head: base, tree, expectedParents: [base], managementApproved: true }, result = join(dir, 'result.json'), state = join(dir, 'state'), artifact = join(dir, 'artifact'), output = join(dir, 'output');
  await mkdir(join(state, 'runs', r.day), { recursive: true }); await writeFile(join(state, 'runs', r.day, 'management.json'), JSON.stringify(approvedPlan(r, [{ actions: [issue] }]))); await writeFile(result, JSON.stringify(reportFor(r)));
  const task = { kind: 'management', day: r.day, repo: 'bugabinga/pufferpanel', ref: 'refs/heads/trunk', base: r.base, upstreamSha: r.upstreamSha, upstreamRef: r.upstreamRef, fingerprint: r.fingerprint };
  const preload = join(dir, 'fetch.mjs'), calls = join(dir, 'calls.json');
  await writeFile(preload, `import fs from 'node:fs';globalThis.fetch=async(url,init={})=>{const calls=fs.existsSync(${JSON.stringify(calls)})?JSON.parse(fs.readFileSync(${JSON.stringify(calls)})):[];calls.push({url,method:init.method??'GET'});fs.writeFileSync(${JSON.stringify(calls)},JSON.stringify(calls));return{ok:true,status:200,headers:new Headers(),json:async()=>url.endsWith('/pufferpanel')?{full_name:'bugabinga/pufferpanel',has_issues:true,permissions:{push:true}}:[]};};`);
  const env = { ...process.env, GITHUB_ACTIONS: 'false', NODE_OPTIONS: `--import=${preload}`, PUFFER_MAINT_TASK: JSON.stringify(task), PUFFER_MAINT_RESULT: result, PUFFER_MAINT_SOURCE: source, PUFFER_MAINT_STATE: state, HONEST_ANNIE_ARTIFACT: artifact, GITHUB_SHA: r.base, GITHUB_OUTPUT: output, GH_TOKEN: 'native' };
  for (const command of ['export', 'management']) { const res = spawnSync('node', [new URL('./ci-source.mjs', import.meta.url).pathname, command], { env, encoding: 'utf8' }); assert.equal(res.status, 0, res.stderr); }
  assert.match(await readFile(output, 'utf8'), /candidate=false\nsourcecandidate=false\nmanagement=true/);
  await assert.rejects(readFile(join(artifact, 'candidate.bundle')));
  const receipts = JSON.parse(await readFile(join(state, 'runs', r.day, 'action-receipts.json'))); assert.equal(receipts[0].status, 'applied');
  assert.equal(git('-C', source, 'rev-parse', 'HEAD'), base); assert.equal(git('-C', source, 'status', '--porcelain'), '');
  await writeFile(join(source, 'app.txt'), 'independent advance'); git('-C', source, 'commit', '-am', 'independent'); git('-C', source, 'push', 'origin', 'trunk');
  const stale = spawnSync('node', [new URL('./ci-source.mjs', import.meta.url).pathname, 'management'], { env, encoding: 'utf8' });
  assert.notEqual(stale.status, 0); assert.match(stale.stderr, /source context is stale/);
  await writeFile(join(artifact, 'raw-snapshot.json'), 'must never upload');
  const unsafe = spawnSync('node', [new URL('./ci-source.mjs', import.meta.url).pathname, 'export'], { env, encoding: 'utf8' });
  assert.notEqual(unsafe.status, 0); assert.match(unsafe.stderr, /unchecked file/);
});

test('PR labels/comments work with issues disabled, exact H checked; stable post marker survives new B', async () => {
  const r = { ...run(), taskKind: 'pr', prNumber: 7, prHead: 'e'.repeat(40) }, f = api();
  f.state.hasIssues = false; f.state.target.pull_request = {};
  const original = f.options.fetchImpl;
  let head = r.prHead;
  f.options.fetchImpl = async (url, init) => url.endsWith('/pulls/7') ? { ok: true, status: 200, headers: new Headers(), json: async () => ({ head: { sha: head } }) } : original(url, init);
  const plan = approvedPlan(r, [{ actions: [comment] }]);
  assert.equal((await executePlan(plan, r, f.options))[0].status, 'applied');
  const next = { ...r, base: 'f'.repeat(40) };
  const again = approvedPlan(next, [{ actions: [comment] }]);
  assert.equal((await executePlan(again, next, f.options))[0].reason, 'already-applied');
  assert.equal(f.state.calls.filter(call => call.method === 'POST').length, 1);
  head = '0'.repeat(40);
  assert.match((await executePlan(again, next, f.options))[0].reason, /head changed/);
});
