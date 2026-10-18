import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createHostHooks, installReviewer, advance, snapshot, reconcileCommit } from './maintain.mjs';
import { validateTask, selectedTask, bindTask } from './task.mjs';
import { materializePR, verifyPRHistory, checkPR, git } from './pr.mjs';
import { pushSource, metadata, verifyCandidate } from './ci-source.mjs';
import { reportFor, collect } from './report.mjs';
import { approvedPlan } from './management.mjs';
const moduleDir = new URL('.', import.meta.url).pathname;
const response = (body, status = 200, link = '') => ({ ok: status === 200, status, headers: new Headers({ link }), json: async () => body });
const apiData = task => ({
  [`/pulls/${task.number}`]: { number: task.number, state: 'open', draft: false, user: { login: task.author }, head: { sha: task.head }, base: { ref: 'trunk', repo: { full_name: task.repo } } },
  [`/collaborators/${task.author}/permission`]: { permission: 'write' },
  [`/commits/${task.head}/status?per_page=100`]: { statuses: [], total_count: 0 },
  [`/commits/${task.head}/check-runs?per_page=100&filter=latest`]: { total_count: 1, check_runs: [{ status: 'completed', conclusion: 'success' }] },
  '/branches/trunk': { protected: false }, '/rules/branches/trunk?per_page=100': [],
});
const fakeFetch = (task, changes = {}) => {
  const data = { ...apiData(task), ...changes };
  return async url => { const path = url.split('/repos/bugabinga/pufferpanel')[1]; if (!(path in data)) throw Error('unexpected offline request ' + path); return data[path]?.http ? response({}, data[path].http) : response(data[path]); };
};
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'annie-integration-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'source'), origin = join(dir, 'origin.git'), upstream = join(dir, 'upstream.git');
  await mkdir(source);
  const g = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g('init', '-q', '-b', 'trunk'); g('config', 'user.name', 'test'); g('config', 'user.email', 'test@example.invalid');
  await writeFile(join(source, 'value.txt'), 'before\n'); await writeFile(join(source, 'Dockerfile'), 'FROM invalid');
  g('add', '.'); g('commit', '-qm', 'base'); const base = g('rev-parse', 'HEAD');
  execFileSync('git', ['init', '-q', '--bare', origin]); execFileSync('git', ['clone', '-q', '--bare', source, upstream]);
  g('remote', 'add', 'origin', origin); g('remote', 'add', 'upstream', upstream); g('push', '-q', 'origin', 'trunk');
  await writeFile(join(source, 'value.txt'), 'PR full change\n'); g('add', '.'); g('commit', '-qm', 'PR head'); const head = g('rev-parse', 'HEAD'), tree = g('rev-parse', 'HEAD^{tree}');
  g('push', '-q', 'origin', `${head}:refs/pull/7/head`); g('reset', '--hard', base);
  const task = validateTask({ kind: 'pr', day: '2026-04-03', repo: 'bugabinga/pufferpanel', ref: 'refs/heads/trunk', base, head, number: 7, author: 'trusted', upstreamSha: base, upstreamRef: 'refs/heads/trunk', fingerprint: 'f'.repeat(64) });
  const state = join(dir, 'model-state'), worktree = join(state, 'worktree');
  g('worktree', 'add', '-q', '-b', 'pi-maintenance', worktree);
  return { dir, source, origin, upstream, state, worktree, task, g, base, head, tree };
}
async function candidate(f) {
  await materializePR(f.worktree, f.task, { fetchImpl: fakeFetch(f.task) });
  const current = await snapshot(f.worktree);
  const run = { day: f.task.day, version: '2026.4.3', phase: 'publishing', taskKind: 'pr', base: f.base, head: f.base, tree: f.tree, expectedParents: [f.base], prNumber: 7, prHead: f.head, prAuthor: 'trusted', upstreamSha: f.base, upstreamRef: f.task.upstreamRef, trustedUpstreamPin: f.base, fingerprint: f.task.fingerprint, sourceChanged: true, diffHash: (await import('node:crypto')).createHash('sha256').update(current.diff).digest('hex') };
  run.commit = await reconcileCommit(f.worktree, run); run.releaseCommit = f.head;
  return run;
}

