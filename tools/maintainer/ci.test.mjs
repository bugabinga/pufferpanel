import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';
import { resolveModelScopeWithDiagnostics } from '@earendil-works/pi-coding-agent';
import { createRuntime, piModelResolver, selectModels, snapshot } from './maintain.mjs';
import { pinnedRunroot } from './fake-podman.mjs';
import { providerEnvNames } from './report.mjs';

const moduleDir = new URL('.', import.meta.url).pathname;
function fixture(t, protectedEdit = false) {
  const dir = mkdtempSync(join(tmpdir(), 'honest-annie-ci-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'source'), state = join(dir, 'model-state'), artifact = join(dir, 'artifact'), origin = join(dir, 'origin.git');
  mkdirSync(source); mkdirSync(artifact);
  const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'trunk'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(source, 'value.txt'), 'before'); git('add', '.'); git('commit', '-qm', 'initial');
  const base = git('rev-parse', 'HEAD');
  execFileSync('git', ['init', '-q', '--bare', origin]); git('remote', 'add', 'origin', origin); git('push', '-q', 'origin', 'trunk');
  git('worktree', 'add', '-q', '-b', 'pi-maintenance', join(state, 'worktree'));
  const worktree = join(state, 'worktree');
  writeFileSync(join(worktree, 'value.txt'), 'after');
  if (protectedEdit) { mkdirSync(join(worktree, '.github')); writeFileSync(join(worktree, '.github', 'bad.yml'), 'unsafe'); }
  execFileSync('git', ['-C', worktree, 'add', '.']); execFileSync('git', ['-C', worktree, 'commit', '-qm', 'maintenance: 2026-04-03']);
  const commit = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const tree = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
  const run = join(state, 'runs/2026-04-03'); mkdirSync(run, { recursive: true }); writeFileSync(join(run, 'gate.ok'), tree + '\n');
  const result = join(dir, 'result.json'), output = join(dir, 'output');
  writeFileSync(result, JSON.stringify({ phase: 'publishing', day: '2026-04-03', version: '2026.4.3', base, tree, commit, sandbox: { status: 'limited', reason: 'cgroup limits not delegated', podmanVersion: '4.9.3', runCalls: 1, runSeconds: 3.2, output: 'private', visual: { status: 'available', reason: null, browser: 'Chromium 156.0.8078.79 Alpine Linux', snapshotCalls: 2, screenshot: 'private' } } }));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'podman'), '#!/usr/bin/env bash\nexit 0\n'); chmodSync(join(bin, 'podman'), 0o755);
  const env = { ...process.env, GITHUB_ACTIONS: 'false', PATH: `${bin}:${process.env.PATH}`, PUFFER_MAINT_SOURCE: source, PUFFER_MAINT_STATE: state, HONEST_ANNIE_ARTIFACT: artifact, PUFFER_MAINT_RESULT: result, GITHUB_SHA: base, GITHUB_OUTPUT: output, PUFFER_MAINT_RUNROOT: pinnedRunroot(t) };
  const command = (action, extra = {}) => spawnSync('bash', [join(moduleDir, 'ci.sh'), action], { env: { ...env, ...extra }, encoding: 'utf8' });
  const imported = { PUFFER_MAINT_STATE: join(dir, 'release-state') };
  return { dir, source, state, artifact, base, commit, tree, result, output, git, command, imported, origin };
}

