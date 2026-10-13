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
test('no-op is idempotent today and starts a fresh run tomorrow', async t => {
  const { harness, root } = await open(join(await scratch(t), 'run.sqlite'));
  const h = hooks({ execute: async () => ({ base: 'c1', head: 'c1', tree: 't1', diff: '', changed: false, cost: 0 }) });
  await advance(root, { ...h, day: '2026-04-03' }); await advance(root, { ...h, day: '2026-04-03' });
  assert.equal(h.state.admitted, 1); assert.equal(h.state.gate + h.state.publish, 0);
  await advance(root, { ...h, day: '2026-04-04' }); assert.equal(h.state.admitted, 2);
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
test('real faux coding/reviewer turns, host commit, and SQLite daily idempotency', async t => {
  const dir = await scratch(t); const source = join(dir, 'source'); await mkdir(source);
  const git = repo(source); git('init', '-q', '-b', 'main'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.test');
  await writeFile(join(source, 'value.txt'), 'before'); git('add', '.'); git('commit', '-qm', 'initial'); git('remote', 'add', 'upstream', source);
  const state = join(dir, 'state'); await mkdir(state); const worktree = await ensureWorktree(source, state);
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('write', { path: 'value.txt', content: 'after' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Fixed value.'),
    fauxAssistantMessage(fauxToolCall('diff', {}), { stopReason: 'toolUse' }),
    fauxAssistantMessage('{"approve":true,"findings":[]}'),
  ]);
  const registry = createRegistry(); registry.install(CodingTools); const reviewerExtension = installReviewer(registry, worktree);
  const policy = {};
  const harness = await Harness.open(await openNodeSqliteStorage(join(state, 'run.sqlite')), { models: budgetModels(models, policy), registry, settings: { extensions: [CodingTools] }, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? worktree }) }, ctx);
  const root = await harness.root(ctx); Object.assign(policy, { root, harness });
  const choices = { executor: { provider: 'faux', modelId: 'faux-1' }, reviewer: { provider: 'faux', modelId: 'faux-1' } };
  const host = createHostHooks({ root, harness, worktree, state, models: choices, reviewerExtension, instructions: 'Test coding fixture.' });
  let gated = 0, published = 0;
  host.gate = async () => { gated++; }; host.publish = async () => { published++; };
  const run = await advance(root, { harness, ...host, day: '2026-04-03' });
  assert.equal(run.phase, 'published'); assert.equal(gated, 1); assert.equal(published, 1); assert.ok(run.reviewer);
  assert.equal(await readFile(join(worktree, 'value.txt'), 'utf8'), 'after'); assert.equal(await readFile(join(source, 'value.txt'), 'utf8'), 'before');
  assert.equal(await reconcileCommit(worktree, { ...run, head: run.base }), run.commit);
  await advance(root, { harness, ...host, day: '2026-04-03' }); assert.equal(published, 1);
  await harness.close(ctx);
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