test('selected task strictly pins repo/ref/day/IDs and excludes body/snapshot fields', () => {
  const valid = { kind: 'maintenance', day: '2026-04-03', repo: 'bugabinga/pufferpanel', ref: 'refs/heads/trunk', base: 'a'.repeat(40), upstreamSha: 'b'.repeat(40), upstreamRef: 'refs/heads/trunk', fingerprint: 'c'.repeat(64) };
  assert.equal(selectedTask({ PUFFER_MAINT_TASK: JSON.stringify(valid) }).base, valid.base);
  for (const changes of [{ repo: 'other/repo' }, { ref: 'trunk' }, { base: 'a'.repeat(39) }, { day: '2026-02-30' }, { fingerprint: 'x' }, { upstreamRef: 'refs/heads/a..b' }, { snapshot: '/tmp/data' }, { number: 1 }]) assert.throws(() => validateTask({ ...valid, ...changes }));
  assert.equal(selectedTask({}), null);
});

test('actual faux PR route executes ZERO coding turns, reviewer reads complete B→T once, gates synthetic C with source H', async t => {
  const f = await fixture(t); const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(fauxToolCall('diff', {}), { stopReason: 'toolUse' }), fauxAssistantMessage('{"approve":true,"findings":[]}')]);
  const models = createModels(); models.setProvider(faux.provider); const registry = createRegistry();
  const reviewerExtension = installReviewer(registry, f.worktree);
  const harness = await Harness.open(await openNodeSqliteStorage(join(f.state, 'test.sqlite')), { models, registry, settings: { retry: { enabled: false } }, env: ({ cwd }) => new NodeExecutionEnv({ cwd }) }, ctx);
  t.after(() => harness.close(ctx)); const root = await harness.root(ctx);
  const choices = { executor: { provider: 'nonexistent', modelId: 'forbidden' }, reviewer: { provider: 'faux', modelId: 'faux-1' } };
  const hooks = createHostHooks({ root, harness, state: f.state, worktree: f.worktree, models: choices, reviewerExtension, task: f.task, upstreamUrl: f.upstream, snapshotHttp: fakeFetch(f.task), intakeProvider: async () => ({ upstream: {} }) });
  let gates = 0, reviews = 0; const originalReview = hooks.review;
  hooks.review = async run => { reviews++; assert.match((await snapshot(f.worktree)).diff, /PR full change/); return originalReview(run); };
  hooks.gate = async run => { gates++; assert.equal(run.tree, f.tree); assert.equal(await git(f.worktree, 'rev-parse', 'HEAD'), f.base); };
  hooks.publish = () => assert.fail('CI only');
  const run = await advance(root, { harness, ...hooks, deferPublish: true });
  assert.equal(run.phase, 'publishing'); assert.equal(gates, 1); assert.equal(reviews, 1); assert.equal(run.modelPhaseCost.executing.cost, 0);
  assert.notEqual(run.commit, f.head); assert.equal(run.releaseCommit, f.head);
  assert.equal(await git(f.worktree, 'show', '-s', '--format=%P', run.commit), f.base);
  assert.equal(await git(f.worktree, 'rev-parse', `${run.commit}^{tree}`), f.tree);
  const after = await advance(root, { harness, ...hooks, deferPublish: true }); assert.equal(after.commit, run.commit); assert.equal(reviews, 1);
});

test('PR target, author role, lifecycle, checks, pagination, rules unknown matrices fail before materialization', async t => {
  const f = await fixture(t), data = apiData(f.task), p = `/pulls/7`, c = `/commits/${f.head}/check-runs?per_page=100&filter=latest`, s = `/commits/${f.head}/status?per_page=100`;
  for (const changes of [
    { [p]: { ...data[p], head: { sha: f.base } } }, { [p]: { ...data[p], draft: true } }, { [p]: { ...data[p], state: 'closed' } }, { [p]: { ...data[p], user: { login: 'other' } } }, { [p]: { ...data[p], base: { ref: 'other', repo: { full_name: f.task.repo } } } },
    { '/collaborators/trusted/permission': { permission: 'read' } }, { '/collaborators/trusted/permission': { http: 403 } },
    { [s]: { statuses: [{ state: 'pending' }], total_count: 1 } }, { [s]: { statuses: [{ state: 'failure' }], total_count: 1 } },
    { [c]: { check_runs: [], total_count: 0 } }, { [c]: { check_runs: [], total_count: 1 } },
    ...['cancelled', 'timed_out', 'failure', null].map(conclusion => ({ [c]: { total_count: 1, check_runs: [{ status: 'completed', conclusion }] } })),
    { '/branches/trunk': {} }, { '/branches/trunk': { protected: true } }, { '/rules/branches/trunk?per_page=100': [{ type: 'pull_request' }] }, { '/rules/branches/trunk?per_page=100': { http: 404 } },
  ]) {
    await assert.rejects(materializePR(f.worktree, f.task, { fetchImpl: fakeFetch(f.task, changes) }));
    assert.equal(await git(f.worktree, 'status', '--porcelain'), '');
  }
  await assert.rejects(checkPR(f.task, { fetchImpl: async () => response(data[p], 200, '<next>; rel="next"') }), /truncated/);
  for (const conclusion of ['success', 'neutral', 'skipped']) await checkPR(f.task, { fetchImpl: fakeFetch(f.task, { [c]: { total_count: 1, check_runs: [{ status: 'completed', conclusion }] } }) });
});

