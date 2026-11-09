import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createReviewSandbox, outputCollector, RUN_LIMITS } from './sandbox.mjs';
import { fakePodman } from './fake-podman.mjs';

const moduleDir = new URL('.', import.meta.url).pathname;
const secrets = { GH_TOKEN: 'gh-sentinel', ANNIE_GH_TOKEN: 'annie-sentinel', ZAI_API_KEY: 'zai-sentinel', ANTHROPIC_API_KEY: 'anthropic-sentinel', REGISTRY_PASSWORD: 'registry-sentinel', HTTPS_PROXY: 'http://user:proxy-sentinel@proxy.invalid' };
async function fixture(t, config = {}, limits = RUN_LIMITS) {
  const dir = await mkdtemp(join(tmpdir(), 'annie-sandbox-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const worktree = join(dir, 'worktree'), state = join(dir, 'state'); await mkdir(worktree); await mkdir(state);
  const git = (...args) => execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.test');
  await mkdir(join(worktree, 'pkg')); await writeFile(join(worktree, 'pkg', 'value.txt'), 'reviewed'); git('add', '.'); git('commit', '-qm', 'base');
  const tree = git('write-tree');
  // Unstaged worktree edits are not part of T and must not reach the snapshot.
  await writeFile(join(worktree, 'pkg', 'value.txt'), 'unreviewed');
  const fake = await fakePodman(dir, config, { ...process.env, ...secrets }); t.after(fake.cleanup);
  const sandbox = createReviewSandbox({ state, env: fake.env, limits });
  t.after(() => sandbox.release());
  const log = join(dir, 'prime.log');
  const ready = await sandbox.prepare({ worktree, tree, deadline: Date.now() + 7_200_000, log });
  const run = (args, abortSignal) => sandbox.tool.execute(args, {}, { abortSignal }).then(result => result.structuredOutput);
  return { dir, state, worktree, tree, log, sandbox, fake, ready, run };
}
// Reviewer runs and the once-per-review probe are both `podman run`; tests count them separately.
const probeCalls = calls => calls.filter(call => call.args[6] === 'run' && call.args.at(-1) === 'sandbox-probe');
const runCalls = calls => calls.filter(call => call.args[6] === 'run' && call.args.at(-1) !== 'sandbox-probe');
const removals = calls => calls.filter(call => call.args[6] === 'rm').map(call => call.args.at(-1));
const running = (fake, name) => existsSync(join(fake.env.PATH.split(':')[0], `running-${name}`));

test('output collector keeps head and tail with an omission marker', () => {
  const small = outputCollector(16); small.push(Buffer.from('abcdefgh')); assert.deepEqual(small.result(), { output: 'abcdefgh', truncated: false });
  const large = outputCollector(16); for (const part of ['01234567', 'middle', 'xyz', 'ABCDEFGH']) large.push(Buffer.from(part));
  assert.deepEqual(large.result(), { output: '01234567\n[... 9 bytes omitted ...]\nABCDEFGH', truncated: true });
});

test('run uses exact sandbox flags on the frozen tree and leaks no host environment', async t => {
  const f = await fixture(t, { run: { 'go test ./pkg': { output: 'ok pkg\n', exitCode: 0 } } });
  assert.deepEqual(f.ready, { status: 'available', reason: null, podmanVersion: '4.9.3', runCalls: 0, runSeconds: 0 });
  const result = await f.run({ command: 'go test ./pkg' });
  assert.deepEqual(result, { exitCode: 0, output: 'ok pkg\n', truncated: false });
  const calls = await f.fake.calls(), [call] = runCalls(calls), args = call.args, src = args[args.indexOf('-v') + 1].replace(/:\/src:ro$/, '');
  for (const flag of ['--rm', '--network=none', '--read-only', '--read-only-tmpfs=false', '--unsetenv-all', '--http-proxy=false', '--pull=never', '--log-driver']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('-v') + 1], `${src}:/src:ro`);
  assert.match(args[args.indexOf('--tmpfs') + 1], /^\/tmp:rw,exec,nosuid,nodev,size=4g,mode=1777$/);
  assert.deepEqual(['--memory', '--memory-swap', '--cpus', '--pids-limit', '--cap-drop', '--security-opt', '--stop-timeout', '--timeout'].map(flag => args[args.indexOf(flag) + 1]), ['8g', '8g', '4', '4096', 'all', 'no-new-privileges', '0', '330']);
  assert.ok(!args.some(arg => /^--env-host|^--env-file|^--volume|^--privileged|^--network=(?!none)|^--net=/.test(arg)));
  assert.equal(args.filter(arg => arg === '-v').length, 1);
  assert.deepEqual(args.flatMap((arg, index) => arg === '--env' ? [args[index + 1].split('=')[0]] : []).sort(), ['GOCACHE', 'GOFLAGS', 'GOMODCACHE', 'GOPATH', 'GOPROXY', 'GOSUMDB', 'GOTOOLCHAIN', 'HOME', 'PATH', 'TMPDIR']);
  assert.ok(args.includes('GOFLAGS=-mod=readonly') && args.includes('GOPROXY=off'));
  assert.equal(args.at(-5), 'a'.repeat(64)); assert.equal(args.at(-1), 'go test ./pkg');
  // Neither the container argv nor the Podman client environment carries a credential or proxy value.
  for (const entry of calls) for (const value of Object.values(secrets)) assert.ok(!JSON.stringify(entry).includes(value.split('@')[0].split(':').at(-1)), `leaked ${value}`);
  assert.deepEqual(Object.keys(call.env).filter(key => !['PATH', 'HOME', 'TMPDIR', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'PUFFER_MAINT_RUNROOT', 'PUFFER_MAINT_STORAGE_DRIVER'].includes(key) && !/^(PWD|SHLVL|_|OLDPWD|__MISE_.*)$/.test(key)), []); // shell and node-shim bookkeeping only
  // The frozen export is T, read-only, and outside the worktree; release removes it.
  assert.equal(await readFile(join(src, 'pkg', 'value.txt'), 'utf8'), 'reviewed');
  assert.equal((await stat(join(src, 'pkg', 'value.txt'))).mode & 0o222, 0); assert.equal((await stat(join(src, 'pkg'))).mode & 0o222, 0);
  assert.ok(!src.startsWith(f.worktree));
  assert.ok(removals(calls).includes(args[args.indexOf('--name') + 1]));
  await f.sandbox.release(); assert.equal(existsSync(src), false);
  assert.equal(f.sandbox.diagnostic().runCalls, 1); assert.ok(f.sandbox.diagnostic().runSeconds >= 0);
  await assert.rejects(f.run({ command: 'go test ./pkg' }), /no active review/);
});

test('nonzero exit resolves, large output is capped, node toolchain selects the node image', async t => {
  const f = await fixture(t, { run: { fail: { output: 'FAIL\n', exitCode: 3 }, noisy: { bytes: 200_000 }, 'node --test': { output: 'pass' } } });
  assert.deepEqual(await f.run({ command: 'fail' }), { exitCode: 3, output: 'FAIL\n', truncated: false });
  const noisy = await f.run({ command: 'noisy' });
  assert.equal(noisy.truncated, true); assert.ok(noisy.output.startsWith('HEAD') && noisy.output.endsWith('TAIL'));
  assert.match(noisy.output, /\[\.\.\. 134472 bytes omitted \.\.\.\]/); assert.ok(Buffer.byteLength(noisy.output) < 64 * 1024 + 64);
  assert.equal((await f.run({ command: 'node --test', toolchain: 'node' })).output, 'pass');
  assert.equal(runCalls(await f.fake.calls()).at(-1).args.at(-5), 'b'.repeat(64));
});

test('timeout and abort remove the container and reject clearly', async t => {
  const f = await fixture(t, { run: { hang: { sleepMs: 30_000 } } }, { ...RUN_LIMITS, killMs: 5000 });
  const started = Date.now();
  await assert.rejects(f.run({ command: 'hang', timeoutSeconds: 1 }), /run timed out after 1s; container annie-review-[a-f0-9]{16} was removed/);
  assert.ok(Date.now() - started < 10_000);
  let calls = await f.fake.calls(); let name = runCalls(calls).at(-1).args.find(arg => arg.startsWith('annie-review-'));
  assert.ok(removals(calls).includes(name)); assert.equal(running(f.fake, name), false);
  const controller = new AbortController(); setTimeout(() => controller.abort(), 300);
  await assert.rejects(f.run({ command: 'hang' }, controller.signal), /run aborted; container annie-review-[a-f0-9]{16} was removed/);
  calls = await f.fake.calls(); name = runCalls(calls).at(-1).args.find(arg => arg.startsWith('annie-review-'));
  assert.ok(removals(calls).includes(name)); assert.equal(running(f.fake, name), false);
  // Release while a run is active also removes it.
  const pending = f.run({ command: 'hang' }).catch(error => error);
  await new Promise(resolve => setTimeout(resolve, 300)); await f.sandbox.release();
  assert.match((await pending).message, /run aborted/);
  calls = await f.fake.calls(); name = runCalls(calls).at(-1).args.find(arg => arg.startsWith('annie-review-'));
  assert.equal(running(f.fake, name), false);
});

test('total sandbox time per review is bounded', async t => {
  const f = await fixture(t, { run: { slow: { sleepMs: 3200 } } }, { ...RUN_LIMITS, reviewMs: 4000 });
  assert.equal((await f.run({ command: 'slow' })).exitCode, 0);
  await assert.rejects(f.run({ command: 'slow' }), /reviewer run budget exhausted: .* per review/);
  assert.equal(runCalls(await f.fake.calls()).length, 1);
});

test('infrastructure failures reject instead of resolving', async t => {
  const failed = await fixture(t, { buildFails: true });
  // Priming failure still records which Podman the run met.
  assert.deepEqual(failed.ready, { status: 'unavailable', reason: 'gate image priming failed (private host log; the fixed gate rebuilds and reports it)', podmanVersion: '4.9.3', runCalls: 0, runSeconds: 0 });
  await assert.rejects(failed.run({ command: 'true' }), /reviewer sandbox unavailable: gate image priming failed/);
  assert.equal(runCalls(await failed.fake.calls()).length, 0);
  const podmanError = await fixture(t, { run: { broken: { output: 'Error: image not known', exitCode: 125 } } });
  await assert.rejects(podmanError.run({ command: 'broken' }), /sandbox infrastructure failure \(podman exit 125\): Error: image not known/);
  const builds = async () => (await podmanError.fake.calls()).filter(call => call.args[6] === 'build').length, before = await builds();
  assert.deepEqual(await podmanError.sandbox.prepare({ worktree: podmanError.worktree, tree: podmanError.tree, deadline: Date.now() + 7_200_000, log: podmanError.log, sourceChanged: false }), { status: 'unavailable', reason: 'management-only candidate has no source change to run', podmanVersion: null, runCalls: 0, runSeconds: 0 });
  assert.equal(await builds(), before);
  await assert.rejects(podmanError.run({ command: 'broken' }), /unavailable: management-only candidate has no source change to run/);
  const dir = await mkdtemp(join(tmpdir(), 'annie-sandbox-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const unpinned = createReviewSandbox({ state: dir, env: { PATH: process.env.PATH } });
  execFileSync('git', ['init', '-q', dir]);
  await unpinned.prepare({ worktree: dir, tree: execFileSync('git', ['-C', dir, 'write-tree'], { encoding: 'utf8' }).trim(), deadline: Date.now() + 7_200_000, log: join(dir, 'log') });
  await assert.rejects(unpinned.tool.execute({ command: 'true' }, {}, {}), /unavailable: no pinned Podman runroot/); await unpinned.release();
});

// Each probe outcome: only cgroup limits may drop; network, read-only source/root, and environment isolation never do.
const kept = ['--network=none', '--read-only', '--http-proxy=false', '--pull=never'];
const crun = 'Error: OCI runtime error: crun: the requested cgroup controller `memory` is not available';
for (const scenario of [
  { name: 'full profile', config: {}, status: 'available', reason: null, probes: 1, has: ['--unsetenv-all', '--read-only-tmpfs=false', '--memory', '--cpus', '--pids-limit'] },
  { name: 'undelegated cgroup controller drops only limits', config: { reject: { '--memory': crun } }, status: 'limited', reason: /^cgroup limits not delegated: .*controller `memory` is not available$/, probes: 2, has: ['--unsetenv-all', '--read-only-tmpfs=false'], lacks: ['--memory', '--memory-swap', '--cpus', '--pids-limit'] },
  { name: 'cgroup v1 rootless warning means limits are ignored', config: { run: { 'sandbox-probe': { output: 'WARN[0000] Resource limits are not supported and ignored on cgroups V1 rootless systems\nsandbox-probe-ok\n' } } }, status: 'limited', reason: /^cgroup limits ignored: WARN.*ignored on cgroups V1/, probes: 1, has: ['--memory'] },
  { name: 'swap-capability warning still enforces limits', config: { run: { 'sandbox-probe': { output: 'WARNING: Your kernel does not support swap limit capabilities or the cgroup is not mounted. Memory limited without swap.\nsandbox-probe-ok\n' } } }, status: 'available', reason: null, probes: 1, has: ['--memory'] },
  { name: 'missing --unsetenv-all and --read-only-tmpfs use explicit equivalents', config: { reject: { '--unsetenv-all': 'Error: unknown flag: --unsetenv-all', '--read-only-tmpfs': 'Error: unknown flag: --read-only-tmpfs' } }, status: 'available', reason: 'compat: explicit --unsetenv; compat: default read-only tmpfs', probes: 3, has: ['--memory'], lacks: ['--unsetenv-all', '--read-only-tmpfs=false'], unsets: ['container', 'TERM', 'GOLANG_VERSION'] },
  { name: 'compat and undelegated limits combine', config: { reject: { '--unsetenv-all': 'Error: unknown flag: --unsetenv-all', '--pids-limit': 'Error: crun: opening file `pids.max` for writing: No such file or directory' } }, status: 'limited', reason: /^compat: explicit --unsetenv; cgroup limits not delegated: .*pids\.max/, probes: 3, lacks: ['--unsetenv-all', '--pids-limit', '--memory'], unsets: ['GOLANG_VERSION'] },
  { name: 'unsupported isolation flag makes the sandbox unavailable', config: { reject: { '--network': 'Error: unknown flag: --network' } }, status: 'unavailable', reason: 'sandbox probe: probe failed: Error: unknown flag: --network', probes: 1 },
  { name: 'cgroup-worded WARN before an unrelated error does not drop limits', config: { reject: { '--network': 'WARN[0000] Falling back to --cgroup-manager=cgroupfs\nError: unknown flag: --network' } }, status: 'unavailable', reason: 'sandbox probe: probe failed: Error: unknown flag: --network', probes: 1 },
  { name: 'cgroup-worded WARN before the crun error quotes the crun line', config: { reject: { '--memory': `WARN[0000] The cgroupv2 manager is set to systemd but there is no systemd user session available\n${crun}` } }, status: 'limited', reason: /^cgroup limits not delegated: Error: OCI runtime error: crun: the requested cgroup controller `memory` is not available$/, probes: 2, has: ['--unsetenv-all'], lacks: ['--memory', '--cpus', '--pids-limit'] },
  { name: 'failed in-container isolation check makes the sandbox unavailable', config: { run: { 'sandbox-probe': { output: 'probe: unexpected environment variable LEAKED\n', exitCode: 1 } } }, status: 'unavailable', reason: 'sandbox probe: probe failed: probe: unexpected environment variable LEAKED', probes: 1 },
]) test(`probe: ${scenario.name}`, async t => {
  const f = await fixture(t, { ...scenario.config, run: { 'go vet ./pkg': { output: 'vetted' }, ...scenario.config.run } });
  const { status, reason, podmanVersion } = f.ready;
  assert.equal(status, scenario.status); assert.equal(podmanVersion, '4.9.3');
  if (scenario.reason instanceof RegExp) assert.match(reason, scenario.reason); else assert.equal(reason, scenario.reason);
  const probes = probeCalls(await f.fake.calls());
  assert.equal(probes.length, scenario.probes);
  for (const call of probes) for (const flag of kept) assert.ok(call.args.includes(flag), flag);
  for (const name of removals(await f.fake.calls()).filter(name => name.startsWith('annie-review-probe'))) assert.equal(running(f.fake, name), false);
  if (status === 'unavailable') { await assert.rejects(f.run({ command: 'go vet ./pkg' }), /reviewer sandbox unavailable: sandbox probe: /); return; }
  // The following run uses exactly the probed profile.
  assert.equal((await f.run({ command: 'go vet ./pkg' })).output, 'vetted');
  const args = runCalls(await f.fake.calls()).at(-1).args;
  for (const flag of [...kept, ...(scenario.has ?? [])]) assert.ok(args.includes(flag), flag);
  for (const flag of scenario.lacks ?? []) assert.ok(!args.includes(flag), flag);
  assert.ok(args.some(arg => /:\/src:ro$/.test(arg)) && args.includes('no-new-privileges') && args[args.indexOf('--cap-drop') + 1] === 'all');
  const unsets = args.flatMap((arg, index) => arg === '--unsetenv' ? [args[index + 1]] : []);
  assert.deepEqual(unsets, scenario.unsets ? ['container', 'TERM', 'GOLANG_VERSION'] : []);
});

// Optional: real rootless Podman, only with a locally present tiny image; never pulls.
test('real rootless podman smoke: offline, read-only, empty env, exit code, kill', async t => {
  const image = 'docker.io/library/alpine:3.22.0';
  if (spawnSync('podman', ['info'], { stdio: 'ignore' }).status !== 0 || spawnSync('podman', ['image', 'exists', image]).status !== 0) return t.skip('rootless podman or local alpine:3.22.0 unavailable');
  const dir = await mkdtemp('/tmp/annie-smoke-'), runroot = join(dir, 'rr'), state = join(dir, 'state'), src = join(dir, 'src');
  await mkdir(runroot, { mode: 0o700 }); await mkdir(join(src, 'client'), { recursive: true }); await mkdir(state);
  await writeFile(join(src, 'client', 'f.txt'), 'frozen'); execFileSync('chmod', ['-R', 'a-w', src]);
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, PUFFER_MAINT_RUNROOT: runroot, GH_TOKEN: 'gh-sentinel' };
  const podman = ['--root', join(state, 'podman', 'root'), '--runroot', runroot, '--storage-driver', 'overlay'];
  t.after(() => { spawnSync('podman', [...podman, 'rm', '--all', '--force', '--time', '0']); spawnSync('podman', [...podman, 'rmi', '--all', '--force']); execFileSync('chmod', ['-R', 'u+w', src]); spawnSync('podman', ['unshare', 'rm', '-rf', dir]); });
  execFileSync('bash', ['-c', `podman save ${image} | podman ${podman.join(' ')} load -q`], { stdio: 'ignore' });
  const id = execFileSync('podman', [...podman, 'image', 'inspect', '--format', '{{.Id}}', image], { encoding: 'utf8' }).trim();
  const sandbox = (args, ms = 60_000) => new Promise(resolve => {
    const child = spawn('bash', [join(moduleDir, 'sandbox.sh'), ...args], { env, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    let output = '', status = ''; child.stdout.on('data', c => { output += c; }); child.stderr.on('data', c => { output += c; }); child.stdio[3]?.on('data', c => { status += c; });
    const timer = setTimeout(() => child.kill('SIGKILL'), ms); child.on('close', code => { clearTimeout(timer); resolve({ code, output, status: status.trim() }); });
  });
  const probe = 'env | sort; cat f.txt; echo mutable > f.txt && echo copy-writable; touch /src/x 2>/dev/null || echo src-readonly; touch /etc/x 2>/dev/null || echo root-readonly; wget -q -T 2 http://1.1.1.1 2>/dev/null || echo offline; exit 3';
  // The real probe picks this host's profile; it must keep network, source, and environment isolation either way.
  const probed = Object.fromEntries((await sandbox(['probe', state, src, id])).output.trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  t.diagnostic(JSON.stringify(probed));
  assert.ok(['available', 'limited'].includes(probed.status), JSON.stringify(probed)); assert.match(probed.profile, /^(limits|nolimits),unsetenv-all,ro-tmpfs$/);
  const result = await sandbox(['run', state, src, 'node', id, probed.profile, 'annie-review-smoke0001', '60', probe]);
  t.diagnostic(result.output.replace(/\n/g, ' | '));
  assert.equal(result.status, '3');
  for (const line of ['frozen', 'copy-writable', 'src-readonly', 'root-readonly', 'offline', 'HOME=/tmp/home', 'npm_config_offline=true']) assert.ok(result.output.includes(line), line);
  assert.doesNotMatch(result.output, /sentinel|GH_TOKEN|XDG_RUNTIME_DIR|container=/);
  assert.equal(await readFile(join(src, 'client', 'f.txt'), 'utf8'), 'frozen');
  const hang = sandbox(['run', state, src, 'node', id, probed.profile, 'annie-review-smoke0002', '60', 'sleep 50']);
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal((await sandbox(['kill', state, 'annie-review-smoke0002'])).code, 0);
  assert.notEqual((await hang).status, '0');
  assert.equal(spawnSync('podman', [...podman, 'container', 'exists', 'annie-review-smoke0002']).status, 1);
});
