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
import { advance, createHostHooks, ensureWorktree, guardFor, installReviewer, ModelCodemode, ModelCodingTools, snapshot } from './maintain.mjs';
import { HARNESS_CAP, validateTask } from './task.mjs';
import { MAX_REPAIRS, deliverHarness, detectIncidents, foldIncidents, foldRepair, harnessIncidentMarker, incidentBody, makeDigest, openRepairs, parseDigest, ready, repairDecision, syncIncidents, validateIncidents } from './incident.mjs';
import { GitHub, digest as sha256, makeLease, verifyLease, POLICY_PATH } from './controller.mjs';
import { checkPR } from './pr.mjs';
import { HARNESS_PATHS, harnessScope, harnessScopeViolation } from './scope.mjs';
import { verifyCandidate } from './ci-source.mjs';
import { reportFor } from './report.mjs';
import { classifyCommand, confinePath } from './guard.mjs';
import { fakeReviewSandbox, pinnedRunroot } from './fake-podman.mjs';

const moduleDir = new URL('.', import.meta.url).pathname;
const round = call => fauxAssistantMessage(call, { stopReason: 'toolUse' });
const codemode = code => fauxToolCall('codemode', { code });
const INCIDENT = 'd'.repeat(64);
const HONEST_ANNIE = 'name: honest_annie\non:\n  push:\n    branches: [trunk]\n  workflow_dispatch:\npermissions:\n  contents: read\njobs:\n  check:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo ok\n';
// The review's scope matrix: only tools/maintainer/** and honest-annie.yml with frozen on: triggers and top-level keys.
const SCOPE_CASES = [
  ['new workflow', { '.github/workflows/evil.yml': 'name: evil\non: pull_request\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: git push\n' }, /not \.github\/workflows\/evil\.yml/],
  ['build.yml edit', { '.github/workflows/build.yml': 'name: build\non: pull_request\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: git push\n' }, /not \.github\/workflows\/build\.yml/],
  ['annie-pr-wake.yml edit', { '.github/workflows/annie-pr-wake.yml': 'name: Annie PR wake\non: pull_request\npermissions:\n  contents: write\njobs:\n  wake:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: git push\n' }, /not \.github\/workflows\/annie-pr-wake\.yml/],
  ['actionlint.yaml', { '.github/actionlint.yaml': 'self-hosted-runner: {}\n' }, /not \.github\/actionlint\.yaml/],
  ['honest-annie.yml step edit, on unchanged', { '.github/workflows/honest-annie.yml': HONEST_ANNIE.replace('echo ok', 'echo fixed'), 'tools/maintainer/x.mjs': 'export const x = 1;\n' }, null],
  ['honest-annie.yml on adds pull_request', { '.github/workflows/honest-annie.yml': HONEST_ANNIE.replace('  workflow_dispatch:\n', '  workflow_dispatch:\n  pull_request:\n') }, /on: triggers/],
  ['honest-annie.yml YAML 1.1 true: trigger key', { '.github/workflows/honest-annie.yml': `${HONEST_ANNIE}true: [pull_request]\n` }, /top-level keys/],
];