test('PR introduced protected changes even reverted and unsupported merges rejected before model', async t => {
  const f = await fixture(t);
  f.g('checkout', '--detach', f.head); await mkdir(join(f.source, '.github')); await writeFile(join(f.source, '.github/x'), 'bad'); f.g('add', '.'); f.g('commit', '-qm', 'introduce'); f.g('rm', '-q', '.github/x'); f.g('commit', '-qm', 'revert');
  await assert.rejects(verifyPRHistory(f.source, { ...f.task, head: f.g('rev-parse', 'HEAD') }), /introduced/);
  f.g('checkout', '--detach', f.base); await writeFile(join(f.source, 'other'), 'side'); f.g('add', '.'); f.g('commit', '-qm', 'side'); const side = f.g('rev-parse', 'HEAD'); f.g('checkout', '--detach', f.head); f.g('merge', '--no-ff', '-m', 'merge', side);
  await assert.rejects(verifyPRHistory(f.source, { ...f.task, head: f.g('rev-parse', 'HEAD') }), /merge history/);
  await assert.rejects(verifyPRHistory(f.source, f.task, f.base), /exact tree/);
});

async function cliFixture(f, run) {
  const artifact = join(f.dir, 'artifact'), result = join(f.dir, 'result.json'), output = join(f.dir, 'output'), bin = join(f.dir, 'bin'); await mkdir(bin);
  const runDir = join(f.state, 'runs', run.day); await mkdir(runDir, { recursive: true }); await writeFile(join(runDir, 'gate.ok'), f.tree);
  await writeFile(result, JSON.stringify(reportFor(run)));
  const preload = join(f.dir, 'fetch.mjs'); await writeFile(preload, `
import {execFileSync} from 'node:child_process';
const data=${JSON.stringify({ ...apiData(f.task), '': { full_name: 'bugabinga/pufferpanel', has_issues: true, permissions: { push: true } }, '/issues?state=all&per_page=100': [] })};
globalThis.fetch=async(url,init={})=>{
  const p=url.split('/repos/bugabinga/pufferpanel')[1];
  const result=value=>({ok:true,status:200,headers:new Headers(),json:async()=>value});
  if(process.env.GITHUB_ACTIONS==='true' && init.headers?.Authorization!=='Bearer native-offline-token') return {ok:false,status:401};
  if(p==='/branches/trunk')return result({protected:process.env.FAKE_PROTECTED==='true',commit:{sha:execFileSync('git',['-C',process.env.PUFFER_MAINT_SOURCE,'ls-remote','origin','refs/heads/trunk'],{encoding:'utf8'}).split(/\\s/)[0]}});
  if(p?.startsWith('/git/trees/'))return result({tree:p.endsWith('${'d'.repeat(40)}')?[{path:'maintainer',sha:'${'e'.repeat(40)}'}]:[{path:'.github',sha:process.env.FAKE_POLICY_CHANGED==='true'&&!p.endsWith('${f.base}')?'${'f'.repeat(40)}':'${'c'.repeat(40)}'},{path:'tools',sha:'${'d'.repeat(40)}'}]});
  if(init.method==='POST'&&p==='/issues')return {ok:true,status:201};
  if(!(p in data))throw Error('offline only');return result(data[p]);
};`);
  const fake = `#!/usr/bin/env node
import fs from 'node:fs';import crypto from 'node:crypto';
const p=process.env.FAKE_STATE,s=JSON.parse(fs.readFileSync(p)),a=process.argv.slice(2),name=process.argv[1].split('/').pop();s.commands.push(name+' '+a.join(' '));
if(name==='curl'){const out=a[a.indexOf('-o')+1],u=a.at(-1);let body='',code=200;if(u.includes('/manifests/')){body=s.remote[u.split('/').pop()]??'';code=body?200:404;}else body=JSON.stringify({config:{Labels:{'org.opencontainers.image.revision':s.sha,'org.opencontainers.image.version':s.version}}});fs.writeFileSync(out,body);if(a.includes('-w'))process.stdout.write(String(code));else if(code!==200)process.exitCode=22;
}else{if(a.includes('inspect'))process.stdout.write(s.config);if(a.includes('run')&&a.includes('version'))process.stdout.write('PufferPanel '+s.version+' ('+s.sha+')\\n');if(a.includes('push')){const body=JSON.stringify({schemaVersion:2,config:{digest:'sha256:'+s.config}});s.remote[a.at(-1).split(':').pop()]=body;fs.writeFileSync(a[a.indexOf('--digestfile')+1],'sha256:'+crypto.createHash('sha256').update(body).digest('hex'));}}
fs.writeFileSync(p,JSON.stringify(s));
`;
  for (const name of ['podman', 'curl']) { await writeFile(join(bin, name), fake); await chmod(join(bin, name), 0o700); }
  const fakeState = join(f.dir, 'fake.json'); await writeFile(fakeState, JSON.stringify({ commands: [], remote: {}, sha: f.head, version: run.version, config: 'a'.repeat(64) }));
  const env = { ...process.env, GITHUB_ACTIONS: 'false', NODE_OPTIONS: `--import=${preload}`, PATH: `${bin}:${process.env.PATH}`, FAKE_STATE: fakeState, PUFFER_MAINT_TASK: JSON.stringify(f.task), PUFFER_MAINT_SOURCE: f.source, PUFFER_MAINT_STATE: f.state, PUFFER_MAINT_RESULT: result, GITHUB_SHA: f.base, HONEST_ANNIE_ARTIFACT: artifact, GITHUB_OUTPUT: output };
  const cli = (action, extra = {}) => spawnSync('bash', [join(moduleDir, 'ci.sh'), action], { env: { ...env, ...extra }, encoding: 'utf8' });
  return { cli, env, artifact, output, fakeState };
}

