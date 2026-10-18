import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { advance, RunDoc, createHostHooks, ModelCodingTools, installReviewer, snapshot } from './maintain.mjs';
import { installGitHubTools, installGitHubPlanReader, GitHubPlansDoc } from './github.mjs';

const ctx = BACKGROUND_CONTEXT;
const secretNames = ['GH_TOKEN', 'ANNIE_GH_TOKEN', 'REGISTRY_PASSWORD', 'ZAI_API_KEY'];
async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'github-plans-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function fixture(t, responses) {
  const dir = await scratch(t);
  const state = join(dir, 'state');
  const worktree = join(dir, 'worktree');
  const git = (...args) => execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8' }).trim();
  await import('node:fs/promises').then(({ mkdir, writeFile }) => mkdir(worktree, { recursive: true }).then(() => writeFile(join(worktree, 'value.txt'), 'fixture')));
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.test'); git('add', '.'); git('commit', '-qm', 'fixture');
  const base = git('rev-parse', 'HEAD');
  const faux = fauxProvider();
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(ModelCodingTools);
  const reviewerExtension = installReviewer(registry, worktree);
  const harness = await Harness.open(await openNodeSqliteStorage(join(state, 'run.sqlite')), {
    models,
    registry,
    settings: { extensions: [ModelCodingTools], retry: { enabled: false, maxRetries: 0, baseDelayMs: 1000 } },
    env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? worktree, shellEnv: { PATH: process.env.PATH, HOME: dir, TMPDIR: tmpdir(), PUFFER_MAINT_INTAKE: join(dir, 'intake.json') } }),
  }, ctx);
  t.after(() => harness.close(ctx));
  const root = await harness.root(ctx);
  const executorExtension = installGitHubTools(registry, { root, worktree, runDoc: RunDoc });
  const githubPlanReader = installGitHubPlanReader(registry, root);
  const choices = { executor: { provider: 'faux', modelId: 'faux-1' }, reviewer: { provider: 'faux', modelId: 'faux-1' } };
  const hooks = createHostHooks({ root, harness, worktree, state, models: choices, reviewerExtension, executorExtension, githubPlanReader, instructions: 'Offline test.', snapshotHttp: async () => { throw Error('network forbidden'); } });
  hooks.prepare = async () => ({ base, upstream: 'upstream/main', upstreamRef: 'refs/heads/main', upstreamSha: 'b'.repeat(40), intakePath: join(dir, 'intake.json'), usageStart: 0 });
  hooks.execute = async run => {
    const result = await createHostHooks({ root, harness, worktree, state, models: choices, reviewerExtension, executorExtension, githubPlanReader, instructions: 'Offline test.' }).execute(run);
    return result;
  };
  hooks.inspect = async () => snapshot(worktree);
  hooks.gate = async () => assert.fail('management-only plan must not gate');
  hooks.commit = async () => assert.fail('management-only plan must not commit');
  hooks.publish = async () => assert.fail('management-only plan must not publish');
  return { dir, state, worktree, harness, root, hooks };
}
const plan = actions => fauxAssistantMessage(fauxToolCall('propose_github', { actions }), { stopReason: 'toolUse' });
const end = () => fauxAssistantMessage('proposal recorded');
const readPlans = () => fauxAssistantMessage(fauxToolCall('read_github_plans', {}), { stopReason: 'toolUse' });
const issue = (title, body = 'A bounded request.') => ({ kind: 'create-issue', title, body });

test('real faux SDK executor persists proposals, redacts sentinels, reviewer reads ownerless plans, management phase has no side effects', async t => {
  const sentinels = Object.fromEntries(secretNames.map(key => [key, `sentinel-${key}-private-value`]));
  const saved = Object.fromEntries(secretNames.map(key => [key, process.env[key]]));
  Object.assign(process.env, sentinels);
  t.after(() => { for (const key of secretNames) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; });
  const actions = [issue('Known ' + sentinels.ZAI_API_KEY, `body ${sentinels.GH_TOKEN} ${sentinels.ANNIE_GH_TOKEN} ${sentinels.REGISTRY_PASSWORD}`)];
  const f = await fixture(t, [
    fauxAssistantMessage(fauxToolCall('bash', { command: 'test -z "$GH_TOKEN$ANNIE_GH_TOKEN$REGISTRY_PASSWORD$ZAI_API_KEY" && test -n "$PATH$HOME$TMPDIR$PUFFER_MAINT_INTAKE"' }), { stopReason: 'toolUse' }),
    plan(actions), end(), readPlans(), fauxAssistantMessage('{"approve":true,"findings":[]}'),
  ]);
  await f.root.commit(async tx => { (await tx.doc(RunDoc, f.root.id)).run = { day: '2026-04-03', requestId: 'request-one', startedAt: Date.now(), spent: 0, usageStart: 0, phase: 'admitted', timeline: [] }; }, ctx);
  const run = await advance(f.root, { harness: f.harness, ...f.hooks, day: '2026-04-03' });
  assert.equal(run.phase, 'managing');
  assert.equal(run.review.approve, true);
  assert.ok(run.reviewer);
  assert.equal(Object.hasOwn(f.root, '_maintainerHarness'), false);
  const stored = JSON.stringify((await f.harness.snapshot(GitHubPlansDoc, f.root.id, ctx)).plans);
  for (const secret of Object.values(sentinels)) assert.equal(stored.includes(secret), false);
  assert.match(stored, /\[redacted\]/);
});