// Hide ambient provider credentials and companions so selection sees exactly the fixture's values.
function providerEnv(t) {
  const saved = Object.fromEntries(providerEnvNames().filter(name => name in process.env).map(name => [name, process.env[name]]));
  const set = vars => { for (const name of providerEnvNames()) delete process.env[name]; Object.assign(process.env, vars); };
  set({}); t.after(() => set(saved));
  return set;
}
test('Pi default model table comes from the pinned resolver behind the public scope API and covers only built-in providers', () => {
  assert.equal(piModelResolver.resolveModelScopeWithDiagnostics, resolveModelScopeWithDiagnostics);
  assert.equal(typeof piModelResolver.findInitialModel, 'function');
  const providers = getBuiltinProviders(), table = Object.entries(piModelResolver.defaultModelPerProvider);
  assert.ok(table.length > 0); for (const [provider, id] of table) assert.ok(providers.includes(provider) && typeof id === 'string' && id, provider);
});
test('selection takes each credentialed provider\'s cheapest image-capable catalog model ahead of its stale Pi default, prefers an independent reviewer, and fails closed', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'honest-annie-model-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const set = providerEnv(t), table = piModelResolver.defaultModelPerProvider, settings = JSON.parse(readFileSync(join(moduleDir, 'ci-settings.json')));
  const select = async (vars, extra = {}, held) => { set(vars); return selectModels({ ...settings, ...extra }, await createRuntime(dir), held); };
  // Pi's own first choice for the same credentials, as an interactive session without settings would start.
  const piFirst = async vars => { set(vars); const runtime = await createRuntime(dir); await runtime.getAvailable(); const { model } = await piModelResolver.findInitialModel({ scopedModels: [], isContinuing: false, modelRuntime: runtime }); return { provider: model.provider, modelId: model.id }; };
  assert.deepEqual(settings, {});
  await assert.rejects(select({}), /no configured model available/);
  // The pinned catalog's cheapest image-capable model per provider; a pi-ai dependency bump can change these ids deliberately.
  for (const [vars, provider, id] of [[{ ZAI_API_KEY: 'zai-only' }, 'zai', 'glm-5.3-flash'], [{ MINIMAX_API_KEY: 'minimax-only' }, 'minimax', 'MiniMax-M3.1-Flash'], [{ DEEPSEEK_API_KEY: 'deepseek-only' }, 'deepseek', 'deepseek-flash']]) {
    const choices = await select(vars);
    assert.deepEqual(choices.executor, { provider, modelId: id, thinkingLevel: 'high' }); assert.deepEqual(choices.reviewer, choices.executor);
    // Pi's own interactive default for the same credentials stays the stale table entry, not the catalog tier.
    assert.deepEqual(await piFirst(vars), { provider, modelId: table[provider] });
  }
  const both = { ZAI_API_KEY: 'zai', MINIMAX_API_KEY: 'minimax' };
  let choices = await select(both);
  assert.deepEqual(choices.executor, { provider: 'zai', modelId: 'glm-5.3-flash', thinkingLevel: 'high' }); assert.deepEqual(choices.reviewer, { provider: 'minimax', modelId: 'MiniMax-M3.1-Flash', thinkingLevel: 'high' });
  // Regression: the reviewer used to fall to the deprecated, text-only Pi default MiniMax-M2.7, so visual review lost screenshots.
  const runtime = await createRuntime(dir);
  for (const choice of [choices.executor, choices.reviewer]) assert.ok(runtime.getModel(choice.provider, choice.modelId)?.input?.includes('image'));
  // The stale Pi defaults stay as fallbacks after each provider's catalog tier.
  assert.deepEqual(choices.available.map(choice => `${choice.provider}/${choice.modelId}`), ['zai/glm-5.3-flash', `zai/${table.zai}`, 'minimax/MiniMax-M3.1-Flash', `minimax/${table.minimax}`]);
  // A Pi enabledModels preference (glob, thinking suffix) leads; the catalog tier and Pi defaults follow as fallbacks.
  choices = await select(both, { enabledModels: ['minimax/*M3:medium'] });
  assert.deepEqual(choices.available.map(choice => `${choice.provider}/${choice.modelId}:${choice.thinkingLevel}`), ['minimax/MiniMax-M3:medium', 'zai/glm-5.3-flash:high', `zai/${table.zai}:high`, 'minimax/MiniMax-M3.1-Flash:high', `minimax/${table.minimax}:high`]);
  assert.equal(choices.reviewer.provider, 'zai');
  choices = await select(both, {}, new Set(['zai']));
  assert.deepEqual(choices.available.map(choice => choice.provider), ['minimax', 'minimax']); assert.deepEqual(choices.providers, ['zai', 'minimax']);
  await assert.rejects(select(both, {}, new Set(['zai', 'minimax'])), /held providers/);
  // Cloudflare is an ordinary provider: unusable without its account companion, a coding candidate with it.
  await assert.rejects(select({ CLOUDFLARE_API_KEY: 'cf' }), /no configured model available/);
  choices = await select({ CLOUDFLARE_API_KEY: 'cf', CLOUDFLARE_ACCOUNT_ID: 'acct' });
  assert.equal(choices.executor.provider, 'cloudflare-workers-ai');
  assert.ok(choices.available.some(choice => choice.modelId === table['cloudflare-workers-ai']));
});
test('CI initialization confines runtime paths to runner temp and prepare sets bot identity', t => {
  const f = fixture(t); const envFile = join(f.dir, 'github-env'), agent = join(f.dir, 'agent');
  let result = f.command('init', { RUNNER_TEMP: f.dir, GITHUB_WORKSPACE: f.source, GITHUB_ENV: envFile });
  assert.equal(result.status, 0, result.stderr);
  const paths = Object.fromEntries(readFileSync(envFile, 'utf8').trim().split('\n').map(line => line.split('=')));
  assert.equal(paths.PUFFER_MAINT_SOURCE, f.source); assert.equal(paths.TMPDIR, f.dir);
  assert.equal(paths.PUFFER_MAINT_STATE, join(f.dir, 'honest-annie-state'));
  // init allocates its runroot in /tmp when TMPDIR paths exceed 50 bytes; like the workflow's always() step, cleanup removes it.
  const cleaned = f.command('cleanup', paths); assert.equal(cleaned.status, 0, cleaned.stderr); assert.equal(existsSync(paths.PUFFER_MAINT_RUNROOT), false);
  result = f.command('prepare', { PI_CODING_AGENT_DIR: agent }); assert.equal(result.status, 0, result.stderr);
  assert.equal(f.git('config', 'user.name'), 'honest_annie');
  assert.equal(f.git('remote', 'get-url', 'upstream'), 'https://github.com/pufferpanel/pufferpanel.git');
  assert.deepEqual(JSON.parse(readFileSync(join(agent, 'settings.json'))), {});
  assert.equal(existsSync(join(agent, 'auth.json')), false);
});
test('CI allocates a short private runroot and cleanup refuses arbitrary paths', t => {
  const f = fixture(t); const envFile = join(f.dir, 'github-env');
  let result = f.command('init', { RUNNER_TEMP: f.dir, GITHUB_WORKSPACE: f.source, GITHUB_ENV: envFile });
  assert.equal(result.status, 0, result.stderr);
  const paths = Object.fromEntries(readFileSync(envFile, 'utf8').trim().split('\n').map(line => line.split('=')));
  assert.ok(Buffer.byteLength(paths.PUFFER_MAINT_RUNROOT) <= 50);
  assert.equal(statSync(paths.PUFFER_MAINT_RUNROOT).mode & 0o777, 0o700);
  const arbitrary = join(f.dir, 'arbitrary'); mkdirSync(arbitrary, { mode: 0o700 }); chmodSync(arbitrary, 0o700);
  result = f.command('cleanup', { PUFFER_MAINT_RUNROOT: arbitrary, PUFFER_MAINT_RUNROOT_PREFIX: `${f.dir}/pufferpanel-podman.` });
  assert.equal(result.status, 64); assert.equal(existsSync(arbitrary), true);
  result = f.command('cleanup', paths); assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(paths.PUFFER_MAINT_RUNROOT), false);
});
test('CI preflight rejects invalid explicit runroot before Podman', t => {
  const f = fixture(t); const calls = join(f.dir, 'podman-calls');
  writeFileSync(join(f.dir, 'bin', 'podman'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >>${JSON.stringify(calls)}\n`); chmodSync(join(f.dir, 'bin', 'podman'), 0o755);
  const long = '/' + 'x'.repeat(51);
  const result = f.command('preflight', { PUFFER_MAINT_RUNROOT: long });
  assert.equal(result.status, 64); assert.equal(existsSync(calls), false);
});
test('workflow confines secrets and paid jobs to trusted trunk; actions use full SHA pins', () => {
  const workflow = readFileSync(join(moduleDir, '../../.github/workflows/honest-annie.yml'), 'utf8');
  const check = workflow.slice(workflow.indexOf('  check:'), workflow.indexOf('  maintain:'));
  const maintain = workflow.slice(workflow.indexOf('  maintain:'), workflow.indexOf('  release:'));
  const release = workflow.slice(workflow.indexOf('  release:'), workflow.indexOf('  retry-effects:'));
  assert.doesNotMatch(check, /secrets\.|contents: write/);
  assert.match(maintain, /github\.repository == 'bugabinga\/pufferpanel'/); assert.match(maintain, /github\.ref == 'refs\/heads\/trunk'/);
  assert.match(maintain, /vars\.HONEST_ANNIE_ENABLED == 'true'/); assert.doesNotMatch(workflow, /toJSON\(secrets\)|ANNIE_MODEL_SECRETS|(?<![A-Z_])GITHUB_TOKEN: \$\{\{ secrets/);
  // GitHub flags whole-secrets dumps as malicious: each model step names every pi-ai provider env name explicitly, nothing else.
  // A pi upgrade that adds a provider fails here until `node report.mjs provider-env` regenerates the three blocks.
  const parsed = YAML.parse(workflow), modelSteps = parsed.jobs.maintain.steps.filter(step => Object.values(step.env ?? {}).some(value => /secrets\./.test(value)));
  assert.deepEqual(modelSteps.map(step => step.name), ['Validate at least one configured model provider is available', 'Maintain or review selected task', 'Collect sanitized maintenance report']);
  for (const step of modelSteps) {
    const named = Object.entries(step.env).filter(([name]) => name !== 'GH_TOKEN');
    assert.deepEqual(named.map(([name]) => name).sort(), providerEnvNames(), step.name);
    for (const [name, value] of named) assert.equal(value, `\${{ secrets.${name} }}`);
  }
  assert.equal(parsed.jobs.observe.outputs.holds, '${{ steps.observe.outputs.holds }}'); assert.equal(parsed.jobs.maintain.env.ANNIE_PROVIDER_HOLDS, '${{ needs.observe.outputs.holds }}');
  assert.doesNotMatch(maintain, /REGISTRY_PASSWORD|ANNIE_GH_TOKEN|contents: write|issues: write|pull-requests: write/);
  assert.match(maintain, /GH_TOKEN: \$\{\{ github.token \}\}/); // Native read-only preparation only.
  assert.match(maintain, /github.run_attempt == 1/);
  assert.match(release, /contents: write/); assert.doesNotMatch(release, /ZAI_API_KEY|toJSON\(secrets\)|ANNIE_MODEL_SECRETS/);
  assert.ok(release.indexOf('ci.sh gate') < release.indexOf('secrets.REGISTRY_PASSWORD'));
  for (const [, ref] of workflow.matchAll(/^\s*- uses: ([^\s]+)/gm)) assert.match(ref, /@[a-f0-9]{40}$/);
  // Model-free republish: trusted harness checkout, release environment, read-only token, gates before registry secrets.
  const job = YAML.parse(workflow).jobs.republish, text = workflow.slice(workflow.indexOf('\n  republish:\n'));
  assert.deepEqual(job.needs, ['check', 'observe']); assert.deepEqual(job.permissions, { contents: 'read' }); assert.equal(job.environment, 'honest-annie-release'); assert.equal(job['timeout-minutes'], 90);
  assert.match(job.if, /github\.repository == 'bugabinga\/pufferpanel'/); assert.match(job.if, /github\.ref == 'refs\/heads\/trunk'/); assert.match(job.if, /vars\.HONEST_ANNIE_ENABLED == 'true'/); assert.match(job.if, /needs\.observe\.outputs\.republish != ''/);
  assert.deepEqual(job.steps[0].with, { ref: '${{ github.sha }}', 'fetch-depth': 0, 'persist-credentials': false });
  assert.doesNotMatch(text, /ZAI_API_KEY|toJSON\(secrets\)|ANNIE_MODEL_SECRETS|ANNIE_GH_TOKEN|: write|needs\.observe\.outputs\.task|download-artifact/);
  assert.ok(text.indexOf('republish.mjs verify') < text.indexOf('republish.mjs gate') && text.indexOf('republish.mjs gate') < text.indexOf('secrets.REGISTRY_PASSWORD') && text.indexOf('secrets.REGISTRY_PASSWORD') < text.indexOf('republish.mjs publish'));
  assert.equal(job.steps.find(step => step.uses?.startsWith('actions/upload-artifact@')).with.name, 'honest-annie-republish-report-${{ github.run_id }}-${{ github.run_attempt }}');
  assert.equal(job.steps.at(-1).run, 'bash tools/maintainer/ci.sh cleanup'); assert.equal(job.steps.at(-1).if, 'always()');
});
test('self-repair jobs: incidents and gate stay secretless, delivery holds the PAT but never runs candidate code or writes contents; wake stays secretless', () => {
  const workflow = readFileSync(join(moduleDir, '../../.github/workflows/honest-annie.yml'), 'utf8'), jobs = YAML.parse(workflow).jobs;
  const secrets = job => JSON.stringify(job).match(/secrets\.[A-Z_]+/g) ?? [];
  assert.deepEqual(jobs.incidents.permissions, { contents: 'read', issues: 'write' }); assert.deepEqual(secrets(jobs.incidents), []); assert.equal(jobs.incidents.environment, undefined);
  assert.match(jobs.incidents.if, /vars\.HONEST_ANNIE_ENABLED == 'true'/); assert.match(jobs.incidents.if, /github\.ref == 'refs\/heads\/trunk'/);
  assert.deepEqual(jobs['harness-gate'].permissions, { contents: 'read' }); assert.deepEqual(secrets(jobs['harness-gate']), []); assert.equal(jobs['harness-gate'].environment, undefined);
  assert.deepEqual(jobs['harness-gate'].steps.filter(step => step.run?.includes('ci.sh')).map(step => step.run), ['bash tools/maintainer/ci.sh init', 'bash tools/maintainer/ci.sh import', 'bash tools/maintainer/ci.sh gate']);
  const deliver = jobs['harness-deliver'];
  assert.equal(deliver.name, 'Annie effects (model-free)'); assert.equal(deliver.environment, 'honest-annie-release'); assert.deepEqual(deliver.needs, ['observe', 'maintain', 'harness-gate']);
  assert.deepEqual(deliver.permissions, { contents: 'read', issues: 'write', 'pull-requests': 'read' }); assert.deepEqual(secrets(deliver), ['secrets.ANNIE_GH_TOKEN']);
  assert.doesNotMatch(JSON.stringify(deliver), /ci\.sh (gate|import|push|publish|registry-login)|npm test|harness-gate\.sh/);
  const step = deliver.steps.find(item => item.env?.ANNIE_GH_TOKEN); assert.equal(step.run, 'bash tools/maintainer/ci.sh deliver'); assert.equal(step.env.ANNIE_HARNESS_GATE, '${{ needs.harness-gate.result }}');
  assert.match(deliver.steps.find(item => item.uses?.startsWith('actions/upload-artifact@')).if, /steps\.collect\.outcome == 'success'/);
  // Harness candidates never reach the trunk release job; the maintain job only forwards the untrusted digest.
  assert.doesNotMatch(jobs.release.if, /harness/); assert.equal(jobs.maintain.env.ANNIE_INCIDENT, '${{ needs.observe.outputs.incident }}');
  assert.match(jobs.check.steps.at(-1).run, /harness-gate\.sh/);
  const wake = YAML.parse(readFileSync(join(moduleDir, '../../.github/workflows/annie-pr-wake.yml'), 'utf8'));
  assert.deepEqual(wake.permissions, {}); assert.deepEqual(secrets(wake), []); assert.ok(Object.values(wake.jobs).every(job => !job.environment && job.steps.every(item => !item.uses)));
});
test('reviewed CI bundle imports exact commit, pushes once, and safely retries', t => {
  const f = fixture(t);
  let result = f.command('export'); assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(f.output, 'utf8'), 'candidate=true\n');
  assert.deepEqual(new Set(['candidate.bundle', 'result.json', 'gate.ok']), new Set(readdirSync(f.artifact)));
  // The allowlisted export carries the sanitized sandbox diagnostic, never extra fields.
  assert.deepEqual(JSON.parse(readFileSync(join(f.artifact, 'result.json'))).sandbox, { status: 'limited', reason: 'cgroup limits not delegated', podmanVersion: '4.9.3', runCalls: 1, runSeconds: 3.2, visual: { status: 'available', reason: null, browser: 'Chromium 156.0.8078.79 Alpine Linux', snapshotCalls: 2 } });
  result = f.command('import', f.imported); assert.equal(result.status, 0, result.stderr);
  const target = join(f.imported.PUFFER_MAINT_STATE, 'worktree');
  assert.equal(readFileSync(join(target, 'value.txt'), 'utf8'), 'after');
  assert.equal(existsSync(join(f.imported.PUFFER_MAINT_STATE, 'runs/2026-04-03/gate.ok')), false);
  result = f.command('push', f.imported); assert.notEqual(result.status, 0); assert.match(result.stderr, /independent release gate required/);
  result = f.command('gate', f.imported); assert.equal(result.status, 0, result.stderr);
  for (let i = 0; i < 2; i++) { result = f.command('push', f.imported); assert.equal(result.status, 0, result.stderr); }
  assert.equal(execFileSync('git', ['--git-dir', f.origin, 'rev-parse', 'trunk'], { encoding: 'utf8' }).trim(), f.commit);
});
test('CI no-op exports no bundle and no release', t => {
  const f = fixture(t); writeFileSync(f.result, JSON.stringify({ phase: 'published', commit: null }));
  const result = f.command('export'); assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(f.output, 'utf8'), 'candidate=false\n'); assert.equal(existsSync(join(f.artifact, 'candidate.bundle')), false);
});
test('CI protects workflow edits before gate and during bundle export', async t => {
  const f = fixture(t, true); const result = f.command('export'); assert.notEqual(result.status, 0); assert.match(result.stderr, /trusted harness or CI/);
  writeFileSync(join(f.state, 'worktree', '.github', 'bad.yml'), 'another edit');
  assert.equal((await snapshot(join(f.state, 'worktree'))).protected, true);
});
test('CI rejects tampered metadata and stale gate receipts before import', t => {
  for (const tamper of ['commit', 'base', 'tree', 'version', 'receipt']) {
    const f = fixture(t); assert.equal(f.command('export').status, 0);
    if (tamper === 'receipt') writeFileSync(join(f.artifact, 'gate.ok'), '0'.repeat(40));
    else { const run = JSON.parse(readFileSync(join(f.artifact, 'result.json'))); run[tamper] = tamper === 'version' ? '2026.4.4' : '0'.repeat(40); writeFileSync(join(f.artifact, 'result.json'), JSON.stringify(run)); }
    const result = f.command('import', f.imported); assert.notEqual(result.status, 0, tamper);
  }
});
test('CI refuses publication after trunk advanced independently', t => {
  const f = fixture(t); assert.equal(f.command('export').status, 0); assert.equal(f.command('import', f.imported).status, 0);
  writeFileSync(join(f.source, 'value.txt'), 'human update'); f.git('add', '.'); f.git('commit', '-qm', 'human change'); f.git('push', '-q', 'origin', 'trunk');
  assert.equal(f.command('gate', f.imported).status, 0);
  const human = f.git('rev-parse', 'HEAD'); const result = f.command('push', f.imported);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /trunk advanced/);
  assert.equal(execFileSync('git', ['--git-dir', f.origin, 'rev-parse', 'trunk'], { encoding: 'utf8' }).trim(), human);
});