// A miniature repository with a harness module (offline npm ci: no dependencies), a shell script, and one workflow.
export async function harnessRepo(t, { testExit = 0 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'annie-harness-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'source'), bin = join(dir, 'bin');
  await mkdir(join(source, 'tools/maintainer'), { recursive: true }); await mkdir(join(source, '.github/workflows'), { recursive: true }); await mkdir(bin);
  const g = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g('init', '-q', '-b', 'trunk'); g('config', 'user.name', 'test'); g('config', 'user.email', 'test@example.invalid');
  await writeFile(join(source, 'README.md'), 'product\n');
  await writeFile(join(source, 'tools/maintainer/package.json'), JSON.stringify({ name: 'fixture', private: true, scripts: { test: `node -e "process.exit(Object.keys(process.env).some(k => /TOKEN|API_KEY|SECRET|PASSWORD|GITHUB_/i.test(k)) ? 7 : ${testExit})"` } }));
  await writeFile(join(source, 'tools/maintainer/package-lock.json'), JSON.stringify({ name: 'fixture', lockfileVersion: 3, requires: true, packages: { '': { name: 'fixture' } } }));
  await writeFile(join(source, 'tools/maintainer/run.sh'), '#!/usr/bin/env bash\necho ok\n');
  await writeFile(join(source, '.github/workflows/honest-annie.yml'), HONEST_ANNIE);
  await writeFile(join(source, '.github/workflows/build.yml'), 'name: build\non:\n  pull_request:\n    branches: [v3]\njobs:\n  a:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo build\n');
  await writeFile(join(source, '.github/workflows/annie-pr-wake.yml'), 'name: Annie PR wake\non:\n  pull_request:\n    branches: [trunk]\npermissions: {}\njobs:\n  wake:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo wake\n');
  g('add', '.'); g('commit', '-qm', 'base'); g('remote', 'add', 'upstream', source);
  const base = g('rev-parse', 'HEAD');
  // Fake Go: actionlint is pinned and network-fetched in production; offline tests record the invocation instead.
  await writeFile(join(bin, 'go'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >>${JSON.stringify(join(dir, 'go-calls'))}\n`); await chmod(join(bin, 'go'), 0o755);
  const state = join(dir, 'state'); await mkdir(state);
  const task = validateTask({ kind: 'harness', day: '2026-04-03', repo: 'bugabinga/pufferpanel', ref: 'refs/heads/trunk', base, upstreamSha: base, upstreamRef: 'refs/heads/trunk', fingerprint: 'e'.repeat(64), incident: INCIDENT });
  return { dir, source, state, bin, g, base, task, runroot: pinnedRunroot(t), path: `${bin}:${process.env.PATH}` };
}

test('harness snapshot flags product edits, ordinary snapshot flags harness edits; a stray object never flips semantics', async t => {
  const f = await harnessRepo(t), worktree = await ensureWorktree(f.source, f.state);
  await writeFile(join(worktree, 'tools/maintainer/x.mjs'), 'export const x = 1;\n');
  assert.equal((await snapshot(worktree, true)).protected, false); assert.equal((await snapshot(worktree)).protected, true);
  assert.equal((await snapshot(worktree, { truthy: 'Harness object' })).protected, true);
  await writeFile(join(worktree, 'README.md'), 'stray product edit\n');
  assert.equal((await snapshot(worktree, true)).protected, true);
});

test('harness guard variant allows only tools/maintainer and honest-annie.yml, still blocks .git, escapes, and host authority', async t => {
  const f = await harnessRepo(t), worktree = await ensureWorktree(f.source, f.state);
  const guard = guardFor(worktree, f.task), plain = guardFor(worktree, { ...f.task, kind: 'maintenance' });
  assert.equal(guard.name, 'pufferpanel-harness-guard'); assert.equal(plain.name, 'pufferpanel-guard');
  assert.equal(await confinePath(worktree, 'tools/maintainer/x.mjs', []), join(await (await import('node:fs/promises')).realpath(worktree), 'tools/maintainer/x.mjs'));
  await assert.rejects(confinePath(worktree, 'tools/maintainer/x.mjs'), /host-trusted harness/);
  await assert.rejects(confinePath(worktree, '.git/config', []), /Git metadata/);
  await assert.rejects(confinePath(worktree, '../outside', []), /outside the maintenance worktree/);
  for (const command of ['git commit -qm x', 'git push origin HEAD', 'gh pr create', 'podman login x']) assert.ok(classifyCommand(command, { worktree, protectedPaths: [] }), command);
  assert.equal(classifyCommand('echo x > tools/maintainer/x.mjs', { worktree, protectedPaths: [] }), null);
  // Layer (a): writes outside the harness scope get a corrective reason; the on: freeze is checked by later layers.
  const real = await (await import('node:fs/promises')).realpath(worktree);
  for (const path of ['tools/maintainer/y.mjs', '.github/workflows/honest-annie.yml']) assert.equal(await confinePath(worktree, path, [], HARNESS_PATHS), join(real, path));
  for (const path of ['.github/workflows/evil.yml', '.github/workflows/build.yml', '.github/workflows/annie-pr-wake.yml', '.github/actionlint.yaml', 'README.md']) await assert.rejects(confinePath(worktree, path, [], HARNESS_PATHS), /outside the harness repair scope/, path);
  assert.match(classifyCommand('echo x > .github/workflows/evil.yml', { worktree, protectedPaths: [], allowedPaths: HARNESS_PATHS }), /outside the harness repair scope/);
  assert.equal(classifyCommand('echo x > /tmp/scratch && echo y > tools/maintainer/z.mjs', { worktree, protectedPaths: [], allowedPaths: HARNESS_PATHS }), null);
});

test('faux real-Harness harness task: guarded executor edits tools/maintainer, reviewer approves read-only, real harness gate passes, export says harness', async t => {
  const f = await harnessRepo(t), worktree = await ensureWorktree(f.source, f.state);
  const digest = makeDigest({ fingerprint: INCIDENT, kind: 'job-failed', detail: 'observe failed at Rediscover', runs: [5], firstSeen: 1, count: 2 }, [{ runId: 5, jobs: [{ name: 'observe', conclusion: 'failure', steps: [{ name: 'Rediscover', conclusion: 'failure' }], log: 'boom ghp_abcdefghijklmnopqrstuvwxyz0123 leaked\nTypeError: x is not a function' }] }]);
  assert.doesNotMatch(JSON.stringify(digest), /ghp_abcdef/);
  const executorScript = `const intake = JSON.parse((await tools.bash({ command: 'cat "$PUFFER_MAINT_INTAKE"' })).output);
if (intake.incident.incident !== '${INCIDENT}' || !JSON.stringify(intake.incident).includes('untrusted id=')) throw new Error('digest missing or not spotlit');
let refused = ''; try { await tools.bash({ command: 'git commit -qm sneaky' }); } catch (error) { refused = String(error.message ?? error); }
if (!/host commits/.test(refused)) throw new Error('guard missing');
await tools.write({ path: 'tools/maintainer/x.mjs', content: 'export const fixed = true;\\n' });
console.log('EXECUTOR-OK');`;
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  // Each follow-up step proves the previous script ran to its end: a throwing script only yields a tool error.
  const after = (marker, message) => context => { assert.match(JSON.stringify(context.messages.at(-1)), new RegExp(marker)); return message; };
  faux.setResponses([round(codemode(executorScript)), after('EXECUTOR-OK', fauxAssistantMessage('Root cause: observe called an undefined helper. Fixed it with a test.')),
    round(codemode("const diff = await tools.diff({}); if (!diff.includes('tools/maintainer/x.mjs')) throw new Error('diff missing'); let ran = ''; try { await tools.run({ command: 'npm test' }); } catch (error) { ran = String(error.message); } if (!/unavailable/.test(ran)) throw new Error('run must be unavailable'); console.log('REVIEW-OK');")),
    after('REVIEW-OK', round(fauxToolCall('submit_verdict', { findings: [], checked: ['full harness diff'] })))]);
  const registry = createRegistry(); registry.install(ModelCodingTools); registry.install(ModelCodemode);
  const { sandbox } = await fakeReviewSandbox(t, f.dir, f.state);
  const reviewerExtension = installReviewer(registry, worktree, sandbox);
  const guard = guardFor(worktree, f.task); registry.install(guard);
  const harness = await Harness.open(await openNodeSqliteStorage(join(f.state, 'test.sqlite')), { models, registry, settings: { extensions: [ModelCodingTools], retry: { enabled: false } }, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? worktree }) }, ctx);
  t.after(() => harness.close(ctx)); const root = await harness.root(ctx);
  const choices = { executor: { provider: 'faux', modelId: 'faux-1' }, reviewer: { provider: 'faux', modelId: 'faux-1' } };
  const hooks = createHostHooks({ root, harness, worktree, state: f.state, models: choices, reviewerExtension, reviewSandbox: sandbox, guard, task: f.task, instructions: 'harness fixture', upstreamUrl: f.source, intakeProvider: async () => ({ upstream: {} }), incident: JSON.stringify(digest) });
  t.after(() => hooks.dispose());
  // Provider keys and tokens are not inherited by the harness gate's environment: the fixture test exits 7 if npm sees any.
  const saved = Object.fromEntries(['PATH', 'PUFFER_MAINT_RUNROOT', 'GH_TOKEN', 'ANNIE_GH_TOKEN', 'ZAI_API_KEY'].map(key => [key, process.env[key]]));
  Object.assign(process.env, { PATH: f.path, PUFFER_MAINT_RUNROOT: f.runroot, GH_TOKEN: 'gh-sentinel', ANNIE_GH_TOKEN: 'pat-sentinel', ZAI_API_KEY: 'zai-sentinel' });
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const run = await advance(root, { harness, ...hooks, deferPublish: true });
  assert.equal(run.phase, 'publishing', JSON.stringify({ blocker: run.blocker, reason: run.reason }));
  assert.equal(run.taskKind, 'harness'); assert.equal(run.incident, INCIDENT); assert.equal(run.review.approve, true);
  assert.match(run.diagnosis, /undefined helper/); assert.equal(run.executorDiagnostics[0].turn, 'harness');
  assert.equal(run.sandbox.status, 'unavailable'); assert.match(run.sandbox.reason, /no product source change/);
  assert.equal(f.g('-C', worktree, 'log', '-1', '--format=%s'), 'fix(annie): harness repair for incident dddddddddddd');
  assert.deepEqual(f.g('-C', worktree, 'diff', '--name-only', f.base, 'HEAD').split('\n'), ['tools/maintainer/x.mjs']);
  const events = (await readFile(join(f.state, 'runs', run.day, 'gate-events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => [event.name, event.exitCode]), ['harness-scope', 'harness-whitespace', 'harness-npm-ci', 'harness-test', 'harness-shell', 'harness-yaml', 'harness-actionlint'].map(name => [name, 0]));
  assert.match(await readFile(join(f.dir, 'go-calls'), 'utf8'), /run github\.com\/rhysd\/actionlint\/cmd\/actionlint@v1\.7\.12 .*\.github\/workflows\/honest-annie\.yml/);
  // Export: the bundle leaves only through the harness lane, never as a release candidate.
  const result = join(f.dir, 'result.json'), artifact = join(f.dir, 'artifact'), output = join(f.dir, 'output');
  await writeFile(result, JSON.stringify(reportFor(run)));
  const env = { ...process.env, GITHUB_ACTIONS: 'false', PUFFER_MAINT_TASK: JSON.stringify(f.task), PUFFER_MAINT_SOURCE: f.source, PUFFER_MAINT_STATE: f.state, PUFFER_MAINT_RESULT: result, HONEST_ANNIE_ARTIFACT: artifact, GITHUB_OUTPUT: output, GITHUB_SHA: f.base, PUFFER_MAINT_RUNROOT: f.runroot };
  const exported = spawnSync('bash', [join(moduleDir, 'ci.sh'), 'export'], { env, encoding: 'utf8' });
  assert.equal(exported.status, 0, exported.stderr);
  assert.equal(await readFile(output, 'utf8'), 'candidate=false\nsourcecandidate=false\nmanagement=false\nharness=true\n');
  const report = JSON.parse(await readFile(join(artifact, 'result.json'), 'utf8'));
  assert.equal(report.taskKind, 'harness'); assert.equal(report.incident, INCIDENT); assert.equal(report.publicationState, 'not-applicable'); assert.match(report.diagnosis, /undefined helper/);
  for (const command of ['push', 'publish', 'management']) { const refused = spawnSync('bash', [join(moduleDir, 'ci.sh'), command], { env, encoding: 'utf8' }); assert.notEqual(refused.status, 0); assert.match(refused.stderr, /never pushed to trunk/); }
  // Release side: fresh state imports the bundle into a worktree detached at C and reruns the harness gate against base B.
  const release = { ...env, PUFFER_MAINT_STATE: join(f.dir, 'release-state'), PATH: f.path };
  for (const command of ['import', 'gate']) { const step = spawnSync('bash', [join(moduleDir, 'ci.sh'), command], { env: release, encoding: 'utf8' }); assert.equal(step.status, 0, `${command}: ${step.stderr}`); }
  assert.equal((await readFile(join(release.PUFFER_MAINT_STATE, 'runs', run.day, 'gate.ok'), 'utf8')).trim(), run.tree);
  assert.match(await readFile(join(release.PUFFER_MAINT_STATE, 'runs', run.day, 'logs', 'harness-scope.log'), 'utf8'), /^harness-scope-ok$/m);
});

const NOW = Date.parse('2026-04-03T04:17:00Z');
test('incident detection: effects failure, abandoned, sandbox unavailable, all providers held, observe failure; normal outcomes are not incidents', () => {
  const kinds = found => found.map(entry => entry.kind).sort();
  const failedJob = (runId, name, step) => ({ runId, conclusion: 'failure', jobs: [{ name, conclusion: 'failure', steps: [{ name: 'Checkout', conclusion: 'success' }, { name: step, conclusion: 'failure' }] }] });
  const found = detectIncidents({ now: NOW,
    abandoned: [{ runId: 11, source: null, reason: 'effects-retry-exhausted' }],
    providersHeld: { providers: ['zai', 'minimax'], until: '2026-04-03T09:00:00.000Z' },
    jobs: [failedJob(20, 'Annie effects (model-free)', 'Persist source before registry auth'), failedJob(21, 'observe', 'Rediscover, verify ledger, select useful work'), failedJob(22, 'observe', 'Rediscover, verify ledger, select useful work')],
    reports: [{ runId: 30, taskKind: 'maintenance', report: { sourceChanged: true, sandbox: { status: 'unavailable', reason: 'sandbox probe failed', visual: { status: 'unavailable' } } } }, { runId: 29, taskKind: 'pr', report: { sourceChanged: true, sandbox: { status: 'available' } } }] });
  assert.deepEqual(kinds(found), ['effects-abandoned', 'job-failed', 'job-failed', 'providers-held', 'sandbox-unavailable']);
  const observe = found.find(entry => entry.detail.startsWith('observe'));
  assert.deepEqual(observe.runs, [22, 21]); assert.match(observe.detail, /2 run\(s\)/);
  // Normal: a review rejection or product gate failure ends in the model step; an honest no-op fails nothing; harness/management runs skip the sandbox; one held provider among two is not all held.
  assert.deepEqual(detectIncidents({ now: NOW,
    jobs: [{ runId: 40, conclusion: 'failure', jobs: [{ name: 'maintain', conclusion: 'failure', steps: [{ name: 'Maintain or review selected task', conclusion: 'failure' }, { name: 'Export only approved candidates or valid rejection feedback', conclusion: 'success' }] }, { name: 'Annie harness gate (model-free)', conclusion: 'failure', steps: [{ name: 'Independently rerun the harness gate without credentials', conclusion: 'failure' }] }] }],
    reports: [{ runId: 41, taskKind: 'harness', report: { sourceChanged: true, sandbox: { status: 'unavailable', reason: 'candidate has no product source change to run' } } }, { runId: 42, taskKind: 'maintenance', report: { phase: 'rejected', reason: 'review-rejected', sourceChanged: true, sandbox: { status: 'available' } } }],
    environment: { signal: 'a'.repeat(64), nextAt: NOW - 1 } }), []);
  // Identity ignores volatile numbers: the same failure in later runs keeps its fingerprint.
  assert.equal(detectIncidents({ now: NOW, jobs: [failedJob(99, 'observe', 'Rediscover, verify ledger, select useful work')] })[0].fingerprint, observe.fingerprint);
});

test('incident fingerprints dedupe across observes, need two observations, clear, recur, and validate strictly', () => {
  const found = detectIncidents({ now: NOW, abandoned: [{ runId: 11, reason: 'candidate-expired' }] });
  let state = foldIncidents([], found, NOW); assert.equal(state[0].count, 1); assert.equal(ready(state[0]), false);
  state = foldIncidents(state, found, NOW + 1800e3); assert.equal(state.length, 1); assert.equal(state[0].count, 2); assert.equal(state[0].firstSeen, NOW); assert.equal(ready(state[0]), true);
  state = foldIncidents(state, [], NOW + 3600e3); assert.equal(state[0].status, 'cleared'); assert.equal(state[0].lastSeen, NOW + 1800e3);
  state = foldIncidents(state, found, NOW + 5400e3); assert.deepEqual([state[0].status, state[0].count, state[0].firstSeen, state[0].since], ['open', 1, NOW, NOW + 5400e3]);
  assert.deepEqual(foldIncidents(foldIncidents(state, [], NOW + 6000e3), [], NOW + 8 * 86400e3), []);
  validateIncidents(state);
  for (const bad of [{ ...state[0], extra: 1 }, { ...state[0], kind: 'other' }, { ...state[0], detail: 'x\ny' }, { ...state[0], runs: [1, 2, 3, 4, 5, 6] }, { ...state[0], since: state[0].lastSeen + 1 }, { ...state[0], count: 0 }]) assert.throws(() => validateIncidents([bad]), /malformed incidents/);
  assert.throws(() => validateIncidents(Array.from({ length: 21 }, (_, i) => ({ ...state[0], fingerprint: String(i % 10).repeat(64) }))));
});

// In-memory GitHub for issue and PR effects; mutations are recorded, a configured status fails PR creation.
function fakeGitHub({ prStatus = 201, issues = [] } = {}) {
  const state = { issues, comments: new Map(), labels: new Set(), prs: [], calls: [] };
  const json = (body, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status });
  const fetchImpl = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url), method = init.method ?? 'GET', body = init.body ? JSON.parse(init.body) : null, path = pathname.replace('/repos/bugabinga/pufferpanel', '');
    state.calls.push(`${method} ${path}`);
    if (path === '' ) return json({ id: 7, has_issues: true });
    if (path === '/issues' && method === 'GET') return json(state.issues.filter(issue => issue.labels.includes(searchParams.get('labels'))).map(issue => ({ ...issue })));
    if (path === '/issues' && method === 'POST') { const issue = { number: state.issues.length + 1, state: 'open', closed_at: null, user: { login: 'github-actions[bot]' }, ...body }; state.issues.push(issue); return json(issue, 201); }
    const one = path.match(/^\/issues\/(\d+)(\/comments)?$/);
    if (one && !one[2] && method === 'PATCH') { const issue = state.issues.find(item => item.number === Number(one[1])); Object.assign(issue, body, body.state === 'closed' ? { closed_at: new Date(NOW + 7200e3).toISOString() } : body.state === 'open' ? { closed_at: null } : {}); return json(issue); }
    if (one?.[2]) { const list = state.comments.get(Number(one[1])) ?? []; if (method === 'POST') { list.push({ ...body, user: { login: 'github-actions[bot]' } }); state.comments.set(Number(one[1]), list); return json(body, 201); } return json(list); }
    if (path === '/labels/annie-incident') return state.labels.has('annie-incident') ? json({}) : json({}, 404);
    if (path === '/labels') { state.labels.add(body.name); return json(body, 201); }
    if (path === '/pulls' && method === 'GET') return json(state.prs.filter(pr => (!searchParams.get('head') || `bugabinga:${pr.head.ref}` === searchParams.get('head')) && (searchParams.get('state') === 'all' || pr.state === 'open')));
    if (path === '/pulls' && method === 'POST') { if (prStatus !== 201) return json({ message: 'Resource not accessible by personal access token' }, prStatus); const pr = { ...body, number: 100 + state.prs.length, state: 'open', head: { ref: body.head } }; state.prs.push(pr); return json(pr, 201); }
    throw Error('unexpected fake GitHub request ' + method + ' ' + path);
  };
  return { state, api: new GitHub('native-sentinel', fetchImpl, []), pat: new GitHub('pat-sentinel', fetchImpl, []) };
}

test('incident issues: create with label and marker, update, respect a maintainer close, reopen on recurrence, close once cleared, all idempotent', async () => {
  const gh = fakeGitHub(), found = detectIncidents({ now: NOW, abandoned: [{ runId: 11, reason: 'candidate-expired' }] });
  let state = foldIncidents(foldIncidents([], found, NOW), found, NOW + 1800e3);
  assert.deepEqual((await syncIncidents(gh.api, foldIncidents([], found, NOW))), []); // One observation is not yet an incident report.
  let receipts = await syncIncidents(gh.api, state);
  assert.deepEqual(receipts.map(r => [r.kind, r.status, r.reason, r.number]), [['incident-issue', 'applied', 'created', 1]]);
  assert.deepEqual(gh.state.issues[0].labels, ['annie-incident']); assert.ok(gh.state.labels.has('annie-incident'));
  assert.ok(gh.state.issues[0].body.includes(`<!-- annie-incident:${state[0].fingerprint} -->`)); assert.doesNotMatch(gh.state.issues[0].body, /native-sentinel/);
  assert.equal((await syncIncidents(gh.api, state))[0].reason, 'unchanged');
  state = foldIncidents(state, found, NOW + 3600e3); assert.equal((await syncIncidents(gh.api, state))[0].reason, 'updated'); assert.equal(gh.state.issues.length, 1);
  // A foreign issue carrying the marker is ignored rather than hijacking the incident.
  gh.state.issues.push({ number: 2, state: 'open', labels: ['annie-incident'], user: { login: 'mallory' }, body: incidentBody(state[0]) });
  assert.equal((await syncIncidents(gh.api, state))[0].number, 1);
  // Oliver closes it during the streak: respected, never reopened while it continues.
  Object.assign(gh.state.issues[0], { state: 'closed', closed_at: new Date(NOW + 4000e3).toISOString() });
  assert.equal((await syncIncidents(gh.api, foldIncidents(state, found, NOW + 5400e3)))[0].reason, 'closed-by-maintainer');
  Object.assign(gh.state.issues[0], { state: 'open', closed_at: null });
  const cleared = foldIncidents(state, [], NOW + 7200e3);
  receipts = await syncIncidents(gh.api, cleared); assert.deepEqual(receipts.map(r => [r.kind, r.status, r.reason]), [['incident-close', 'applied', 'closed']]);
  assert.equal(gh.state.issues[0].state, 'closed'); assert.match(gh.state.comments.get(1).at(-1).body, /cleared/);
  assert.equal((await syncIncidents(gh.api, cleared))[0].reason, 'already-closed'); assert.equal(gh.state.comments.get(1).length, 1);
  const recurred = foldIncidents(foldIncidents(cleared, found, NOW + 9000e3), found, NOW + 10800e3);
  assert.equal((await syncIncidents(gh.api, recurred))[0].reason, 'reopened'); assert.equal(gh.state.issues[0].state, 'open'); assert.match(gh.state.comments.get(1).at(-1).body, /recurred/);
  await assert.rejects(syncIncidents(new GitHub('x', async () => new Response(JSON.stringify({ has_issues: false })), []), state), /issues enabled/);
});

test('harness task schema, own fingerprint, and the $5 lease cap', () => {
  const task = { kind: 'harness', day: '2026-04-03', repo: 'bugabinga/pufferpanel', ref: 'refs/heads/trunk', base: 'a'.repeat(40), upstreamSha: 'b'.repeat(40), upstreamRef: 'refs/heads/trunk', fingerprint: 'e'.repeat(64), incident: INCIDENT };
  assert.equal(validateTask(task).incident, INCIDENT);
  for (const bad of [{ incident: undefined }, { incident: 'x' }, { number: 1 }]) assert.throws(() => validateTask({ ...task, ...bad }));
  assert.throws(() => validateTask({ ...task, kind: 'maintenance' }), /harness incident/);
  const run = { id: 42, run_attempt: 1, head_sha: 'a'.repeat(40), event: 'schedule', created_at: new Date(NOW).toISOString() };
  assert.throws(() => makeLease({ run, repoId: 7, workflowId: 8, task, cap: HARNESS_CAP + 1, now: NOW }), /allowance/);
  const lease = makeLease({ run, repoId: 7, workflowId: 8, task, cap: HARNESS_CAP, now: NOW });
  const env = { GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'a'.repeat(40), GITHUB_REPOSITORY_ID: '7' };
  assert.equal(verifyLease(lease, { env, task }).cap, 5);
  const { hash, ...body } = { ...lease, cap: 6 }; assert.throws(() => verifyLease({ ...body, hash: sha256(body) }, { env, task }), /binding/);
  assert.throws(() => parseDigest(JSON.stringify({ incident: 'f'.repeat(64), kind: 'job-failed' }), task), /differs/);
  assert.throws(() => parseDigest('x'.repeat(70_000), task), /oversized/);
});

test('checkPR refuses annie/harness branches and protected-path PRs explicitly', async () => {
  const task = validateTask({ kind: 'pr', day: '2026-04-03', repo: 'bugabinga/pufferpanel', ref: 'refs/heads/trunk', base: 'a'.repeat(40), upstreamSha: 'a'.repeat(40), upstreamRef: 'refs/heads/trunk', number: 7, head: 'c'.repeat(40), author: 'bugabinga', fingerprint: 'f'.repeat(64) });
  const pr = ref => ({ number: 7, state: 'open', draft: false, user: { login: 'bugabinga' }, head: { sha: task.head, ref }, base: { ref: 'trunk', repo: { full_name: 'bugabinga/pufferpanel' } } });
  const fetchFor = (ref, files) => async url => new Response(JSON.stringify(url.includes('/files') ? files : pr(ref)));
  await assert.rejects(checkPR(task, { fetchImpl: fetchFor('annie/harness/abcdef012345', []) }), /harness repair branch/);
  await assert.rejects(checkPR(task, { fetchImpl: fetchFor(undefined, []) }), /harness repair branch/);
  await assert.rejects(checkPR(task, { fetchImpl: fetchFor('feature', [{ filename: 'tools/maintainer/guard.mjs' }]) }), /trusted harness or CI/);
  await assert.rejects(checkPR(task, { fetchImpl: fetchFor('feature', [{ filename: '.github' }]) }), /trusted harness or CI/);
});

async function deliveryFixture(t, files = { 'tools/maintainer/x.mjs': 'export const fixed = true;\n' }) {
  const f = await harnessRepo(t), origin = join(f.dir, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', origin]); f.g('remote', 'add', 'origin', origin); f.g('push', '-q', 'origin', 'trunk');
  f.g('checkout', '-q', '-b', 'candidate'); for (const [path, content] of Object.entries(files)) await writeFile(join(f.source, path), content); f.g('add', '.'); f.g('commit', '-qm', 'fix(annie): harness repair');
  const commit = f.g('rev-parse', 'HEAD'), tree = f.g('rev-parse', 'HEAD^{tree}'), bundle = join(f.dir, 'candidate.bundle');
  f.g('bundle', 'create', bundle, 'HEAD', `^${f.base}`); f.g('checkout', '-q', 'trunk'); f.g('branch', '-qD', 'candidate');
  const gh = fakeGitHub({ issues: [] });
  const entry = foldIncidents(foldIncidents([], [{ fingerprint: INCIDENT, kind: 'job-failed', detail: 'x', runs: [5, 4] }], NOW), [{ fingerprint: INCIDENT, kind: 'job-failed', detail: 'x', runs: [5, 4] }], NOW + 1)[0];
  await syncIncidents(gh.api, [entry]);
  const run = { taskKind: 'harness', base: f.base, tree, commit, releaseCommit: commit, incident: INCIDENT, diagnosis: 'observe called @someone an undefined helper', findings: ['[advisory] style: nit'] };
  const deliver = (extra = {}, api = gh) => deliverHarness({ source: f.source, bundle, run, task: f.task, gate: 'success', native: api.api, pat: api.pat, hasPat: true, ...extra });
  const branchAt = () => execFileSync('git', ['--git-dir', origin, 'rev-parse', '--verify', '-q', 'refs/heads/annie/harness/eeeeeeeeeeee'], { encoding: 'utf8' }).trim();
  return { f, gh, run, commit, deliver, branchAt, origin };
}
test('delivery pushes the reviewed fix to annie/harness/<fp>, opens a PR for Oliver, comments on the incident, and retries idempotently', async t => {
  const { gh, commit, deliver, branchAt, origin } = await deliveryFixture(t);
  const first = await deliver();
  assert.equal(first.delivered, true); assert.equal(branchAt(), commit);
  assert.equal(execFileSync('git', ['--git-dir', origin, 'rev-parse', 'trunk'], { encoding: 'utf8' }).trim().length, 40);
  assert.notEqual(execFileSync('git', ['--git-dir', origin, 'rev-parse', 'trunk'], { encoding: 'utf8' }).trim(), commit); // Never trunk.
  assert.deepEqual(first.receipts.map(r => [r.kind, r.status]), [['harness-branch', 'applied'], ['harness-pr', 'applied'], ['incident-comment', 'applied']]);
  const pr = gh.state.prs[0]; assert.equal(pr.base, 'trunk'); assert.equal(pr.head.ref, 'annie/harness/eeeeeeeeeeee');
  assert.match(pr.body, /incident #1/); assert.match(pr.body, /undefined helper/); assert.match(pr.body, /@\u200bsomeone/); assert.match(pr.body, /style: nit/); assert.match(pr.body, /tools\/maintainer\/x\.mjs/); assert.doesNotMatch(pr.body, /Closes/);
  assert.match(gh.state.comments.get(1)[0].body, /ready for review: #100/);
  const again = await deliver();
  assert.deepEqual(again.receipts.map(r => [r.kind, r.status, r.reason]), [['harness-branch', 'skipped', 'already-pushed'], ['harness-pr', 'skipped', 'already-open'], ['incident-comment', 'skipped', 'already-applied']]);
  assert.equal(gh.state.prs.length, 1); assert.equal(gh.state.comments.get(1).length, 1);
  Object.assign(gh.state.prs[0], { state: 'closed', merged_at: null });
  assert.match((await deliver()).message, /closed unmerged/);
});
test('delivery without ANNIE_GH_TOKEN pushes nothing and says so on the incident', async t => {
  const { gh, deliver, branchAt } = await deliveryFixture(t);
  const result = await deliver({ hasPat: false });
  assert.equal(result.delivered, false); assert.equal(result.communicated, true); assert.throws(branchAt);
  assert.deepEqual(result.receipts.map(r => [r.kind, r.status]), [['harness-branch', 'failed'], ['incident-comment', 'applied']]);
  assert.match(gh.state.comments.get(1)[0].body, /could not be delivered: ANNIE\\_GH\\_TOKEN missing/);
  const gated = await deliver({ gate: 'failure' }); assert.match(gated.receipts[0].reason, /fresh harness gate failure/); assert.throws(branchAt);
});
test('PR creation 403 after the branch push is reported on the incident, never dropped', async t => {
  const { f, run, commit, branchAt } = await deliveryFixture(t);
  const gh = fakeGitHub({ prStatus: 403 }); const entry = foldIncidents(foldIncidents([], [{ fingerprint: INCIDENT, kind: 'job-failed', detail: 'x', runs: [5, 4] }], NOW), [{ fingerprint: INCIDENT, kind: 'job-failed', detail: 'x', runs: [5, 4] }], NOW + 1)[0];
  await syncIncidents(gh.api, [entry]);
  const result = await deliverHarness({ source: f.source, bundle: join(f.dir, 'candidate.bundle'), run, task: f.task, gate: 'success', native: gh.api, pat: gh.pat, hasPat: true });
  assert.equal(branchAt(), commit); assert.equal(result.delivered, false); assert.equal(result.communicated, true);
  assert.deepEqual(result.receipts.map(r => [r.kind, r.status]), [['harness-branch', 'applied'], ['harness-pr', 'failed'], ['incident-comment', 'applied']]);
  assert.match(result.receipts[1].reason, /http-403.*Pull requests write/);
  assert.match(gh.state.comments.get(1)[0].body, /ready on branch `annie\/harness\/eeeeeeeeeeee` but PR creation failed/);
  // Tampered identity never pushes.
  const tampered = await deliverHarness({ source: f.source, bundle: join(f.dir, 'candidate.bundle'), run: { ...run, tree: f.base }, task: { ...f.task, fingerprint: 'f'.repeat(64) }, gate: 'success', native: gh.api, pat: gh.pat, hasPat: true });
  assert.match(tampered.receipts[0].reason, /identity mismatch/);
});

test('harness gate runner fails closed on failing tests, bad shell, out-of-scope paths, and unparseable or retriggered workflows', async t => {
  for (const [name, change, expected] of [
    ['tests', f => writeFile(join(f.worktree, 'tools/maintainer/package.json'), JSON.stringify({ name: 'fixture', private: true, scripts: { test: 'node -e "process.exit(3)"' } })), 'harness-test'],
    ['shell', f => writeFile(join(f.worktree, 'tools/maintainer/run.sh'), 'if then fi\n'), 'harness-shell'],
    ['yaml', f => writeFile(join(f.worktree, '.github/workflows/honest-annie.yml'), 'jobs: [unclosed\n'), 'harness-scope'],
    ['product', f => writeFile(join(f.worktree, 'README.md'), 'product edit\n'), 'harness-scope'],
    ...SCOPE_CASES.filter(([, , refused]) => refused).map(([label, files]) => [label, f => Promise.all(Object.entries(files).map(([path, content]) => writeFile(join(f.worktree, path), content))), 'harness-scope']),
  ]) await t.test(name, async t => {
    const f = await harnessRepo(t); f.worktree = await ensureWorktree(f.source, f.state);
    await change(f); execFileSync('git', ['-C', f.worktree, 'add', '-A']);
    const runDir = join(f.state, 'runs', 'gate'); await mkdir(runDir, { recursive: true });
    const result = spawnSync('bash', [join(moduleDir, 'harness-gate.sh'), f.worktree, runDir, f.base], { env: { ...process.env, PATH: f.path }, encoding: 'utf8' });
    assert.notEqual(result.status, 0); await assert.rejects(readFile(join(runDir, 'gate.ok')));
    const events = (await readFile(join(runDir, 'gate-events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.at(-1).name, expected); assert.notEqual(events.at(-1).exitCode, 0); assert.ok(events.slice(0, -1).every(event => event.exitCode === 0));
  });
});

test('harness scope rule: frozen on: and top-level keys, add/delete and unparseable refused, key order irrelevant', () => {
  assert.equal(harnessScopeViolation(['tools/maintainer/a.mjs']), null);
  assert.match(harnessScopeViolation([]), /changes nothing/);
  assert.match(harnessScopeViolation(['.github/workflows/honest-annie.yml'], HONEST_ANNIE, null), /add or delete/);
  assert.match(harnessScopeViolation(['.github/workflows/honest-annie.yml'], null, HONEST_ANNIE), /add or delete/);
  assert.match(harnessScopeViolation(['.github/workflows/honest-annie.yml'], HONEST_ANNIE, 'on: [push\n'), /unparseable/);
  assert.match(harnessScopeViolation(['.github/workflows/honest-annie.yml'], HONEST_ANNIE, `${HONEST_ANNIE}on:\n  pull_request:\n`), /unparseable/); // Duplicate key.
  const reordered = HONEST_ANNIE.replace('on:\n  push:\n    branches: [trunk]\n  workflow_dispatch:\n', 'on:\n  workflow_dispatch:\n  push:\n    branches: [trunk]\n');
  assert.equal(harnessScopeViolation(['.github/workflows/honest-annie.yml'], HONEST_ANNIE, reordered), null);
  assert.match(harnessScopeViolation(['.github/workflows/honest-annie.yml'], HONEST_ANNIE, HONEST_ANNIE.replace('[trunk]', '[trunk, annie/harness/x]')), /on: triggers/);
});

// The same rule at every layer that sees a candidate: maintain snapshot (b), harness gate (c, runner test above),
// CI import verifyCandidate (d), and delivery before any PAT use (e); the guard (a) is covered above.
for (const [label, files, refused] of SCOPE_CASES) test(`harness scope at maintain, import, and delivery layers: ${label} ${refused ? 'refused' : 'allowed'}`, async t => {
  const { f, run, commit, deliver, branchAt } = await deliveryFixture(t, files);
  const worktree = await ensureWorktree(f.source, f.state);
  for (const [path, content] of Object.entries(files)) await writeFile(join(worktree, path), content);
  const maintained = await snapshot(worktree, true);
  assert.equal(maintained.protected, Boolean(refused)); if (refused) assert.match(maintained.scope, refused);
  const imported = join(f.dir, 'imported'); f.g('worktree', 'add', '-q', '--detach', imported, commit);
  const scoped = await harnessScope(f.source, f.base, commit); if (refused) assert.match(scoped, refused); else assert.equal(scoped, null);
  if (refused) await assert.rejects(verifyCandidate(imported, { ...run, expectedParents: [f.base] }, f.task), refused);
  else await verifyCandidate(imported, { ...run, expectedParents: [f.base] }, f.task);
  const result = await deliver();
  if (!refused) { assert.equal(result.delivered, true); assert.equal(branchAt(), commit); return; }
  assert.equal(result.delivered, false); assert.throws(branchAt);
  assert.equal(result.receipts[0].kind, 'harness-branch'); assert.match(result.receipts[0].reason, refused);
});

test('repair decisions: never while running or awaiting a PR; retry only after closed-unmerged, merged with later evidence, or no PR after policy change or 24h; at most three attempts', () => {
  const DAY = 86_400e3, P = 'a'.repeat(64), Q = 'b'.repeat(64), T = n => String(n).repeat(64);
  const entry = (repair, extra = {}) => ({ fingerprint: INCIDENT, kind: 'job-failed', status: 'open', since: NOW, ...(repair ? { repair } : {}), ...extra });
  const one = { tasks: [T(1)], last: T(1), runId: 44, at: NOW, policy: P };
  const decide = (e, last, extra = {}) => repairDecision({ entry: e, last, policy: P, now: NOW + 1000, ...extra });
  assert.deepEqual(decide(entry(null), null), { admit: true, attempt: 1, reason: 'first' });
  assert.equal(decide(entry(null), null, { running: true }).reason, 'in-flight');
  // The live bug: an open PR blocks, whatever the policy says.
  assert.deepEqual(decide(entry(one, { pr: 2 }), null, { policy: Q }), { admit: false, reason: 'awaiting-review', pr: 2 });
  assert.deepEqual(decide(entry(one), { state: 'open', number: 2 }, { policy: Q }), { admit: false, reason: 'awaiting-review', pr: 2 });
  assert.deepEqual(decide(entry(one), { state: 'closed', number: 2 }), { admit: true, attempt: 2, reason: 'closed-unmerged' });
  assert.equal(decide(entry(one), { state: 'merged', number: 2, at: NOW + 500 }, { evidenceAt: NOW }).reason, 'merged-awaiting-evidence');
  assert.equal(decide(entry(one), { state: 'merged', number: 2, at: NOW + 500 }, { policy: Q }).reason, 'merged-awaiting-evidence');
  assert.equal(decide(entry(one), { state: 'merged', number: 2, at: NOW + 500 }, { evidenceAt: NOW + 900 }).reason, 'persists-after-merge');
  assert.equal(decide(entry(one, { since: NOW + 800 }), { state: 'merged', number: 2, at: NOW + 500 }).reason, 'persists-after-merge');
  assert.equal(decide(entry(one), { state: 'none' }).reason, 'no-pr-backoff');
  assert.equal(decide(entry(one), { state: 'none' }, { policy: Q }).reason, 'retry-without-pr');
  assert.equal(decide(entry(one), { state: 'none' }, { now: NOW + DAY }).reason, 'retry-without-pr');
  assert.equal(decide(entry({ ...one, policy: null }), { state: 'none' }, { policy: Q }).reason, 'no-pr-backoff'); // Unknown admission policy waits 24h.
  const full = { tasks: [T(1), T(2), T(3)], last: T(3), runId: 50, at: NOW, policy: P };
  assert.equal(MAX_REPAIRS, 3); assert.equal(decide(entry(full), { state: 'closed', number: 7 }).reason, 'attempts-exhausted');
});

test('repair memory folds ledger attempts and open harness PRs are attributed by marker or known branch, never from forks', () => {
  const T = n => String(n).repeat(64), mine = { tasks: [T(1)], last: T(1), runId: 44, at: NOW, policy: 'a'.repeat(64) };
  assert.deepEqual(foldRepair(null, [{ task: T(1), runId: 44, at: NOW }, { task: T(2), runId: 46, at: NOW + 5 }]), { tasks: [T(1), T(2)], last: T(2), runId: 46, at: NOW + 5, policy: null });
  assert.deepEqual(foldRepair(mine, [{ task: T(1), runId: 44, at: NOW }]), mine);
  assert.equal(foldRepair(mine, [{ task: T(2), runId: 46, at: NOW + 5 }]).last, T(2));
  const pr = (number, ref, body = '', repo = 'bugabinga/pufferpanel') => ({ number, head: { ref, repo: { full_name: repo } }, body });
  const known = new Map([['annie/harness/111111111111', INCIDENT]]);
  const { open, unknown } = openRepairs([pr(2, 'annie/harness/111111111111'), pr(3, 'annie/harness/222222222222', harnessIncidentMarker('e'.repeat(64))), pr(4, 'feature'), pr(5, 'annie/harness/333333333333', '', 'mallory/pufferpanel'), pr(6, 'annie/harness/444444444444')], known);
  assert.deepEqual([...open], [[INCIDENT, 2], ['e'.repeat(64), 3]]); assert.deepEqual(unknown, [6]);
  const valid = { fingerprint: INCIDENT, kind: 'job-failed', detail: 'x', runs: [1], firstSeen: 1, since: 1, lastSeen: 1, count: 2, status: 'open' };
  validateIncidents([{ ...valid, pr: 2, repair: mine }]);
  for (const bad of [{ pr: 0 }, { repair: { ...mine, last: T(9) } }, { repair: { ...mine, tasks: [] } }, { repair: { ...mine, policy: 'x' } }, { other: 1 }]) assert.throws(() => validateIncidents([{ ...valid, ...bad }]), /malformed incidents/);
});

test('incident issue says awaiting review/merge of #N exactly once per PR', async () => {
  const gh = fakeGitHub(), found = detectIncidents({ now: NOW, abandoned: [{ runId: 11, reason: 'candidate-expired' }] });
  const state = foldIncidents(foldIncidents([], found, NOW), found, NOW + 1800e3).map(entry => ({ ...entry, pr: 2 }));
  let receipts = await syncIncidents(gh.api, state);
  assert.deepEqual(receipts.map(r => [r.kind, r.status, r.reason]), [['incident-issue', 'applied', 'created'], ['incident-awaiting', 'applied', 'awaiting #2']]);
  receipts = await syncIncidents(gh.api, state); assert.deepEqual(receipts.at(-1).reason, 'already-applied');
  assert.equal(gh.state.comments.get(1).length, 1); assert.match(gh.state.comments.get(1)[0].body, /Awaiting review\/merge of #2/);
  await syncIncidents(gh.api, state.map(entry => ({ ...entry, pr: 5 }))); assert.equal(gh.state.comments.get(1).length, 2);
  await syncIncidents(gh.api, state.map(({ pr, ...entry }) => entry)); assert.equal(gh.state.comments.get(1).length, 2);
});

test('a second delivery for an incident with an open harness PR comments instead of pushing or opening another', async t => {
  for (const legacy of [false, true]) {
    const { gh, deliver, branchAt } = await deliveryFixture(t);
    // Attempt 1's PR #50 is open: by its body marker, or for an older PR by Annie's delivery comment naming it.
    gh.state.prs.push({ number: 50, state: 'open', head: { ref: 'annie/harness/10fe087581c4' }, body: legacy ? 'older body' : `x\n${harnessIncidentMarker(INCIDENT)}` });
    if (legacy) gh.state.comments.set(1, [{ body: 'Harness fix ready for review: #50 from `annie/harness/10fe087581c4`.\n<!-- annie-delivery:abc -->', user: { login: 'github-actions[bot]' } }]);
    const result = await deliver();
    assert.equal(result.delivered, false); assert.equal(result.communicated, true); assert.throws(branchAt);
    assert.equal(gh.state.prs.length, 1);
    assert.deepEqual(result.receipts.map(r => [r.kind, r.status, r.reason]), [['harness-pr', 'skipped', 'awaiting-earlier-pr'], ['incident-comment', 'applied', null]]);
    assert.match(gh.state.comments.get(1).at(-1).body, /not delivered: #50 for this incident still awaits review\/merge/);
    assert.equal((await deliver()).receipts.at(-1).reason, 'already-applied');
    // Annie's own not-delivered comments never become attribution evidence, and a PR marked for another incident never blocks.
    gh.state.prs[0].body = harnessIncidentMarker('e'.repeat(64));
    assert.equal((await deliver()).delivered, true);
  }
});

test('PR files screen fails closed on a full page or a continuation instead of screening only page one', async () => {
  const task = validateTask({ kind: 'pr', day: '2026-04-03', repo: 'bugabinga/pufferpanel', ref: 'refs/heads/trunk', base: 'a'.repeat(40), upstreamSha: 'a'.repeat(40), upstreamRef: 'refs/heads/trunk', number: 7, head: 'c'.repeat(40), author: 'bugabinga', fingerprint: 'f'.repeat(64) });
  const pr = { number: 7, state: 'open', draft: false, user: { login: 'bugabinga' }, head: { sha: task.head, ref: 'feature' }, base: { ref: 'trunk', repo: { full_name: 'bugabinga/pufferpanel' } } };
  const files = count => Array.from({ length: count }, (_, i) => ({ filename: `docs/${i}.md` }));
  const fetchFor = (list, link = '') => async url => new Response(JSON.stringify(url.includes('/files') ? list : pr), { headers: url.includes('/files') && link ? { link } : {} });
  await assert.rejects(checkPR(task, { fetchImpl: fetchFor(files(100)) }), /too large to screen/);
  await assert.rejects(checkPR(task, { fetchImpl: fetchFor(files(3), '<https://api.github.com/x?page=2>; rel="next"') }), /pagination truncated/);
  // 99 clean files pass the screen and reach the next check (author trust), which this fake does not answer.
  await assert.rejects(checkPR(task, { fetchImpl: fetchFor(files(99)) }), error => !/too large|truncated|trusted harness/.test(error.message));
});
