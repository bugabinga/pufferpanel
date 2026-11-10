import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';

const moduleDir = new URL('.', import.meta.url).pathname;
const command = (file, args, options = {}) => spawnSync(file, args, { encoding: 'utf8', ...options });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'release-test-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), run = join(root, 'state/runs/today'), bin = join(root, 'bin');
  mkdirSync(repo); mkdirSync(run, { recursive: true }); mkdirSync(bin);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'test');
  writeFileSync(join(repo, 'go.mod'), 'module example.invalid/test\ngo 1.27.2\n'); writeFileSync(join(repo, 'Dockerfile'), 'FROM example.invalid/test');
  git('add', '.'); git('commit', '-qm', 'initial'); writeFileSync(join(run, 'gate.ok'), git('rev-parse', 'HEAD^{tree}'));
  const stateFile = join(root, 'fake.json');
  writeFileSync(stateFile, JSON.stringify({ sha: git('rev-parse', 'HEAD'), version: '2026.4.3', config: 'a'.repeat(64), remote: {}, commands: [] }));
  const helper = `#!/usr/bin/env node
import fs from 'node:fs'; import crypto from 'node:crypto';
const p=process.env.FAKE_STATE, s=JSON.parse(fs.readFileSync(p)), a=process.argv.slice(2), name=process.argv[1].split('/').pop();
const save=()=>fs.writeFileSync(p,JSON.stringify(s)); const hash=x=>'sha256:'+crypto.createHash('sha256').update(x).digest('hex');
s.commands.push(name+' '+a.join(' '));
if(name==='curl'){
 const out=a[a.indexOf('-o')+1], url=a.at(-1); let body='',code=200;
 if(url.includes('/manifests/')){const tag=url.split('/').pop();body=s.remote[tag]??'';code=s.httpError??(body?200:404);}
 else body=JSON.stringify({config:{Labels:{'org.opencontainers.image.revision':s.remoteSha??s.sha,'org.opencontainers.image.version':s.remoteVersion??s.version}}});
 fs.writeFileSync(out,body);save();if(a.includes('-w'))process.stdout.write(String(code));else if(code!==200)process.exit(22);
}else{
 if(s.failGate){save();process.exit(7);}
 if(a.includes('inspect'))process.stdout.write((s.idPrefix??'')+s.config);
 if(a.includes('run')&&a.includes('version'))process.stdout.write('PufferPanel '+s.version+' ('+s.sha+')\\n');
 if(a.includes('push')){const tag=a.at(-1).split(':').pop();if(tag==='latest'&&s.failLatest){save();process.exit(8);}const body=JSON.stringify({schemaVersion:2,config:{digest:'sha256:'+s.config}});s.remote[tag]=body;if(a.includes('--digestfile'))fs.writeFileSync(a[a.indexOf('--digestfile')+1],hash(body));}
 save();
}
`;
  for (const name of ['podman', 'curl']) { writeFileSync(join(bin, name), helper); execFileSync('chmod', ['+x', join(bin, name)]); }
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: tmpdir(), FAKE_STATE: stateFile };
  const load = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  const update = changes => writeFileSync(stateFile, JSON.stringify({ ...load(), ...changes }));
  const publish = () => command('bash', [join(moduleDir, 'publish.sh'), repo, '2026.4.3', run], { env });
  return { root, repo, run, env, git, load, update, publish };
}
// podman.sh fails closed on explicit runroots over 50 bytes (unix-socket path budget). The harness gate runs this suite
// under env -i with a deep isolated TMPDIR ("$context/tmp"), under which nothing below tmpdir() fits the budget, so an
// explicit runroot picks its base exactly like podman.sh's own auto-allocation: tmpdir() while a sibling fits, else /tmp.
const runrootUnder = base => mkdtempSync(join(`${realpathSync(base)}/pufferpanel-runroot.XXXXXX`.length <= 50 ? realpathSync(base) : '/tmp', 'pufferpanel-runroot.'));
test('preflight, gate, publisher use identical private Podman arguments and emit gate events', t => {
  const f = fixture(t); const runroot = runrootUnder(tmpdir()); t.after(() => rmSync(runroot, { recursive: true, force: true }));
  const common = { ...f.env, PUFFER_MAINT_STATE: join(f.root, 'state'), PUFFER_MAINT_RUNROOT: runroot, PUFFER_MAINT_SOURCE: f.repo, HONEST_ANNIE_ARTIFACT: join(f.root, 'artifact'), GITHUB_SHA: f.git('rev-parse', 'HEAD') };
  const preflight = command('bash', [join(moduleDir, 'ci.sh'), 'preflight'], { env: common }); assert.equal(preflight.status, 0, preflight.stderr);
  const gate = command('bash', [join(moduleDir, 'gate.sh'), f.repo, f.run], { env: common }); assert.equal(gate.status, 0, gate.stderr);
  const publish = command('bash', [join(moduleDir, 'publish.sh'), f.repo, '2026.4.3', f.run], { env: common }); assert.equal(publish.status, 0, publish.stderr);
  const podman = f.load().commands.filter(value => value.startsWith('podman '));
  const args = podman.map(value => value.split(' ').slice(0, 7).join(' '));
  assert.ok(args.every(value => value === args[0]), args.join('\n'));
  const events = readFileSync(join(f.run, 'gate-events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.some(event => event.name === 'whitespace'));
  assert.ok(events.some(event => event.name === 'publish-podman'));
  assert.ok(events.every(event => Number.isInteger(event.durationMs) && Number.isInteger(event.exitCode)));
});
test('explicit runroot fits the 50-byte Podman budget under the gate deep TMPDIR, which stays enforced', t => {
  const f = fixture(t);
  // The gate's own shape: TMPDIR="$context/tmp" off a multi-component runner temp context.
  const deep = mkdtempSync(join(f.root, 'tmp.E29D5VPz8z-tmp'));
  assert.ok(`${deep}/pufferpanel-runroot.XXXXXX`.length > 50, 'fixture must leave no room under the deep base');
  const runroot = runrootUnder(deep); t.after(() => rmSync(runroot, { recursive: true, force: true }));
  assert.ok(isAbsolute(runroot) && runroot.length <= 50, runroot);
  assert.notEqual(dirname(runroot), realpathSync(deep)); // forced to the short base, never silently under the deep one
  const preflight = dir => command('bash', [join(moduleDir, 'ci.sh'), 'preflight'], { env: { ...f.env, PUFFER_MAINT_STATE: join(f.root, 'state'), PUFFER_MAINT_RUNROOT: dir, PUFFER_MAINT_SOURCE: f.repo, HONEST_ANNIE_ARTIFACT: join(f.root, 'artifact'), GITHUB_SHA: f.git('rev-parse', 'HEAD') } });
  assert.equal(preflight(runroot).status, 0);
  const underDeep = mkdtempSync(join(deep, 'pufferpanel-runroot.')); t.after(() => rmSync(underDeep, { recursive: true, force: true }));
  assert.equal(preflight(underDeep).status, 64); // the runroot budget itself is untouched
});
test('gate fails closed and removes stale success marker', t => {
  const f = fixture(t); f.update({ failGate: true });
  const result = command('bash', [join(moduleDir, 'gate.sh'), f.repo, f.run], { env: f.env });
  assert.equal(result.status, 7); assert.match(f.load().commands.join('\n'), /build .*--target node/);
  assert.throws(() => readFileSync(join(f.run, 'gate.ok')));
});
test('publisher rejects invalid version before external commands', t => {
  const f = fixture(t);
  const result = command('bash', [join(moduleDir, 'publish.sh'), f.repo, '2026.0.1', f.run], { env: f.env });
  assert.equal(result.status, 64); assert.equal(f.load().commands.length, 0);
});
test('publisher releases exact version and latest with equal manifest digests', t => {
  const f = fixture(t); const result = f.publish(); assert.equal(result.status, 0, result.stderr);
  const state = f.load(); assert.equal(state.remote['2026.4.3'], state.remote.latest);
  assert.match(readFileSync(join(f.run, 'remote-proof'), 'utf8'), /version=2026.4.3\ndigest=sha256:/);
  const sha = createHash('sha256').update(state.remote.latest).digest('hex');
  assert.equal(readFileSync(join(f.run, 'version.digest'), 'utf8').trim(), `sha256:${sha}`);
});
test('retry after version push reuses remote image without rebuilding or replacing numbered tag', t => {
  const f = fixture(t); f.update({ failLatest: true, idPrefix: 'sha256:' }); assert.equal(f.publish().status, 8);
  assert.ok(f.load().remote['2026.4.3']); assert.equal(f.load().remote.latest, undefined);
  const before = f.load().commands.length; f.update({ failLatest: false }); const result = f.publish(); assert.equal(result.status, 0, result.stderr);
  const retry = f.load().commands.slice(before).join('\n'); assert.doesNotMatch(retry, /podman .* build |push .*pufferpanel:2026\.4\.3/);
  assert.equal(f.load().remote.latest, f.load().remote['2026.4.3']);
});
test('remote immutable collision and registry outage never reach latest promotion', t => {
  for (const scenario of ['collision', 'outage']) {
    const f = fixture(t);
    f.update(scenario === 'collision' ? { remote: { '2026.4.3': JSON.stringify({ config: { digest: `sha256:${'b'.repeat(64)}` } }) }, remoteSha: 'other' } : { httpError: 503 });
    const result = f.publish(); assert.notEqual(result.status, 0);
    assert.doesNotMatch(f.load().commands.join('\n'), /podman .* build |podman .* tag |podman .* push /);
  }
});
test('gate success is tied to exact tree, not an old boolean marker', t => {
  const f = fixture(t); writeFileSync(join(f.run, 'gate.ok'), 'ok');
  assert.notEqual(f.publish().status, 0); assert.equal(f.load().commands.length, 0);
});