test('hosted CLI attempt1/2 uses native auth for source/effects policy; source proof precedes auth, changed policy blocks retry', async t => {
  const f = await fixture(t), run = await candidate(f), fixtureCLI = await cliFixture(f, run);
  const hosted = { GITHUB_ACTIONS: 'true', GITHUB_RUN_ATTEMPT: '1', HONEST_ANNIE_ENABLED: 'true', GH_TOKEN: 'native-offline-token' };
  const ok = (command, extra = {}) => { const result = fixtureCLI.cli(command, { ...hosted, ...extra }); assert.equal(result.status, 0, result.stderr); };
  ok('export'); hosted.PUFFER_MAINT_STATE = join(f.dir, 'hosted-release'); ok('import'); ok('gate');
  const registry = { REGISTRY_USERNAME: 'fixture', REGISTRY_PASSWORD: 'offline-password', REGISTRY_AUTH_FILE: join(f.dir, 'auth.json') };
  assert.notEqual(fixtureCLI.cli('registry-login', { ...hosted, ...registry }).status, 0);
  assert.equal(JSON.parse(await readFile(fixtureCLI.fakeState)).commands.some(c => c.includes(' login ')), false);
  assert.notEqual(fixtureCLI.cli('push', { ...hosted, GH_TOKEN: '' }).status, 0);
  ok('push');
  assert.notEqual(fixtureCLI.cli('registry-login', { ...hosted, ...registry, GH_TOKEN: '' }).status, 0);
  ok('registry-login', registry); ok('publish');
  ok('push', { GITHUB_RUN_ATTEMPT: '2' }); ok('publish', { GITHUB_RUN_ATTEMPT: '2' });
  assert.notEqual(fixtureCLI.cli('publish', { ...hosted, GITHUB_RUN_ATTEMPT: '2', FAKE_POLICY_CHANGED: 'true' }).status, 0);
  assert.notEqual(fixtureCLI.cli('publish', { ...hosted, HONEST_ANNIE_ENABLED: 'false' }).status, 0);
  assert.notEqual(fixtureCLI.cli('publish', { ...hosted, FAKE_PROTECTED: 'true' }).status, 0);
});

