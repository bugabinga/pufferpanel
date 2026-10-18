import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRuntime, selectModels, snapshot } from './maintain.mjs';

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
  writeFileSync(result, JSON.stringify({ phase: 'publishing', day: '2026-04-03', version: '2026.4.3', base, tree, commit }));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'podman'), '#!/usr/bin/env bash\nexit 0\n'); chmodSync(join(bin, 'podman'), 0o755);
  const env = { ...process.env, GITHUB_ACTIONS: 'false', PATH: `${bin}:${process.env.PATH}`, PUFFER_MAINT_SOURCE: source, PUFFER_MAINT_STATE: state, HONEST_ANNIE_ARTIFACT: artifact, PUFFER_MAINT_RESULT: result, GITHUB_SHA: base, GITHUB_OUTPUT: output };
  const command = (action, extra = {}) => spawnSync('bash', [join(moduleDir, 'ci.sh'), action], { env: { ...env, ...extra }, encoding: 'utf8' });
  const imported = { PUFFER_MAINT_STATE: join(dir, 'release-state') };
  return { dir, source, state, artifact, base, commit, tree, result, output, git, command, imported, origin };
}

test('CI selects bundled zai/glm-5.3 with known pricing without model requests', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'honest-annie-model-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const settings = JSON.parse(readFileSync(join(moduleDir, 'ci-settings.json')));
  const runtime = await createRuntime(dir); const choices = selectModels(settings, runtime);
  assert.deepEqual(choices.executor, { provider: 'zai', modelId: 'glm-5.3', thinkingLevel: 'high' });
  assert.deepEqual(choices.reviewer, choices.executor);
  const model = runtime.getModel('zai', 'glm-5.3');
  assert.equal(model.baseUrl, 'https://api.z.ai/api/coding/paas/v4'); assert.ok(model.cost.input > 0); assert.ok(model.cost.output > 0);
});
test('CI initialization confines runtime paths to runner temp and prepare sets bot identity', t => {
  const f = fixture(t); const envFile = join(f.dir, 'github-env'), agent = join(f.dir, 'agent');
  let result = f.command('init', { RUNNER_TEMP: f.dir, GITHUB_WORKSPACE: f.source, GITHUB_ENV: envFile });
  assert.equal(result.status, 0, result.stderr);
  const paths = Object.fromEntries(readFileSync(envFile, 'utf8').trim().split('\n').map(line => line.split('=')));
  assert.equal(paths.PUFFER_MAINT_SOURCE, f.source); assert.equal(paths.TMPDIR, f.dir);
  assert.equal(paths.PUFFER_MAINT_STATE, join(f.dir, 'honest-annie-state'));
  result = f.command('prepare', { PI_CODING_AGENT_DIR: agent }); assert.equal(result.status, 0, result.stderr);
  assert.equal(f.git('config', 'user.name'), 'honest_annie');
  assert.equal(f.git('remote', 'get-url', 'upstream'), 'https://github.com/pufferpanel/pufferpanel.git');
  assert.equal(JSON.parse(readFileSync(join(agent, 'settings.json'))).defaultProvider, 'zai');
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
  const release = workflow.slice(workflow.indexOf('  release:'));
  assert.doesNotMatch(check, /secrets\.|contents: write/);
  assert.match(maintain, /github\.repository == 'bugabinga\/pufferpanel'/); assert.match(maintain, /github\.ref == 'refs\/heads\/trunk'/);
  assert.match(maintain, /vars\.HONEST_ANNIE_ENABLED == 'true'/); assert.match(maintain, /secrets\.ZAI_API_KEY/);
  assert.doesNotMatch(maintain, /REGISTRY_PASSWORD|ANNIE_GH_TOKEN|contents: write|issues: write|pull-requests: write/);
  assert.match(maintain, /GH_TOKEN: \$\{\{ github.token \}\}/); // Native read-only preparation only.
  assert.match(maintain, /github.run_attempt == 1/);
  assert.match(release, /contents: write/); assert.doesNotMatch(release, /ZAI_API_KEY/);
  assert.ok(release.indexOf('ci.sh gate') < release.indexOf('secrets.REGISTRY_PASSWORD'));
  for (const [, ref] of workflow.matchAll(/^\s*- uses: ([^\s]+)/gm)) assert.match(ref, /@[a-f0-9]{40}$/);
});
test('reviewed CI bundle imports exact commit, pushes once, and safely retries', t => {
  const f = fixture(t);
  let result = f.command('export'); assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(f.output, 'utf8'), 'candidate=true\n');
  assert.deepEqual(new Set(['candidate.bundle', 'result.json', 'gate.ok']), new Set(readdirSync(f.artifact)));
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
