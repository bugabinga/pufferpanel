import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { advance, RunDoc, selectModels, stateDirectory, versionFor, getRun, createHostHooks, installReviewer, ensureWorktree, reconcileCommit, snapshot, budgetModels } from './maintain.mjs';
import { installGitHubTools, installGitHubPlanReader, GitHubPlansDoc } from './github.mjs';

const ctx = BACKGROUND_CONTEXT;
async function scratch(t) { const dir = await mkdtemp(join(tmpdir(), 'maintainer-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
async function open(database, models = {}) {
  const harness = await Harness.open(await openNodeSqliteStorage(database), { models, registry: createRegistry() }, ctx);
  const root = await harness.root(ctx); root._maintainerHarness = harness; return { harness, root };
}
function hooks(overrides = {}) {
  const state = { admitted: 0, gate: 0, publish: 0, commit: 'c2', inspection: { head: 'c1', tree: 't1', diff: 'x', protected: false } };
  return { state, admit: async () => { state.admitted++; }, execute: async () => ({ base: 'c0', head: 'c1', tree: 't1', diff: 'x', changed: true, cost: 1 }), inspect: async () => state.inspection, review: async () => ({ answer: '{"approve":true,"findings":[]}', cost: 1 }), gate: async () => { state.gate++; }, commit: async () => { state.inspection.head = state.commit; return state.commit; }, publish: async () => { state.publish++; }, ...overrides };
}

test('actual SQLite resumes old run without duplicate admission', async t => {
  const db = join(await scratch(t), 'run.sqlite'); let first = await open(db);
  const h = hooks({ gate: async () => { throw Error('interrupted after review'); } });
  await assert.rejects(advance(first.root, { ...h, day: '2026-04-03' }), /interrupted/);
  await first.harness.close(ctx);
  const second = await open(db); const resumed = hooks();
  const run = await advance(second.root, { ...resumed, day: '2026-04-04' });
  assert.equal(run.day, '2026-04-03'); assert.equal(run.phase, 'published'); assert.equal(resumed.state.admitted, 0);
  await second.harness.close(ctx);
});
test('deterministic PR source refusal is classified before admission; stale/network errors are not cached', async t => {
  for (const [message, rejection] of [['unsupported PR merge history', 'unsupported-history'], ['PR introduced trusted harness or CI changes', 'protected-history'], ['PR base not ancestor of head', 'non-descendant'], ['GitHub read unavailable', null], ['fetched PR head changed', null]]) {
    const { harness, root } = await open(join(await scratch(t), 'run.sqlite'));
    const h = hooks({ prepare: async () => { throw Error(message); }, execute: () => assert.fail('source refused before any model') });
    await assert.rejects(advance(root, { ...h, day: '2026-04-03' }));
    assert.equal((await getRun(root, harness)).sourceRejection, rejection); assert.equal(h.state.admitted, 0);
    await harness.close(ctx);
  }
});
test('no-op is idempotent today and starts a fresh run tomorrow', async t => {
  const { harness, root } = await open(join(await scratch(t), 'run.sqlite'));
  const h = hooks({ execute: async () => ({ base: 'c1', head: 'c1', tree: 't1', diff: '', changed: false, cost: 0 }) });
  await advance(root, { ...h, day: '2026-04-03' }); await advance(root, { ...h, day: '2026-04-03' });
  assert.equal(h.state.admitted, 1); assert.equal(h.state.gate + h.state.publish, 0);
  await advance(root, { ...h, day: '2026-04-04' }); assert.equal(h.state.admitted, 2);
  await harness.close(ctx);
});
test('approved management-only run defers gates, commit, and publication', async t => {
  const { harness, root } = await open(join(await scratch(t), 'run.sqlite'));
  const h = hooks({ execute: async () => ({ base: 'c1', head: 'c1', tree: 't1', diff: '', changed: false, management: true, cost: 0 }), inspect: async () => ({ head: 'c1', tree: 't1', diff: '', protected: false }) });
  const run = await advance(root, { ...h, day: '2026-04-03' });
  assert.equal(run.phase, 'managing'); assert.equal(h.state.gate + h.state.publish, 0);
  await harness.close(ctx);
});
test('malformed, rejecting, and contradictory reviews never reach gate', async t => {
  for (const answer of ['approve', '{"approve":false,"findings":[]}', '{"approve":true,"findings":["bug"]}']) {
    const { harness, root } = await open(join(await scratch(t), 'run.sqlite'));
    const h = hooks({ review: async () => ({ answer, cost: 0 }) });
    assert.equal((await advance(root, { ...h, day: '2026-04-03' })).phase, 'rejected');
    assert.equal(h.state.gate + h.state.publish, 0); await harness.close(ctx);
  }
});
test('review checkpoint distinguishes invalid output from findings and retains findings without gates', async t => {
  for (const [answer, reason, findings] of [['not json', 'invalid-review', []], ['{"approve":false,"findings":["unsafe change"]}', 'review-rejected', ['unsafe change']], ['{"approve":true,"findings":["unsafe change"]}', 'contradictory-review', ['unsafe change']]]) {
    const { harness, root } = await open(join(await scratch(t), 'run.sqlite')); const h = hooks({ review: async () => ({ answer, cost: 1 }) });
    const run = await advance(root, { ...h, day: '2026-04-03' });
    assert.equal(run.phase, 'rejected'); assert.equal(run.review.reason, reason); assert.deepEqual(run.review.findings, findings); assert.equal(run.modelPhaseCost.reviewing.cost, 1); assert.equal(h.state.gate, 0);
    await harness.close(ctx);
  }
});
test('resumed model work invalidates old settlement before dispatch and phase transition', async t => {
  const { harness, root } = await open(join(await scratch(t), 'run.sqlite'));
  const reportedUsage = async run => { run.usageComplete = true; return 2; };
  const first = hooks({ inspect: async () => { throw Error('temporary inspection unavailable'); }, reportedUsage });
  await assert.rejects(advance(root, { ...first, day: '2026-04-03' }), /temporary inspection/);
  const stale = await getRun(root, harness);
  assert.equal(stale.phase, 'reviewing'); assert.equal(stale.usageComplete, true); assert.equal(stale.reportedUsage, 2);
  const checkpoints = [];
  root._maintainerOnCheckpoint = async run => checkpoints.push(structuredClone(run));
  const resumed = hooks({ reportedUsage, review: async () => {
    const beforeDispatch = await getRun(root, harness);
    assert.equal(beforeDispatch.usageComplete, false); assert.equal(beforeDispatch.reportedUsage, null);
    return { answer: '{"approve":true,"findings":[]}', cost: 0 };
  } });
  const done = await advance(root, { ...resumed, day: '2026-04-03' });
  assert.equal(done.phase, 'published'); assert.equal(done.usageComplete, true); assert.equal(done.reportedUsage, 2);
  assert.ok(checkpoints.some(run => run.phase === 'gating'));
  for (const run of checkpoints.filter(run => ['reviewing', 'gating'].includes(run.phase))) {
    assert.equal(run.usageComplete, false); assert.equal(run.reportedUsage, null);
  }
  await harness.close(ctx);
});
test('failed model phase accounts durable reported usage instead of claiming zero', async t => {
  const { harness, root } = await open(join(await scratch(t), 'run.sqlite'));
  const h = hooks({ execute: async () => { throw Error('model request failed'); }, reportedUsage: async () => 2 });
  await assert.rejects(advance(root, { ...h, day: '2026-04-03' }), /model request failed/);
  const run = await getRun(root, harness); assert.equal(run.phase, 'failed'); assert.equal(run.spent, 2); assert.deepEqual(run.modelPhaseCost.executing, { cost: 2, status: 'known' });
  await harness.close(ctx);
});
test('protected edits, unknown cost, budget and deadline block effects', async t => {
  for (const override of [
    { inspect: async () => ({ head: 'c1', diff: 'x', protected: true }) },
    { execute: async () => ({ base: 'c0', head: 'c1', tree: 't1', diff: 'x', changed: true, cost: 16 }) },
    { execute: async () => ({ base: 'c0', head: 'c1', tree: 't1', diff: 'x', changed: true }) },
    { now: (() => { let n = 0; return () => n++ === 0 ? 0 : 8_000_000; })() },
  ]) {
    const { harness, root } = await open(join(await scratch(t), 'run.sqlite')); const h = hooks();
    await assert.rejects(advance(root, { ...h, ...override, day: '2026-04-03', now: override.now ?? (() => 0) }));
    assert.equal(h.state.gate + h.state.publish, 0); await harness.close(ctx);
  }
});
test('CI defers publication after reviewed commit and resumes without additional model work', async t => {
  const db = join(await scratch(t), 'run.sqlite'); const first = await open(db);
  const h = hooks();
  const run = await advance(first.root, { ...h, day: '2026-04-03', deferPublish: true });
  assert.equal(run.phase, 'publishing'); assert.equal(run.commit, 'c2');
  assert.equal(h.state.gate, 1); assert.equal(h.state.publish, 0);
  await first.harness.close(ctx);
  const next = await open(db); const resumed = hooks(); resumed.state.inspection.head = 'c2';
  const done = await advance(next.root, { ...resumed, day: '2026-04-04' });
  assert.equal(done.phase, 'published'); assert.equal(done.version, '2026.4.3');
  assert.equal(resumed.state.admitted + resumed.state.gate, 0); assert.equal(resumed.state.publish, 1);
  await next.harness.close(ctx);
});
test('pending publication retries original commit/version after restart', async t => {
  const db = join(await scratch(t), 'run.sqlite'); let first = await open(db);
  const h = hooks({ publish: async () => { throw Error('after version push'); } });
  await assert.rejects(advance(first.root, { ...h, day: '2026-04-03' }), /version push/);
  assert.equal((await getRun(first.root, first.harness)).phase, 'publishing'); await first.harness.close(ctx);
  const next = await open(db); const resumed = hooks(); resumed.state.inspection.head = 'c2';
  const run = await advance(next.root, { ...resumed, day: '2026-04-04', now: () => Date.now() + 9_000_000 });
  assert.equal(run.version, '2026.4.3'); assert.equal(run.commit, 'c2'); assert.equal(resumed.state.gate, 0); assert.equal(resumed.state.publish, 1);
  await next.harness.close(ctx);
});

function repo(path) {
  mkdir(path, { recursive: true });
  const command = (...args) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8' }).trim();
  return command;
}
test('real faux coding/reviewer turns, bounded format correction, host commit, and SQLite idempotency', async t => {
  const approval = '{"approve":true,"findings":[]}';
  for (const scenario of [
    { name: 'valid final verdict after tool rounds', answers: [approval], approved: true },
    { name: 'one format correction preserves strict JSON gate', answers: ['```json\n' + approval + '\n```', approval], approved: true },
    { name: 'second malformed verdict stays rejected', answers: ['not JSON', 'still not JSON'], approved: false, reason: 'invalid-review' },
    { name: 'truncated valid-looking JSON needs complete final verdict', answers: [approval, approval], firstStop: 'length', approved: true },
    { name: 'genuine findings never trigger format correction', answers: ['{"approve":false,"findings":["unsafe change"]}'], approved: false, reason: 'review-rejected' },
    { name: 'truncated rejection never triggers format correction', answers: ['{"approve":false,"findings":["unsafe change"]}'], firstStop: 'length', approved: false, reason: 'review-rejected' },
    { name: 'contradictory findings never trigger format correction', answers: ['{"approve":true,"findings":["unsafe change"]}'], approved: false, reason: 'contradictory-review' },
    { name: 'truncated contradiction never triggers format correction', answers: ['{"approve":true,"findings":["unsafe change"]}'], firstStop: 'length', approved: false, reason: 'contradictory-review' },
  ]) await t.test(scenario.name, async t => {
  const dir = await scratch(t); const source = join(dir, 'source'); await mkdir(source);
  const git = repo(source); git('init', '-q', '-b', 'main'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.test');
  await writeFile(join(source, 'value.txt'), 'before'); git('add', '.'); git('commit', '-qm', 'initial'); git('remote', 'add', 'upstream', source);
  const state = join(dir, 'state'); await mkdir(state); const worktree = await ensureWorktree(source, state);
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  const savedSecrets = Object.fromEntries(['GH_TOKEN', 'ANNIE_GH_TOKEN', 'ZAI_API_KEY', 'REGISTRY_PASSWORD', 'GITHUB_ACTIONS'].map(key => [key, process.env[key]]));
  delete process.env.GITHUB_ACTIONS; // Local faux runtime, including when this test runs on Actions.
  Object.assign(process.env, { GH_TOKEN: 'gh-sentinel', ANNIE_GH_TOKEN: 'annie-sentinel', ZAI_API_KEY: 'zai-sentinel', REGISTRY_PASSWORD: 'registry-sentinel' });
  t.after(() => { for (const [key, value] of Object.entries(savedSecrets)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('bash', { command: 'test -z "$GH_TOKEN$ANNIE_GH_TOKEN$ZAI_API_KEY$REGISTRY_PASSWORD" && test -n "$PATH$HOME$TMPDIR" && test -n "$PUFFER_MAINT_INTAKE"' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('write', { path: 'value.txt', content: 'after' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('propose_github', { actions: [{ kind: 'create-issue', title: 'Track fixture', body: 'Known body' }] }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Fixed value.'),
    fauxAssistantMessage(fauxToolCall('read_github_plans', {}), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('diff', {}), { stopReason: 'toolUse' }),
    ...scenario.answers.map((answer, index) => fauxAssistantMessage(answer, index === 0 && scenario.firstStop ? { stopReason: scenario.firstStop } : {})),
  ]);
  const registry = createRegistry(); registry.install(CodingTools); const reviewerExtension = installReviewer(registry, worktree);
  const policy = {};
  const harness = await Harness.open(await openNodeSqliteStorage(join(state, 'run.sqlite')), { models: budgetModels(new Proxy(models, { get(target, key) {
    if (key === 'streamSimple') return (model, transcript, options) => { options.onProviderStreamEvent({ usage: { prompt_tokens: 0, completion_tokens: 0 } }, model); return target.streamSimple(model, transcript, options); };
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
  } }), policy), registry, settings: { extensions: [CodingTools] }, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? worktree }) }, ctx);
  const root = await harness.root(ctx); Object.assign(policy, { root, harness });
  const executorExtension = installGitHubTools(registry, { root, worktree, runDoc: RunDoc }); const githubPlanReader = installGitHubPlanReader(registry, root);
  const choices = { executor: { provider: 'faux', modelId: 'faux-1' }, reviewer: { provider: 'faux', modelId: 'faux-1' } };
  const fixtureFetch = async url => ({ ok: true, status: 200, headers: new Headers(), json: async () => url.includes('/git/ref/') ? { object: { sha: git('rev-parse', 'HEAD') } } : url.includes('/repos/') && !url.includes('/issues') && !url.includes('/pulls') ? { default_branch: 'main' } : [] });
  const host = createHostHooks({ root, harness, worktree, state, models: choices, reviewerExtension, executorExtension, githubPlanReader, policy, instructions: 'Test coding fixture.', snapshotHttp: fixtureFetch, upstreamUrl: source });
  let gated = 0, published = 0;
  host.gate = async () => { gated++; }; host.publish = async () => { published++; };
  const run = await advance(root, { harness, ...host, day: '2026-04-03' });
  assert.equal(run.phase, scenario.approved ? 'published' : 'rejected'); assert.equal(gated, Number(scenario.approved)); assert.equal(published, Number(scenario.approved)); assert.ok(run.reviewer);
  assert.equal(run.usageComplete, true); assert.equal(run.modelCalls, 6 + scenario.answers.length);
  assert.equal(run.reviewDiagnostics.length, scenario.answers.length);
  if (!scenario.approved) { assert.equal(run.review.reason, scenario.reason); assert.equal(run.commit, undefined); }
  if (scenario.reason === 'review-rejected') assert.deepEqual(run.review.findings, ['unsafe change']);
  assert.equal(await readFile(join(worktree, 'value.txt'), 'utf8'), 'after'); assert.equal(await readFile(join(source, 'value.txt'), 'utf8'), 'before');
  assert.equal((await harness.snapshot(GitHubPlansDoc, root.id, ctx)).plans.length, 1);
  if (scenario.approved) assert.equal(await reconcileCommit(worktree, { ...run, head: run.base }), run.commit);
  await advance(root, { harness, ...host, day: '2026-04-03' }); assert.equal(published, Number(scenario.approved));
  await harness.close(ctx);
  });
});
test('provider budget guard rejects before real model dispatch', async t => {
  const { harness, root } = await open(join(await scratch(t), 'run.sqlite'));
  await root.commit(async tx => { (await tx.doc(RunDoc, root.id)).run = { startedAt: Date.now() - 9_000_000, usageStart: 0 }; }, ctx);
  let called = false;
  const runtime = { streamSimple() { called = true; throw Error('must not dispatch'); } };
  const model = { api: 'test', provider: 'test', id: 'test', contextWindow: 1000, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } };
  const result = await budgetModels(runtime, { root, harness }).streamSimple(model, {}).result();
  assert.equal(called, false); assert.equal(result.stopReason, 'error'); assert.match(result.errorMessage, /deadline/);
  await harness.close(ctx);
});
test('configuration uses exact configured medium model and calendar version', () => {
  const runtime = { getModel: (provider, id) => provider === 'p' && id === 'm' ? {} : undefined };
  assert.equal(selectModels({ defaultProvider: 'p', ultra: { providerModelTiers: { p: { medium: { model: 'p/m' } } } } }, runtime).executor.modelId, 'm');
  assert.throws(() => selectModels({ defaultProvider: 'p', ultra: { providerModelTiers: {} } }, runtime));
  assert.equal(versionFor('2026-04-03'), '2026.4.3'); assert.equal(stateDirectory({ HOME: '/x' }), '/x/.pi/agent/maintenance/pufferpanel');
});