test('local Git PR export→fresh base import→fixed gates→native push H→publisher OCI H, trace C, already-H retry model-free', async t => {
  const f = await fixture(t), run = await candidate(f);
  run.managementApproved = true; run.review = { approve: true };
  const cli = await cliFixture(f, run);
  await writeFile(join(f.state, 'runs', run.day, 'management.json'), JSON.stringify(approvedPlan(run, [{ actions: [{ kind: 'create-issue', title: 'Reviewed follow-up', body: 'Only approved follow-up.' }] }])));
  const ok = (cmd, extra) => { const r = cli.cli(cmd, extra); assert.equal(r.status, 0, r.stderr); };
  ok('export');
  const fresh = join(f.dir, 'fresh'); execFileSync('git', ['clone', '-q', '-b', 'trunk', f.origin, fresh]);
  const release = { PUFFER_MAINT_SOURCE: fresh, PUFFER_MAINT_STATE: join(f.dir, 'release') };
  ok('import', release);
  const registryAuth = { ...release, REGISTRY_USERNAME: 'test', REGISTRY_PASSWORD: 'private-registry-sentinel', REGISTRY_AUTH_FILE: join(f.dir, 'auth.json') };
  assert.notEqual(cli.cli('registry-login', registryAuth).status, 0);
  ok('gate', release);
  assert.notEqual(cli.cli('registry-login', registryAuth).status, 0);
  assert.equal(JSON.parse(await readFile(cli.fakeState)).commands.some(c => c.includes(' login ')), false);
  assert.notEqual(cli.cli('publish', release).status, 0);
  assert.notEqual(cli.cli('management', { ...release, GH_TOKEN: 'native-only' }).status, 0);
  assert.equal(JSON.parse(await readFile(cli.fakeState)).commands.some(c => /push|build/.test(c) && c.includes('pufferpanel:')), false);
  ok('push', release); assert.equal(execFileSync('git', ['--git-dir', f.origin, 'rev-parse', 'trunk'], { encoding: 'utf8' }).trim(), f.head);
  ok('management', { ...release, GH_TOKEN: 'native-only' });
  const actions = JSON.parse(await readFile(join(release.PUFFER_MAINT_STATE, 'runs', run.day, 'action-receipts.json'))); assert.equal(actions[0].status, 'applied');
  ok('registry-login', registryAuth);
  ok('publish', release);
  const fake = JSON.parse(await readFile(cli.fakeState)); assert.match(fake.commands.join('\n'), new RegExp(`org.opencontainers.image.revision=${f.head}`)); assert.doesNotMatch(fake.commands.join('\n'), new RegExp(`org.opencontainers.image.revision=${run.commit}`));
  const reportPath = join(cli.artifact, 'result.json'), publishedPath = join(release.PUFFER_MAINT_STATE, 'runs', run.day, 'publish.ok');
  const report = await collect({ reportPath, publishedPath, reportDir: join(f.dir, 'reports') }); assert.equal(report.commit, run.commit); assert.equal(report.releaseCommit, f.head); assert.equal(report.outcome, 'released');
  // Simulate fresh retry checkout already at actual H; PR may now be closed.
  execFileSync('git', ['-C', fresh, 'fetch', '-q', 'origin', 'trunk']); execFileSync('git', ['-C', fresh, 'checkout', '--detach', f.head]);
  const closedPreload = join(f.dir, 'closed.mjs'); await writeFile(closedPreload, `globalThis.fetch=async()=>{throw Error('closed PR must not be read on reconciliation');};`);
  const retry = { ...release, PUFFER_MAINT_STATE: join(f.dir, 'retry'), NODE_OPTIONS: `--import=${closedPreload}` };
  ok('import', retry); ok('gate', retry); ok('push', retry); ok('publish', retry);
});