test('same proposal replay deduplicates within run; tomorrow fresh request retires old proposals', async t => {
  const common = [issue('Repeated proposal')];
  const next = [issue('Next day proposal')];
  const f = await fixture(t, [plan(common), plan(common), end(), fauxAssistantMessage('{"approve":true,"findings":[]}'), plan(next), end(), fauxAssistantMessage('{"approve":true,"findings":[]}')]);
  await f.root.commit(async tx => { (await tx.doc(RunDoc, f.root.id)).run = { day: '2026-04-03', requestId: 'request-one', startedAt: Date.now(), spent: 0, usageStart: 0, phase: 'admitted', timeline: [] }; }, ctx);
  await advance(f.root, { harness: f.harness, ...f.hooks, day: '2026-04-03' });
  let stored = (await f.harness.snapshot(GitHubPlansDoc, f.root.id, ctx)).plans;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].actions[0].title, 'Repeated proposal');
  await f.root.commit(async tx => { (await tx.doc(RunDoc, f.root.id)).run = { day: '2026-04-03', requestId: 'request-two', startedAt: Date.now(), spent: 0, usageStart: 0, phase: 'admitted', timeline: [] }; }, ctx);
  await advance(f.root, { harness: f.harness, ...f.hooks, day: '2026-04-04' });
  stored = (await f.harness.snapshot(GitHubPlansDoc, f.root.id, ctx)).plans;
  assert.ok(stored.every(item => item.runId === 'request-two'));
  assert.deepEqual(stored.flatMap(item => item.actions).map(action => action.title), ['Next day proposal']);
});

test('active plans remain bounded across distinct proposals; invalid and destructive actions are rejected', async t => {
  const actions = Array.from({ length: 10 }, (_, index) => issue(`Proposal ${index}`));
  const destructive = [{ kind: 'delete-repository' }];
  const f = await fixture(t, [plan(actions), fauxAssistantMessage(fauxToolCall('propose_github', { actions: [issue('Second batch')] }), { stopReason: 'toolUse' }), fauxAssistantMessage(fauxToolCall('propose_github', { actions: destructive }), { stopReason: 'toolUse' }), end(), fauxAssistantMessage('{"approve":true,"findings":[]}')]);
  await f.root.commit(async tx => { (await tx.doc(RunDoc, f.root.id)).run = { day: '2026-04-03', requestId: 'request-one', startedAt: Date.now(), spent: 0, usageStart: 0, phase: 'admitted', timeline: [] }; }, ctx);
  await advance(f.root, { harness: f.harness, ...f.hooks, day: '2026-04-03' });
  const stored = (await f.harness.snapshot(GitHubPlansDoc, f.root.id, ctx)).plans;
  assert.ok(stored.flatMap(item => item.actions).length <= 10, `persisted ${stored.flatMap(item => item.actions).length} active actions`);
  assert.ok(stored.flatMap(item => item.actions).every(action => action.kind !== 'delete-repository'));
});

test('invalid issue title, labels, number, and updatedAt are rejected by actual proposal tool', async t => {
  const invalid = [
    [{ kind: 'create-issue', title: '  ', body: 'valid' }],
    [{ kind: 'add-label', number: 1, labels: ['ok', ''] , expectedUpdatedAt: '2026-04-03T00:00:00Z' }],
    [{ kind: 'comment', number: 0, body: 'valid', expectedUpdatedAt: '2026-04-03T00:00:00Z' }],
    [{ kind: 'comment', number: 1, body: 'valid', expectedUpdatedAt: 'not-a-date' }],
  ];
  const f = await fixture(t, [...invalid.map(actions => fauxAssistantMessage(fauxToolCall('propose_github', { actions }), { stopReason: 'toolUse' })), end()]);
  await f.root.commit(async tx => { (await tx.doc(RunDoc, f.root.id)).run = { day: '2026-04-03', requestId: 'request-one', startedAt: Date.now(), spent: 0, usageStart: 0, phase: 'admitted', timeline: [] }; }, ctx);
  await advance(f.root, { harness: f.harness, ...f.hooks, day: '2026-04-03' });
  assert.deepEqual((await f.harness.snapshot(GitHubPlansDoc, f.root.id, ctx))?.plans ?? [], []);
});
