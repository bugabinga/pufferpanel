import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { republish } from './republish.mjs';

const moduleDir = new URL('.', import.meta.url).pathname;
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'annie-republish-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const origin = join(dir, 'origin.git'), source = join(dir, 'source'), state = join(dir, 'state'), bin = join(dir, 'bin');
  const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=trunk', origin]); execFileSync('git', ['clone', '-q', origin, source]);
  git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.invalid'); git('config', 'commit.gpgsign', 'false');
  const commit = message => { writeFileSync(join(source, 'value.txt'), message); git('add', '.'); git('commit', '-qm', message); return git('rev-parse', 'HEAD'); };
  const released = commit('maintenance: 2026-04-03'); git('push', '-q', 'origin', 'trunk');
  git('checkout', '-q', '-b', 'side'); const unreachable = commit('never pushed'); git('checkout', '-q', 'trunk');
  mkdirSync(bin); writeFileSync(join(bin, 'podman'), '#!/usr/bin/env bash\nexit 0\n'); chmodSync(join(bin, 'podman'), 0o755);
  const plan = (releaseCommit, extra = {}) => JSON.stringify({ runId: 42, releaseCommit, version: '2026.4.3', day: '2026-04-03', ...extra });
  const env = { ...process.env, GITHUB_ACTIONS: 'false', PATH: `${bin}:${process.env.PATH}`, PUFFER_MAINT_SOURCE: source, PUFFER_MAINT_STATE: state, HONEST_ANNIE_ARTIFACT: join(dir, 'artifact'), GITHUB_SHA: released, TMPDIR: tmpdir() };
  const node = (command, republish, extra = {}) => spawnSync('node', [join(moduleDir, 'republish.mjs'), ...command.split(' ')], { env: { ...env, ANNIE_REPUBLISH: republish, ...extra }, encoding: 'utf8' });
  const ci = (command, republish, extra = {}) => spawnSync('bash', [join(moduleDir, 'ci.sh'), command], { env: { ...env, ANNIE_REPUBLISH: republish, ...extra }, encoding: 'utf8' });
  return { env, dir, source, state, git, commit, released, unreachable, plan, node, ci, runDir: join(state, 'runs', '2026-04-03'), worktree: join(state, 'republish-worktree') };
}

test('republish verify/authorize refuse source unreachable from current trunk and malformed plans', t => {
  const f = fixture(t);
  for (const command of ['verify', 'authorize']) {
    const result = f.node(command, f.plan(f.unreachable)); assert.notEqual(result.status, 0); assert.match(result.stderr, /not reachable from current trunk/);
  }
  assert.equal(existsSync(f.worktree), false);
  for (const bad of [f.plan(f.released, { version: '2026.4.4' }), f.plan(f.released, { day: '2026-02-30', version: '2026.2.30' }), f.plan(f.released, { extra: true }), 'not json']) {
    const result = f.node('verify', bad); assert.notEqual(result.status, 0); assert.match(result.stderr, /invalid republish plan/);
  }
});

test('republish gates detached release worktree; registry auth requires exact gated tree, even after trunk advanced', t => {
  const f = fixture(t), plan = f.plan(f.released);
  let result = f.node('verify', plan); assert.equal(result.status, 0, result.stderr);
  assert.equal(execFileSync('git', ['-C', f.worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), f.released);
  result = f.node('authorize', plan); assert.notEqual(result.status, 0); assert.match(result.stderr, /independent republish gate required/);
  writeFileSync(join(f.runDir, 'gate.ok'), '0'.repeat(40) + '\n');
  result = f.ci('registry-login', plan); assert.notEqual(result.status, 0); assert.match(result.stderr, /independent republish gate required/);
  f.commit('human follow-up'); f.git('push', '-q', 'origin', 'trunk');
  result = f.node('gate', plan); assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(f.runDir, 'gate.ok'), 'utf8').trim(), execFileSync('git', ['-C', f.worktree, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim());
  result = f.node('authorize', plan); assert.equal(result.status, 0, result.stderr);
  // Authorization passed; only then does registry-login demand credentials.
  result = f.ci('registry-login', plan, { REGISTRY_USERNAME: '' }); assert.notEqual(result.status, 0); assert.match(result.stderr, /REGISTRY_USERNAME/);
  writeFileSync(join(f.worktree, 'value.txt'), 'dirty'); result = f.node('authorize', plan); assert.match(result.stderr, /worktree identity mismatch/);
});

test('republish report carries only identity plus digest or a fixed failure reason', t => {
  const f = fixture(t), plan = f.plan(f.released), out = join(f.dir, 'report'), summary = join(f.dir, 'summary.md');
  let result = f.node(`report ${out}`, plan, { ANNIE_REPUBLISH_STAGES: 'verify=success,gate=failure,login=skipped,publish=skipped', GITHUB_STEP_SUMMARY: summary });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')), { runId: 42, releaseCommit: f.released, version: '2026.4.3', reason: 'gate-failure' });
  assert.match(readFileSync(summary, 'utf8'), /reason: gate-failure/);
  mkdirSync(f.runDir, { recursive: true }); const digest = `sha256:${'d'.repeat(64)}`;
  writeFileSync(join(f.runDir, 'publish.ok'), f.released + '\n'); writeFileSync(join(f.runDir, 'remote-proof'), `revision=${f.released}\nversion=2026.4.3\ndigest=${digest}\n`);
  result = f.node(`report ${out}`, plan, { ANNIE_REPUBLISH_STAGES: 'verify=success,gate=success,login=success,publish=success' });
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')), { runId: 42, releaseCommit: f.released, version: '2026.4.3', publicationDigest: digest });
  result = f.node(`report ${out}`, 'not json');
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')), { runId: null, releaseCommit: null, version: null, reason: 'invalid-republish-plan' });
});

test('hosted verify trusts the current harness: older release-commit policy republishes, trusted checkout policy must equal current trunk', async t => {
  const f = fixture(t), checkout = 'a'.repeat(40), trunk = 'b'.repeat(40), tools = 'd'.repeat(40);
  const run = async ({ checkoutPolicy, protectedTrunk = false }) => {
    const policy = { [f.released]: '1', [trunk]: '2', [checkout]: checkoutPolicy }, json = value => new Response(JSON.stringify(value));
    const fetchImpl = async url => {
      const path = new URL(url).pathname.replace('/repos/bugabinga/pufferpanel', '');
      if (path === '/branches/trunk') return json({ protected: protectedTrunk, commit: { sha: trunk } });
      if (path === '/rules/branches/trunk') return json([]);
      if (path === `/git/trees/${tools}`) return json({ tree: [{ path: 'maintainer', sha: 'e'.repeat(40) }] });
      return json({ tree: [{ path: '.github', sha: policy[path.split('/').at(-1)].repeat(40) }, { path: 'tools', sha: tools }] });
    };
    return republish('verify', { ...f.env, GITHUB_ACTIONS: 'true', HONEST_ANNIE_ENABLED: 'true', GH_TOKEN: 'read-only', GITHUB_SHA: checkout, ANNIE_REPUBLISH: f.plan(f.released) }, null, { fetchImpl });
  };
  await assert.rejects(run({ checkoutPolicy: '3' }), /trusted checkout policy differs from current trunk/); assert.equal(existsSync(f.worktree), false);
  await assert.rejects(run({ checkoutPolicy: '2', protectedTrunk: true }), /current effects policy blocks automation/); assert.equal(existsSync(f.worktree), false);
  await run({ checkoutPolicy: '2' });
  assert.equal(execFileSync('git', ['-C', f.worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), f.released);
});