test('upstream two-parent bundle accepted only with FULL ordered [B,pinned U], wrong/extra parents and trusted U tampering rejected', async t => {
  const f = await fixture(t); f.g('checkout', '--detach', f.base); await writeFile(join(f.source, 'upstream'), 'upstream'); f.g('add', '.'); f.g('commit', '-qm', 'upstream'); const u = f.g('rev-parse', 'HEAD');
  await git(f.worktree, 'merge', '--no-ff', '--no-commit', u); await git(f.worktree, 'commit', '-m', 'maintenance: 2026-04-03');
  const task = validateTask({ ...Object.fromEntries(Object.entries(f.task).filter(([key]) => !['head', 'number', 'author'].includes(key))), kind: 'maintenance', upstreamSha: u }); f.task = task;
  const run = { day: task.day, phase: 'publishing', version: '2026.4.3', taskKind: 'maintenance', fingerprint: task.fingerprint, base: f.base, tree: await git(f.worktree, 'rev-parse', 'HEAD^{tree}'), commit: await git(f.worktree, 'rev-parse', 'HEAD'), upstreamSha: u, upstreamRef: task.upstreamRef, trustedUpstreamPin: u, expectedParents: [f.base, u] }; run.releaseCommit = run.commit;
  const cli = await cliFixture(f, run); await writeFile(join(f.state, 'runs', run.day, 'gate.ok'), run.tree);
  let r = cli.cli('export'); assert.equal(r.status, 0, r.stderr);
  f.g('checkout', '--detach', f.base);
  r = cli.cli('import', { PUFFER_MAINT_STATE: join(f.dir, 'imported') }); assert.equal(r.status, 0, r.stderr);
  for (const changes of [{ expectedParents: [f.base, f.head] }, { expectedParents: [f.base, u, f.head] }, { expectedParents: [u, f.base] }, { trustedUpstreamPin: f.head }]) {
    const tampered = reportFor({ ...run, ...changes }); await writeFile(join(cli.artifact, 'result.json'), JSON.stringify(tampered));
    await assert.rejects(metadata(cli.artifact, task, f.base));
  }
});

test('pre-push advertised OID guard rejects deletion, rewind, unrelated advance races', async t => {
  for (const race of ['deleted', 'rewound', 'unrelated']) {
    const f = await fixture(t), run = await candidate(f);
    // A pre-base commit exists for rewind attack.
    const emptyTree = f.g('mktree'); const earlier = f.g('commit-tree', emptyTree, '-m', 'earlier');
    const unrelated = f.g('commit-tree', f.tree, '-p', f.base, '-m', 'independent');
    f.g('push', '-q', 'origin', `${earlier}:refs/fixtures/earlier`, `${unrelated}:refs/fixtures/unrelated`);
    await assert.rejects(pushSource(f.source, run, f.task, { fetchImpl: fakeFetch(f.task), beforePush: async () => {
      if (race === 'deleted') execFileSync('git', ['--git-dir', f.origin, 'update-ref', '-d', 'refs/heads/trunk']);
      else execFileSync('git', ['--git-dir', f.origin, 'update-ref', 'refs/heads/trunk', race === 'rewound' ? earlier : unrelated]);
    } }), /advertised trunk changed|failed to push/);
  }
});

test('safe intervening PR ancestor A is allowed; net-tree tamper rejected on import', async t => {
  const f = await fixture(t); f.g('checkout', '--detach', f.head); await writeFile(join(f.source, 'next'), 'next'); f.g('add', '.'); f.g('commit', '-qm', 'second PR commit');
  const a = f.head; f.head = f.g('rev-parse', 'HEAD'); f.tree = f.g('rev-parse', 'HEAD^{tree}'); f.task = validateTask({ ...f.task, head: f.head }); f.g('push', '-q', 'origin', `${f.head}:refs/pull/7/head`); f.g('reset', '--hard', f.base);
  const run = await candidate(f); execFileSync('git', ['--git-dir', f.origin, 'update-ref', 'refs/heads/trunk', a]);
  await pushSource(f.source, run, f.task, { fetchImpl: fakeFetch(f.task) });
  const cli = await cliFixture(f, run); assert.equal(cli.cli('export').status, 0);
  const bad = JSON.parse(await readFile(join(cli.artifact, 'result.json'))); bad.tree = f.base; bad.sourceIdentity.tree = f.base; await writeFile(join(cli.artifact, 'result.json'), JSON.stringify(bad));
  assert.notEqual(cli.cli('import', { PUFFER_MAINT_STATE: join(f.dir, 'bad') }).status, 0);
});

