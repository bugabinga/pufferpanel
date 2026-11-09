// Test-only Podman stub for the reviewer sandbox: records argv and environment, simulates builds, runs, and removal.
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createReviewSandbox } from './sandbox.mjs';

const STUB = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), { execFileSync } = require('node:child_process');
const dir = path.dirname(process.argv[1]), args = process.argv.slice(2), sub = args[6];
const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ args, env: process.env }) + '\\n');
const marker = (kind, name) => path.join(dir, kind + '-' + name);
if (sub === 'build') process.exit(config.buildFails || (config.visualBuildFails && args.includes('localhost/pufferpanel-maintainer-visual')) ? 1 : 0);
if (sub === 'version') { console.log(config.version ?? '4.9.3'); process.exit(0); }
if (sub === 'image' && args.some(arg => arg.includes('Config.Env'))) { console.log('PATH=/usr/local/go/bin\\nGOLANG_VERSION=1.27.3\\nGOTOOLCHAIN=local'); process.exit(0); }
if (sub === 'image') { console.log((args.at(-1).endsWith('tests') ? 'a' : args.at(-1).endsWith('visual') ? 'c' : 'b').repeat(64)); process.exit(0); }
if (sub === 'rm') { const name = args.at(-1); if (fs.existsSync(marker('running', name))) fs.writeFileSync(marker('killed', name), ''); fs.rmSync(marker('running', name), { force: true }); process.exit(0); }
if (sub === 'container') process.exit(fs.existsSync(marker('running', args.at(-1))) || fs.existsSync(marker('leaked', args.at(-1))) ? 0 : 1);
if (sub !== 'run') process.exit(125);
// Unsupported flags and undelegated cgroup controllers fail like Podman 4.9: message on stderr, exit 125.
const rejected = Object.entries(config.reject ?? {}).find(([flag]) => args.some(arg => arg.split('=')[0] === flag));
if (rejected) { process.stderr.write(rejected[1] + '\\n'); process.exit(125); }
// Visual containers: the vprobe check, or the driver given its JSON input; the default renders every route with a tiny PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const visualOutput = input => JSON.stringify({ browser: 'Chrome/156.0.8078.79', login: input.login ? { ok: true, url: 'http://127.0.0.1:8080/servers' } : null, routes: input.routes.map(route => ({ route, finalUrl: 'http://127.0.0.1:8080' + route, title: 'PufferPanel', text: 'PufferPanel Login', accessibility: ['main: ', 'heading level 1: Login'], screenshot: PNG, consoleErrors: [], consoleWarnings: [], exceptions: [], failedRequests: [], offlineRequests: [] })) }) + '\\n';
const visual = args.at(-2) === 'visual' ? (config.visual ?? { output: visualOutput(JSON.parse(args.at(-1))) }) : null;
const name = args[args.indexOf('--name') + 1], behavior = visual ?? config.run[args.at(-1)] ?? (args.at(-1) === 'sandbox-probe' ? { output: 'sandbox-probe-ok\\n' } : args.at(-1) === 'visual-probe' ? (config.vprobe ?? { output: 'browser=Chromium 156.0.8078.79 Alpine Linux\\nvisual-probe-ok\\n' }) : { output: 'unknown command', exitCode: 127 });
fs.writeFileSync(marker('running', name), '');
// A leaked container survives removal, as when Podman loses track of one.
if (behavior.leak) fs.writeFileSync(marker('leaked', name), '');
// Exit only after piped output is flushed, like a real container's.
const finish = code => { fs.rmSync(marker('running', name), { force: true }); process.stdout.write('', () => process.exit(code)); };
if (behavior.mutate) { fs.writeFileSync(path.join(behavior.mutate, 'escaped.txt'), 'escaped'); execFileSync('git', ['-C', behavior.mutate, 'add', '-A']); }
process.stdout.write(behavior.output ?? '');
if (behavior.bytes) process.stdout.write('HEAD' + 'x'.repeat(behavior.bytes) + 'TAIL');
const until = Date.now() + (behavior.sleepMs ?? 0);
const poll = () => { if (fs.existsSync(marker('killed', name))) finish(137); else if (Date.now() >= until) finish(behavior.exitCode ?? 0); else setTimeout(poll, 20); };
poll();
`;

export async function fakePodman(dir, config = {}, env = process.env) {
  const bin = join(dir, 'fake-podman-bin'); await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'podman'), STUB); await chmod(join(bin, 'podman'), 0o755);
  await writeFile(join(bin, 'config.json'), JSON.stringify({ run: {}, ...config }));
  // podman.sh requires an explicit runroot of at most 50 bytes, owned and mode 0700.
  const runroot = await mkdtemp('/tmp/annie-rr-'); await chmod(runroot, 0o700);
  return {
    env: { ...env, PATH: `${bin}:${env.PATH}`, PUFFER_MAINT_RUNROOT: runroot },
    calls: async () => (await readFile(join(bin, 'calls.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    cleanup: () => rm(runroot, { recursive: true, force: true }),
  };
}
// A pinned short runroot for tests that run the trusted shell scripts; podman.sh would otherwise create and leave one in /tmp.
export function pinnedRunroot(t) {
  const runroot = mkdtempSync('/tmp/annie-rr-'); chmodSync(runroot, 0o700);
  t.after(() => rmSync(runroot, { recursive: true, force: true }));
  return runroot;
}
export async function fakeReviewSandbox(t, dir, state, config, limits, vision = true) {
  const fake = await fakePodman(dir, config); t.after(fake.cleanup);
  return { fake, sandbox: createReviewSandbox({ state, env: fake.env, vision, ...(limits ? { limits } : {}) }) };
}
