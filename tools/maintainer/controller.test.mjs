import test, { after } from 'node:test';
import YAML from 'yaml';
// Provider fixtures are local faux calls even when this test suite runs on Actions.
const hosted = process.env.GITHUB_ACTIONS;
delete process.env.GITHUB_ACTIONS;
after(() => { if (hosted !== undefined) process.env.GITHUB_ACTIONS = hosted; });
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { RunDoc, CallsDoc, budgetModels, callUsage, withinBudget, createRuntime } from './maintain.mjs';
import { reportFor, collect } from './report.mjs';
import { makeLease, verifyLease, rollingAllowance, GitHub, unzipJSON, trustedRun, verifyWake, chooseTask, prFingerprint, controller, digest, observeLedger, provenZeroDispatch, noCompletionEvidence, POLICY_PATH } from './controller.mjs';
const now = Date.parse('2026-04-03T04:17:00Z'), HOUR = 3600000, DAY = 24 * HOUR;
const base = 'a'.repeat(40), head = 'b'.repeat(40), upstreamSha = 'c'.repeat(40), policy = 'p';
const task = { kind: 'maintenance', day: '2026-04-03', repo: 'bugabinga/pufferpanel', ref: 'refs/heads/trunk', base, upstreamSha, upstreamRef: 'refs/heads/main', fingerprint: 'd'.repeat(64) };
const run = { id: 42, run_attempt: 1, head_sha: base, event: 'schedule', created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(), repository: { id: 7 }, head_repository: { id: 7 }, head_branch: 'trunk', workflow_id: 8, path: POLICY_PATH, status: 'completed' };
const lease = () => makeLease({ run, repoId: 7, workflowId: 8, task, cap: 15, now });
const env = { GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: base, GITHUB_REPOSITORY_ID: '7' };
const response = (body, headers = {}, status = 200) => new Response(JSON.stringify(body), { headers, status });
async function scratch(t) { const dir = await mkdtemp(join(tmpdir(), 'annie-controller-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
function zip(value, name = 'lease.json') {
  const body = Buffer.from(JSON.stringify(value)), filename = Buffer.from(name), local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(filename.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(filename.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + filename.length, 12); end.writeUInt32LE(30 + filename.length + body.length, 16);
  return Buffer.concat([local, filename, body, central, filename, end]);
}
test('lease pins original task, cap, creation-anchored absolute deadline; queued-late/reruns never pay', () => {
  const l = lease(); assert.equal(l.deadline, now + 2 * HOUR); assert.deepEqual(verifyLease(l, { env, task }), l);
  for (const changed of [{ GITHUB_RUN_ATTEMPT: '2' }, { GITHUB_SHA: head }, { GITHUB_REPOSITORY_ID: '999' }, { GITHUB_RUN_ID: '43' }]) assert.throws(() => verifyLease(l, { env: { ...env, ...changed }, task }));
  assert.throws(() => verifyLease({ ...l, cap: 100 }, { env, task }));
  assert.throws(() => makeLease({ run: { ...run, run_attempt: 2 }, repoId: 7, workflowId: 8, task, cap: 15, now }));
  assert.throws(() => makeLease({ run, repoId: 7, workflowId: 8, task, cap: 15, now: now + 2 * HOUR }));
  assert.throws(() => withinBudget({ startedAt: now, absoluteDeadline: now + HOUR, spent: 0, budgetCap: 2 }, now + HOUR));
  assert.throws(() => withinBudget({ startedAt: now, spent: 1, budgetCap: 2 }, now, 1.01));
  withinBudget({ startedAt: now, spent: 14 }, now, 1);
});
test('rolling24h known complete REPLACES reservation; partial/missing/interrupted retains entire cap across midnight', () => {
  const l = lease(), settledAt = new Date(now + HOUR).toISOString();
  const known = { ledgerReservation: l.hash, usageComplete: true, reportedUsage: { status: 'known', cost: 2 } };
  const entry = { lease: l, settlement: known, settledAt };
  assert.equal(rollingAllowance([entry], now + 20 * HOUR), 13);
  assert.equal(rollingAllowance([entry], now + 24.5 * HOUR), 13);
  assert.equal(rollingAllowance([entry], now + 25 * HOUR), 15);
  for (const settlement of [null, { ...known, usageComplete: false }, { ...known, ledgerReservation: 'x' }, { ...known, reportedUsage: { status: 'unknown' }, knownSubtotal: 2 }]) assert.equal(rollingAllowance([{ ...entry, settlement }], now + 20 * HOUR), 0);
  assert.equal(rollingAllowance([{ ...entry, settlement: null }], now + 26 * HOUR), 0);
  assert.equal(rollingAllowance([{ ...entry, settlement: null }], now + 26 * HOUR + 300001), 15);
  assert.equal(rollingAllowance([{ ...entry, terminal: false }], now + 30 * HOUR), 0);
  assert.equal(rollingAllowance([{ unknown: true, updatedAt: settledAt }], now + 20 * HOUR), 0);
});
test('unknown attempt and later known retry charge independently; no full-cap refund funds replacement', () => {
  const original = makeLease({ run, repoId: 7, workflowId: 8, task, cap: 10, now }), replacement = makeLease({ run: { ...run, id: 43 }, repoId: 7, workflowId: 8, task, cap: 5, now });
  const settledAt = new Date(now).toISOString();
  const settlement = { ledgerReservation: replacement.hash, usageComplete: true, reportedUsage: { status: 'known', cost: 2 } };
  assert.equal(rollingAllowance([{ lease: original, settlement: null }, { lease: replacement, settlement, settledAt }], now), 3);
  assert.equal(rollingAllowance([{ lease: lease(), settlement: null }, { lease: replacement, settlement, settledAt }], now), 0);
});
test('zero-dispatch requires terminal native original model-step evidence; fallback never proves completion', () => {
  for (const jobs of [[{ name: 'check', conclusion: 'failure' }], [{ name: 'maintain', conclusion: 'skipped' }], [{ name: 'maintain', conclusion: 'failure', steps: [{ name: 'Maintain or review selected task', conclusion: 'skipped' }] }]]) assert.equal(provenZeroDispatch(run, jobs), true);
  for (const jobs of [[], [{ name: 'maintain', conclusion: 'cancelled' }], [{ name: 'maintain', steps: [{ name: 'Maintain or review selected task', conclusion: 'success' }] }]]) assert.equal(provenZeroDispatch(run, jobs), false);
  assert.equal(provenZeroDispatch({ ...run, status: 'in_progress' }, [{ name: 'maintain', conclusion: 'skipped' }]), false);
  const fallback = { fingerprint: null, ledgerReservation: null, reportedUsage: { status: 'unknown' } };
  assert.equal(noCompletionEvidence(fallback), true);
  for (const change of [{ fingerprint: task.fingerprint }, { ledgerReservation: lease().hash }, { commit: base }, { managementApproved: true }]) assert.equal(noCompletionEvidence({ ...fallback, ...change }), false);
});
test('PR fingerprint excludes clock/upstream/reviews; unchanged rejection/noop checkpoint suppresses admission', () => {
  const pr = { number: 3, head: { sha: head }, user: { login: 'oliver' } };
  const fingerprint = prFingerprint({ number: 3, head, base, policy });
  assert.equal(fingerprint, prFingerprint({ number: 3, head, base, policy, upstreamSha: 'z', day: 'tomorrow', reviews: [1] }));
  const args = { prs: [pr], base, upstreamSha, upstreamRef: 'refs/heads/main', day: task.day, policy, checkpoint: { handled: [], queue: 'q' } };
  assert.equal(chooseTask(args).fingerprint, fingerprint);
  assert.equal(chooseTask({ ...args, checkpoint: { handled: [fingerprint], queue: 'q' } }), null);
  assert.notEqual(chooseTask({ ...args, base: head }).fingerprint, fingerprint);
  assert.equal(chooseTask({ ...args, prs: [], queueChanged: true }).kind, 'management');
  assert.equal(chooseTask({ ...args, prs: [], daily: true }).kind, 'maintenance');
});
test('check is genuinely offline unpaid: no read, lease, retry, API, or filesystem access', async () => {
  const result = await controller({ env: { ANNIE_MODE: 'check' }, fetchImpl: () => { throw Error('must not request'); } });
  assert.deepEqual(result, { state: 'offline-unpaid' });
});
test('trusted run provenance excludes fork, foreign workflow/path/event; wake verified by ID/path not display name', async () => {
  assert.equal(trustedRun(run, { id: 7 }, { id: 8 }), true);
  for (const changed of [{ head_repository: { id: 9 } }, { repository: { id: 9 } }, { path: 'other.yml' }, { workflow_id: 9 }, { event: 'pull_request' }, { head_branch: 'feature' }]) assert.equal(trustedRun({ ...run, ...changed }, { id: 7 }, { id: 8 }), false);
  const api = { get: async path => path.includes('/workflows/') ? { id: 10, path: '.github/workflows/annie-pr-wake.yml' } : { id: 99, workflow_id: 10, path: '.github/workflows/annie-pr-wake.yml', repository: { id: 7 }, event: 'pull_request', status: 'completed' } };
  await verifyWake(api, { workflow_run: { id: 99 } }, { id: 7 });
  await assert.rejects(verifyWake(api, { workflow_run: { id: 99 } }, { id: 999 }));
  await assert.rejects(verifyWake({ get: async path => ({ ...await api.get(path), workflow_id: 99 }) }, { workflow_run: { id: 99 } }, { id: 7 }));
});
test('pagination covers every page/count; 1000 cap, missing page and malformed result fail closed', async () => {
  let calls = 0;
  const api = new GitHub('native', async () => ++calls === 1 ? response({ total_count: 2, jobs: [{ id: 1 }] }, { link: '<https://api.github.com/x?page=2>; rel="next"' }) : response({ total_count: 2, jobs: [{ id: 2 }] }));
  assert.deepEqual(await api.pages('/repos/bugabinga/pufferpanel/actions/x', 'jobs'), [{ id: 1 }, { id: 2 }]); assert.equal(calls, 2);
  for (const body of [{ total_count: 1000, jobs: [] }, { total_count: 2, jobs: [] }, { jobs: [] }, []]) await assert.rejects(new GitHub('', async () => response(body)).pages('/repos/bugabinga/pufferpanel/x', 'jobs'));
  const history = new GitHub('', async url => {
    const page = Number(new URL(url).searchParams.get('page'));
    return response({ total_count: 1000, workflow_runs: Array.from({ length: 100 }, (_, index) => ({ id: (page - 1) * 100 + index + 1 })) }, page < 10 ? { link: '<https://api.github.com/next>; rel="next"' } : {});
  });
  assert.equal((await history.pages('/repos/bugabinga/pufferpanel/actions/workflows/8/runs', 'workflow_runs')).length, 1000);
  await assert.rejects(history.pages('/repos/bugabinga/pufferpanel/actions/workflows/8/runs?created=2026-04-03', 'workflow_runs'), /incomplete/);
  let page = 0;
  const duplicate = new GitHub('', async () => response({ total_count: 2, jobs: [{ id: 1 }] }, ++page === 1 ? { link: '<next>; rel="next"' } : {}));
  await assert.rejects(duplicate.pages('/repos/bugabinga/pufferpanel/x', 'jobs'), /duplicate/);
});
test('ZIP allowlist, size bounds, digest and ID downloads; storage redirect NEVER receives native auth', async () => {
  const bytes = zip(lease()); assert.deepEqual(unzipJSON(bytes, 'lease.json'), lease());
  assert.throws(() => unzipJSON(zip({}, '../lease.json'), 'lease.json'));
  assert.throws(() => unzipJSON(Buffer.alloc(262145), 'lease.json'));
  assert.throws(() => unzipJSON(Buffer.alloc(22), 'lease.json'));
  const calls = [], meta = { id: 99, expired: false, size_in_bytes: bytes.length, digest: `sha256:${digest(bytes)}` };
  const api = new GitHub('native-secret', async (url, opts) => {
    calls.push({ url, opts });
    return calls.length % 2 === 1 ? new Response(null, { status: 302, headers: { location: 'https://storage.blob.core.windows.net/artifact' } }) : new Response(bytes);
  });
  await api.artifact(meta, 'lease.json');
  assert.match(calls[0].url, /artifacts\/99\/zip$/); assert.equal(calls[0].opts.redirect, 'manual'); assert.equal(calls[1].opts.headers, undefined);
  await assert.rejects(api.artifact({ ...meta, expired: true }, 'lease.json'));
  await assert.rejects(api.artifact({ ...meta, digest: `sha256:${'0'.repeat(64)}` }, 'lease.json'));
  const bad = new GitHub('secret', async () => new Response(null, { status: 302, headers: { location: 'https://evil.invalid/blob' } }));
  await assert.rejects(bad.artifact(meta, 'lease.json'));
});
test('actual startup fallback report settles no identity and retains full prepaid cap', async t => {
  const dir = await scratch(t), rawPath = join(dir, 'initial.json'), reportDir = join(dir, 'collected');
  await writeFile(rawPath, JSON.stringify(reportFor({ day: task.day, phase: 'starting', spent: null, version: '2026.4.3' }, { interrupted: true })));
  const initial = await collect({ reportPath: rawPath, reportDir });
  assert.equal(initial.day, task.day); assert.equal(initial.phase, 'starting'); assert.equal(noCompletionEvidence(initial), true);
  assert.equal(noCompletionEvidence({ ...initial, fingerprint: task.fingerprint }), false);
  const l = lease(), artifacts = [
    { id: 1, name: 'annie-lease-42-1', created_at: run.created_at },
    { id: 2, name: 'honest-annie-model-report-42-1', created_at: new Date(now + 1000).toISOString() },
  ];
  const api = { pages: async path => path.includes('/artifacts') ? artifacts : [run], artifact: async meta => meta.id === 1 ? l : initial };
  const ledger = await observeLedger(api, { id: 7 }, { id: 8 }, now + HOUR, 43);
  assert.equal(ledger.allowance, 0); assert.equal(ledger.records[0].settlement, null);
});
test('ledger duplicate/deleted/partial settlement artifacts fail closed; release report never moves billing timestamp', async () => {
  const l = lease(), cp = { schema: 1, runId: 42, repoId: 7, handled: [], slots: [], paid: true }, model = { ledgerReservation: l.hash, fingerprint: task.fingerprint, taskKind: task.kind, day: task.day, base, phase: 'published', commit: null, releaseCommit: null, managementApproved: false, usageComplete: true, reportedUsage: { status: 'known', cost: 2 } };
  const artifacts = [
    { id: 1, name: 'annie-checkpoint-42-1', created_at: run.created_at },
    { id: 2, name: 'annie-lease-42-1', created_at: run.created_at },
    { id: 3, name: 'honest-annie-model-report-42-1', created_at: new Date(now + HOUR).toISOString() },
    { id: 4, name: 'honest-annie-release-report-42-2', created_at: new Date(now + 20 * HOUR).toISOString() },
  ];
  const api = { pages: async path => path.includes('/artifacts') ? artifacts : [run], artifact: async meta => ({ 1: cp, 2: l, 3: model, 4: model })[meta.id] };
  assert.equal((await observeLedger(api, { id: 7 }, { id: 8 }, now + 25 * HOUR, 43)).allowance, 15);
  artifacts.push({ ...artifacts[1], id: 5 }); await assert.rejects(observeLedger(api, { id: 7 }, { id: 8 }, now, 43), /duplicate/); artifacts.pop();
  artifacts.splice(1, 1); assert.equal((await observeLedger(api, { id: 7 }, { id: 8 }, now + HOUR, 43)).allowance, 0);
});
test('rolling created horizon survives 12000 lifetime runs, old-created rerun today, carried ancient pending ID', async () => {
  const ancient = { ...run, id: 5, created_at: new Date(now - 60 * DAY).toISOString(), updated_at: new Date(now - 40 * DAY).toISOString(), status: 'in_progress' };
  const rerun = { ...run, id: 7, run_attempt: 2, created_at: new Date(now - 29 * DAY).toISOString() };
  const lifetime = Array.from({ length: 12000 }, (_, index) => ({ ...run, id: index + 100, created_at: new Date(now - 100 * DAY - index * HOUR).toISOString(), updated_at: new Date(now - 100 * DAY).toISOString() }));
  const calls = [], cp = { id: 1, name: 'annie-checkpoint-42-1', created_at: new Date(now).toISOString() };
  const api = new GitHub('offline', async url => {
    calls.push(url); const u = new URL(url);
    if (u.pathname.endsWith('/workflows/8/runs')) {
      assert.ok(u.searchParams.has('created'));
      const [start, end] = u.searchParams.get('created').split('..').map(Date.parse);
      const items = [run, rerun, ...lifetime].filter(r => Date.parse(r.created_at) >= start && Date.parse(r.created_at) <= end);
      return response({ total_count: items.length, workflow_runs: items });
    }
    if (u.pathname.endsWith('/runs/5')) return response(ancient);
    if (u.pathname.endsWith('/artifacts')) { const artifacts = u.pathname.includes('/42/') ? [cp] : u.pathname.includes('/7/') ? [{ id: 2, name: 'annie-lease-7-1', expired: true, created_at: rerun.created_at }, { id: 3, name: 'honest-annie-candidate-7-1', expired: true }] : []; return response({ total_count: artifacts.length, artifacts }); }
    if (u.pathname.endsWith('/jobs')) return response({ total_count: 0, jobs: [] });
    throw Error('unexpected offline history request');
  });
  api.artifact = async () => ({ schema: 1, runId: 42, repoId: 7, handled: [], slots: [], paid: false, pendingRuns: [5], flights: [{ runId: 5, task, queue: 'f'.repeat(64) }] });
  const ledger = await observeLedger(api, { id: 7 }, { id: 8 }, now, 43);
  assert.equal(ledger.allowance, 0); assert.ok(ledger.outstanding.includes(5)); assert.equal(ledger.runs.length, 3);
  assert.equal(calls.filter(url => url.includes('/workflows/8/runs')).length, 1);
  assert.ok(calls.some(url => url.endsWith('/runs/5'))); assert.equal(calls.some(url => url.includes('/runs/100/')), false);
  assert.deepEqual(ledger.blockers, [{ runId: 7, reason: 'expired-candidate-identity' }, { runId: 5, reason: 'admission-unreconciled' }]);
  api.artifact = async () => ({ schema: 1, runId: 42, repoId: 7, handled: [], slots: [], paid: false, pendingRuns: [5, 7], blocked: ledger.blockers });
  const refreshed = await observeLedger(api, { id: 7 }, { id: 8 }, now, 43);
  assert.deepEqual(refreshed.blockers, ledger.blockers); assert.ok(refreshed.outstanding.includes(7)); assert.equal(refreshed.allowance, 0);
});
test('saturated filtered history shards bounded windows, persistent saturation refuses admission', async () => {
  let windows = 0;
  const api = { pages: async path => { windows++; if (path.includes('created=')) throw Error('incomplete API pagination'); return []; } };
  await assert.rejects(observeLedger(api, { id: 7 }, { id: 8 }, now, 43), /pagination/);
  assert.ok(windows < 16);
});
async function modelFixture(t, behavior, extra = {}, selectedModel = null) {
  const dir = await scratch(t), registry = createRegistry();
  const harness = await Harness.open(await openNodeSqliteStorage(join(dir, 'calls.sqlite')), { registry, models: {} }, ctx);
  t.after(() => harness.close(ctx)); const root = await harness.root(ctx);
  const current = { startedAt: Date.now(), requestId: 'current', spent: 0, usageStart: 0, ...extra };
  await root.commit(async tx => { (await tx.doc(RunDoc, root.id)).run = current; }, ctx);
  let called = 0;
  const runtime = { streamSimple(model, transcript, options) { called++; return behavior(model, transcript, options); } };
  const model = selectedModel ?? { api: 'test', provider: 'test', id: 'test', contextWindow: 1000, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } };
  const proxy = budgetModels(runtime, { root, harness });
  const execute = async options => { const result = await proxy.streamSimple(model, {}, options).result(); return { result, usage: callUsage(await harness.snapshot(CallsDoc, root.id, ctx), 'current'), called }; };
  return { execute, root, harness };
}
const goodMessage = { role: 'assistant', content: [], stopReason: 'stop', usage: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 200, cost: { total: 0.0002 } } };
function stream(events) { const result = createAssistantMessageEventStream(); queueMicrotask(() => { for (const event of events) result.push(event); result.end(); }); return result; }
test('durable provider accounting settles real done; synthetic zero failed SSE stays unknown', async t => {
  const good = await modelFixture(t, (model, transcript, options) => { options.onProviderStreamEvent({ usage: { prompt_tokens: 100, completion_tokens: 100 } }, model); return stream([{ type: 'done', reason: 'stop', message: goodMessage }]); });
  const done = await good.execute(); assert.equal(done.usage.usageComplete, true); assert.equal(done.usage.cost, 0.0002); assert.equal(done.called, 1);
  for (const events of [[], [{ type: 'error', error: { ...goodMessage, stopReason: 'error', usage: { ...goodMessage.usage, cost: { total: 0 } } } }], [{ type: 'done', reason: 'error', message: goodMessage }], [{ type: 'done', reason: 'stop', message: { ...goodMessage, usage: null } }]]) {
    const f = await modelFixture(t, () => stream(events)); const failed = await f.execute();
    assert.equal(failed.usage.usageComplete, false); assert.equal(failed.usage.cost, null); assert.equal(failed.usage.knownSubtotal, 0); assert.equal(failed.usage.dispatched, 1);
  }
});
test('installed OpenAI SDK adapter raw SSE usage, not normalized zero, settles accounting', async t => {
  const runtime = await createRuntime(await scratch(t));
  const selectedModel = { ...runtime.getModel('zai', 'glm-5.3'), contextWindow: 1000, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } };
  for (const raw of [{ prompt_tokens: 100, completion_tokens: 100 }, {}, undefined, { prompt_tokens: 100 }, { completion_tokens: 100 }, { prompt_tokens: 100, completion_tokens: 100, partial: true }, { http: 401 }, { http: 429 }, { http: 503 }, { prompt_tokens: 100, completion_tokens: 100, early: true }]) {
    let hooks = 0, requests = 0;
    const fixture = await modelFixture(t, (model, transcript, options) => runtime.streamSimple({ ...model, api: 'openai-completions', baseUrl: 'https://offline.invalid/v1', name: 'fixture', reasoning: false, input: ['text'], maxTokens: 4000 }, { messages: [{ role: 'user', content: 'fixture', timestamp: Date.now() }] }, { ...options, apiKey: 'offline-key', fetch: async () => {
      requests++;
      if (raw?.http) return new Response(JSON.stringify({ error: { message: raw.http === 401 ? 'invalid key' : 'temporarily unavailable' } }), { status: raw.http, headers: { 'content-type': 'application/json' } });
      const chunks = [{ id: 'x', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] }, { id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], ...(raw === undefined ? {} : { usage: raw }) }];
      if (raw?.early) { chunks[0].usage = raw; delete chunks[1].usage; chunks[1].choices[0].delta.content = 'more output after usage'; }
      if (raw?.partial) {
        let sent = false;
        return new Response(new ReadableStream({ pull(controller) {
          if (sent) controller.error(Error('offline partial SSE failure'));
          else { sent = true; controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ ...chunks[0], usage: raw })}\n\n`)); }
        } }), { headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    } }), {}, selectedModel);
    const result = await fixture.execute({ onProviderStreamEvent() { hooks++; } });
    assert.equal(requests, 1); assert.ok(hooks >= (raw?.http ? 0 : raw?.partial ? 1 : 2));
    assert.equal(result.result.stopReason, raw?.partial || raw?.http ? 'error' : 'stop');
    if (raw?.http) assert.equal(result.usage.modelFailure, raw.http === 401 ? 'environment' : 'transient');
    assert.equal(result.usage.cost, !raw?.partial && !raw?.early && raw?.prompt_tokens !== undefined && raw?.completion_tokens !== undefined ? 0.0002 : null);
  }
});
test('provider throw/cancellation remains unknown; remainder/deadline rejects BEFORE target with known zero actual calls', async t => {
  const thrown = await modelFixture(t, () => { throw Error('provider throw'); }); assert.equal((await thrown.execute()).usage.cost, null);
  const abort = new AbortController();
  const cancelled = await modelFixture(t, () => { abort.abort(); return stream([{ type: 'done', reason: 'stop', message: goodMessage }]); }); assert.equal((await cancelled.execute({ signal: abort.signal })).usage.cost, null);
  const before = await modelFixture(t, () => assert.fail('already cancelled must not dispatch'));
  assert.equal((await before.execute({ signal: abort.signal })).usage.cost, 0);
  for (const extra of [{ budgetCap: 0.001 }, { absoluteDeadline: Date.now() - 1 }]) {
    const f = await modelFixture(t, () => { throw Error('must not dispatch'); }, extra);
    const result = await f.execute(); assert.equal(result.called, 0); assert.equal(result.usage.cost, 0); assert.equal(result.usage.usageComplete, true);
  }
  assert.equal(callUsage({ requestId: 'stale', calls: [{ cost: 9, cap: 15 }] }, 'current').cost, 0);
});
test('YAML semantic validation: unique keys, acyclic DAG, effects leaf, native auth policy steps', async () => {
  for (const path of ['../../.github/workflows/honest-annie.yml', '../../.github/workflows/annie-pr-wake.yml']) {
    const document = YAML.parseDocument(await readFile(new URL(path, import.meta.url), 'utf8'), { uniqueKeys: true });
    assert.deepEqual(document.errors, []); const workflow = document.toJS(); assert.ok(workflow.on);
    const jobs = workflow.jobs;
    const visit = (id, ancestors = []) => { assert.ok(jobs[id], id); assert.ok(!ancestors.includes(id), 'DAG cycle'); for (const dependency of [jobs[id].needs ?? []].flat()) visit(dependency, [...ancestors, id]); };
    for (const id of Object.keys(jobs)) visit(id);
    if (!jobs.release) continue;
    for (const job of Object.values(jobs)) assert.ok(![job.needs ?? []].flat().includes('release'), 'effects must remain leaf');
    for (const suffix of ['registry-login', 'publish']) {
      const step = jobs.release.steps.find(step => step.run === `bash tools/maintainer/ci.sh ${suffix}`);
      assert.equal(step.env.GH_TOKEN, '${{ github.token }}'); assert.equal(step.env.ANNIE_GH_TOKEN, undefined);
    }
  }
});
test('workflow isolates secretless PR wake, trusted observation, prepaid attempt1, original task and effects-only retry', async () => {
  const main = await readFile(new URL('../../.github/workflows/honest-annie.yml', import.meta.url), 'utf8');
  const wake = await readFile(new URL('../../.github/workflows/annie-pr-wake.yml', import.meta.url), 'utf8');
  assert.match(wake, /permissions: \{\}/); assert.doesNotMatch(wake, /checkout|secrets\.|upload-artifact|download-artifact/);
  assert.match(main, /workflows: \[Annie PR wake\]/); assert.doesNotMatch(main, /workflows: \[honest_annie\]/);
  assert.match(main, /cron: '7,37 \* \* \* \*'/); assert.doesNotMatch(main, /date -u/);
  const model = main.slice(main.indexOf('  maintain:'), main.indexOf('  release:'));
  assert.ok(model.indexOf('ci.sh preflight') < model.indexOf('name: annie-lease-'));
  assert.ok(model.indexOf('name: annie-lease-') < model.indexOf('secrets.ZAI_API_KEY'));
  assert.doesNotMatch(model, /ANNIE_GH_TOKEN|REGISTRY_PASSWORD|contents: write/);
  const release = main.slice(main.indexOf('  release:'), main.indexOf('  retry-effects:'));
  assert.ok(release.indexOf('ci.sh push') < release.indexOf('ci.sh registry-login'));
  assert.match(release, /PUFFER_MAINT_TASK: \$\{\{ needs.observe.outputs.task \}\}/);
  assert.match(release, /honest-annie-candidate-\$\{\{ github.run_id \}\}-1/);
  assert.equal((main.match(/secrets.ANNIE_GH_TOKEN/g) ?? []).length, 1);
});

test('hosted provider runtime rejects attempt2 before dispatch even with a copied lease hash', async t => {
  const actions = process.env.GITHUB_ACTIONS, attempt = process.env.GITHUB_RUN_ATTEMPT;
  process.env.GITHUB_ACTIONS = 'true'; process.env.GITHUB_RUN_ATTEMPT = '2';
  t.after(() => {
    if (actions === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = actions;
    if (attempt === undefined) delete process.env.GITHUB_RUN_ATTEMPT; else process.env.GITHUB_RUN_ATTEMPT = attempt;
  });
  const f = await modelFixture(t, () => assert.fail('rerun must never dispatch'), { ledgerReservation: 'f'.repeat(64) });
  const result = await f.execute();
  assert.equal(result.called, 0); assert.equal(result.usage.cost, 0); assert.match(result.result.errorMessage, /original prepaid lease/);
});