test('new integration rechecks PR lifecycle/head/role/checks/rules immediately before push; no source on failure', async t => {
  const f = await fixture(t), run = await candidate(f), data = apiData(f.task);
  for (const changes of [
    { '/pulls/7': { ...data['/pulls/7'], state: 'closed' } },
    { '/pulls/7': { ...data['/pulls/7'], head: { sha: f.base } } },
    { '/collaborators/trusted/permission': { permission: 'read' } },
    { [`/commits/${f.head}/status?per_page=100`]: { total_count: 1, statuses: [{ state: 'pending' }] } },
    { '/branches/trunk': { protected: true } },
  ]) {
    await assert.rejects(pushSource(f.source, run, f.task, { fetchImpl: fakeFetch(f.task, changes) }));
    assert.equal(execFileSync('git', ['--git-dir', f.origin, 'rev-parse', 'trunk'], { encoding: 'utf8' }).trim(), f.base);
  }
});

test('advertisement guard rejects rewind from observed A to B even though B is a valid PR ancestor', async t => {
  const f = await fixture(t); f.g('checkout', '--detach', f.head); await writeFile(join(f.source, 'next'), 'next'); f.g('add', '.'); f.g('commit', '-qm', 'next');
  const a = f.head; f.head = f.g('rev-parse', 'HEAD'); f.tree = f.g('rev-parse', 'HEAD^{tree}'); f.task = validateTask({ ...f.task, head: f.head }); f.g('push', '-q', 'origin', `${f.head}:refs/pull/7/head`); f.g('reset', '--hard', f.base);
  const run = await candidate(f); execFileSync('git', ['--git-dir', f.origin, 'update-ref', 'refs/heads/trunk', a]);
  await assert.rejects(pushSource(f.source, run, f.task, { fetchImpl: fakeFetch(f.task), beforePush: async () => execFileSync('git', ['--git-dir', f.origin, 'update-ref', 'refs/heads/trunk', f.base]) }), /advertised trunk changed/);
});

test('ordinary maintenance source push allows only B|C and rejects intervening unrelated source', async t => {
  const f = await fixture(t), run = await candidate(f); run.taskKind = 'maintenance'; run.releaseCommit = run.commit;
  const other = f.g('commit-tree', f.tree, '-p', f.base, '-m', 'independent'); f.g('push', '-q', 'origin', `${other}:refs/heads/trunk`);
  await assert.rejects(pushSource(f.source, run, null), /trunk advanced/);
  execFileSync('git', ['--git-dir', f.origin, 'update-ref', 'refs/heads/trunk', f.base]);
  await pushSource(f.source, run, null); await pushSource(f.source, run, null);
  assert.equal(execFileSync('git', ['--git-dir', f.origin, 'rev-parse', 'trunk'], { encoding: 'utf8' }).trim(), run.commit);
});

test('candidate validates actual full ordered parents and exact H tree, not metadata claims alone', async t => {
  const f = await fixture(t), run = await candidate(f);
  await verifyCandidate(f.worktree, run, f.task);
  await assert.rejects(verifyCandidate(f.worktree, { ...run, expectedParents: [f.base, f.head] }, f.task), /identity mismatch/);
  await assert.rejects(verifyCandidate(f.worktree, { ...run, tree: f.base }, f.task), /identity mismatch/);
  assert.throws(() => bindTask({ ...run, fingerprint: '0'.repeat(64) }, f.task), /trusted task/);
});

test('selected ordinary maintenance rechecks native current branch/rules before source push without bypass', async t => {
  const f = await fixture(t), run = await candidate(f);
  const task = validateTask({ ...Object.fromEntries(Object.entries(f.task).filter(([key]) => !['number', 'head', 'author'].includes(key))), kind: 'maintenance' });
  run.taskKind = 'maintenance'; run.releaseCommit = run.commit;
  await assert.rejects(pushSource(f.source, run, task, { fetchImpl: fakeFetch(f.task, { '/branches/trunk': { protected: true } }) }), /policy blocked/);
  assert.equal(execFileSync('git', ['--git-dir', f.origin, 'rev-parse', 'trunk'], { encoding: 'utf8' }).trim(), f.base);
  await assert.rejects(pushSource(f.source, run, task, { fetchImpl: fakeFetch(f.task, { '/rules/branches/trunk?per_page=100': [{ type: 'pull_request' }] }) }), /policy blocked/);
  await pushSource(f.source, run, task, { fetchImpl: fakeFetch(f.task) });
  assert.equal(execFileSync('git', ['--git-dir', f.origin, 'rev-parse', 'trunk'], { encoding: 'utf8' }).trim(), run.commit);
});
