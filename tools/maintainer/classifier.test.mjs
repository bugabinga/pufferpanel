import test, { after } from 'node:test';
// Provider fixtures are local faux calls even when this test suite runs on Actions.
const hosted = process.env.GITHUB_ACTIONS;
delete process.env.GITHUB_ACTIONS;
after(() => { if (hosted !== undefined) process.env.GITHUB_ACTIONS = hosted; });
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { CLASSIFIER_HEADROOM, CallsDoc, ModelCodemode, RunDoc, budgetModels, callUsage, codemodeSandbox, exhaustedProviders } from './maintain.mjs';
after(() => codemodeSandbox.close());

// No faux classifier exists in pi-ai, so a real provider built from parts serves one classifier and one image model.
const usage = (input, cost) => ({ input, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: input + 1, cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } });
const judge = { id: 'clef', name: 'clef', api: 'judge-classify', provider: 'judge', baseUrl: 'https://judge.invalid', type: 'classifier', input: ['text'], contextWindow: 100_000, cost: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0 } };
const painter = { id: 'brush', name: 'brush', api: 'judge-image', provider: 'judge', baseUrl: 'https://judge.invalid', type: 'image', input: ['text'], output: ['image'], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
function judgeProvider(answer) {
  const seen = { classify: [], images: 0 };
  const provider = createProvider({ id: 'judge', baseUrl: 'https://judge.invalid', auth: { apiKey: { name: 'Judge', resolve: async () => ({ auth: {} }) } }, models: [judge, painter],
    classifiers: { 'judge-classify': { classify: async (model, context, options) => { seen.classify.push({ context, options }); return { api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), ...answer(context) }; } } },
    images: { 'judge-image': { generateImages: async () => { seen.images++; return { api: painter.api, provider: 'judge', model: painter.id, output: [], stopReason: 'stop', timestamp: Date.now() }; } } } });
  return { provider, seen };
}
const flaky = { state: { log: 'TestServers_Restarts failed: server running; passed on rerun' }, questions: { flaky: { type: 'bool', instructions: 'Does this log mention a flaky test?', criteria: { true: 'it does', false: 'it does not' } } } };
const capOf = context => Math.min(judge.contextWindow, Buffer.byteLength(JSON.stringify(context)) + CLASSIFIER_HEADROOM) * 2 / 1_000_000;
async function fixture(t, answer, runFields = {}, models = createModels()) {
  const dir = await mkdtemp(join(tmpdir(), 'annie-classifier-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const { provider, seen } = judgeProvider(answer); models.setProvider(provider);
  const registry = createRegistry(); registry.install(ModelCodemode);
  const policy = { models: [{ provider: 'faux', modelId: 'faux-1' }] };
  const harness = await Harness.open(await openNodeSqliteStorage(join(dir, 'run.sqlite')), { models: budgetModels(models, policy), registry }, ctx);
  t.after(() => harness.close(ctx));
  const root = await harness.root(ctx); Object.assign(policy, { root, harness });
  await root.commit(async tx => { (await tx.doc(RunDoc, root.id)).run = { requestId: 'current', startedAt: Date.now(), spent: 0, phase: 'executing', ...runFields }; }, ctx);
  const calls = async () => (await harness.snapshot(CallsDoc, root.id, ctx))?.calls ?? [];
  return { harness, root, seen, calls, models };
}

test('script models.classify crosses budget admission: reserved before dispatch, settled from usage, counted; generateImages is refused', async t => {
  const faux = fauxProvider({ models: [{ id: 'faux-1', contextWindow: 10000, maxTokens: 8192, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } }] });
  const models = createModels(); models.setProvider(faux.provider);
  const f = await fixture(t, () => ({ answers: { flaky: { type: 'bool', probability: 0.93 } }, stopReason: 'stop', usage: usage(120, 0.00024) }), {}, models);
  // The script triages a log with the classifier, then tries image generation, which must fail before its provider.
  const script = `const [judge] = await models.getAvailableOfType('classifier');
const verdict = await models.classify(judge, ${JSON.stringify(flaky)});
const [painter] = await models.getAvailableOfType('image');
let images; try { images = await models.generateImages(painter, { input: [{ type: 'text', text: 'a skull' }] }); } catch (error) { images = { thrown: String(error.message ?? error) }; }
console.log('TRIAGE', verdict.answers.flaky.probability > 0.5, JSON.stringify(images));`;
  faux.setResponses([fauxAssistantMessage(fauxToolCall('codemode', { code: script }), { stopReason: 'toolUse' }), fauxAssistantMessage('Triaged.')]);
  await f.root.configure({ model: { provider: 'faux', modelId: 'faux-1' }, thinkingLevel: 'off', extensions: [ModelCodemode], modelTools: [ModelCodemode.tools.find(tool => tool.name === 'codemode')] }, ctx);
  const settled = await (await f.root.submit({ type: 'input', requestId: 'current', content: 'triage' }, ctx)).wait(ctx);
  assert.equal(settled.status, 'done');
  const items = JSON.stringify((await f.root.entries({}, 1000, undefined, ctx)).items);
  assert.match(items, /TRIAGE true/); assert.match(items, /image generation is disabled: it has no budget admission/);
  assert.equal(f.seen.images, 0); assert.equal(f.seen.classify.length, 1); assert.equal(f.seen.classify[0].options.maxRetries, 0);
  const calls = await f.calls(), classified = calls.filter(call => call.type === 'classifier');
  assert.deepEqual(classified, [{ model: 'judge/clef', cap: capOf(flaky), cost: 0.00024, type: 'classifier' }]);
  const summary = callUsage({ requestId: 'current', calls }, 'current');
  assert.equal(summary.dispatched, calls.length); assert.equal(calls.length, 3); assert.equal(summary.usageComplete, true); assert.ok(summary.cost >= 0.00024);
});

test('classifier admission refuses over budget, past deadline, and at the call limit before dispatch', async t => {
  for (const [fields, error, prefill] of [[{ budgetCap: capOf(flaky) / 2 }, /budget/], [{ startedAt: Date.now() - 3 * 3_600_000 }, /deadline/], [{}, /model call limit exceeded/, 256]]) {
    const f = await fixture(t, () => assert.fail('must not dispatch'), fields);
    if (prefill) await f.root.commit(async tx => { const doc = await tx.doc(CallsDoc, f.root.id); doc.requestId = 'current'; doc.calls = Array.from({ length: prefill }, () => ({ model: 'faux/faux-1', cap: 0, cost: 0 })); }, ctx);
    const result = await budgetModels(f.models, { root: f.root, harness: f.harness }).classify(judge, flaky);
    assert.equal(result.stopReason, 'error'); assert.match(result.errorMessage, error); assert.equal(f.seen.classify.length, 0);
    assert.equal((await f.calls()).length, prefill ?? 0);
  }
  // Unpriced classifiers never dispatch either.
  const f = await fixture(t, () => assert.fail('must not dispatch'));
  const unpriced = await budgetModels(f.models, { root: f.root, harness: f.harness }).classify({ ...judge, cost: {} }, flaky);
  assert.match(unpriced.errorMessage, /classifier pricing unknown/); assert.equal((await f.calls()).length, 0); assert.equal(f.seen.classify.length, 0);
});

test('classifier usage: unknown usage holds the reservation, provider errors settle at it, and neither is provider evidence', async t => {
  const outcomes = [
    ['no usage reported', () => ({ answers: {}, stopReason: 'stop' }), null],
    ['usage without prompt tokens', () => ({ answers: {}, stopReason: 'stop', usage: usage(0, 0) }), null],
    ['aborted', () => ({ answers: {}, stopReason: 'aborted' }), null],
    ['provider error', () => ({ answers: {}, stopReason: 'error', errorMessage: '401 Incorrect API key provided' }), 'cap'],
  ];
  for (const [name, answer, settles] of outcomes) {
    const models = createModels(), f = await fixture(t, answer, {}, models);
    const budgeted = budgetModels(models, { root: f.root, harness: f.harness });
    await budgeted.classify(judge, flaky);
    const calls = await f.calls(), summary = callUsage({ requestId: 'current', calls }, 'current');
    assert.deepEqual(calls, [{ model: 'judge/clef', cap: capOf(flaky), cost: settles ? capOf(flaky) : null, type: 'classifier' }], name);
    assert.equal(summary.held, capOf(flaky), name); assert.equal(summary.usageComplete, Boolean(settles), name);
    assert.deepEqual([summary.providerFailures, summary.modelFailure, [...exhaustedProviders(calls)]], [[], null, []], name);
  }
});

test('raw dispatch paths are refused or budgeted, never forwarded unadmitted', async t => {
  const runtime = { streamSimple() { throw Error('must not dispatch'); }, stream() { throw Error('forwarded'); }, generateImages() { throw Error('forwarded'); } };
  const f = await fixture(t, () => ({}), { startedAt: Date.now() - 3 * 3_600_000 });
  const budgeted = budgetModels(runtime, { root: f.root, harness: f.harness });
  for (const key of ['stream', 'complete', 'streamDeferred', 'fetchDeferred', 'cancelDeferred']) assert.throws(() => budgeted[key](judge, {}), /unbudgeted model operation .* refused/);
  assert.equal((await budgeted.generateImages(painter, { input: [] })).stopReason, 'error');
  // Compaction's completeSimple goes through the same admission, which refuses here because the deadline passed.
  const completed = await budgeted.completeSimple({ api: 'test', provider: 'test', id: 'test', contextWindow: 1000, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } }, {});
  assert.equal(completed.stopReason, 'error'); assert.match(completed.errorMessage, /deadline/);
});
