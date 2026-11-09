// Test-only Podman stub for the reviewer sandbox: records argv and environment, simulates builds, runs, and removal.
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createReviewSandbox } from './sandbox.mjs';

const STUB = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), { execFileSync } = require('node:child_process');
const dir = path.dirname(process.argv[1]), args = process.argv.slice(2), sub = args[6];
const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ args, env: process.env }) + '\\n');
const marker = (kind, name) => path.join(dir, kind + '-' + name);
if (sub === 'build') process.exit(config.buildFails ? 1 : 0);
if (sub === 'version') { console.log(config.version ?? '4.9.3'); process.exit(0); }
if (sub === 'image' && args.some(arg => arg.includes('Config.Env'))) { console.log('PATH=/usr/local/go/bin\\nGOLANG_VERSION=1.27.3\\nGOTOOLCHAIN=local'); process.exit(0); }
if (sub === 'image') { console.log((args.at(-1).endsWith('tests') ? 'a' : 'b').repeat(64)); process.exit(0); }
if (sub === 'rm') { const name = args.at(-1); if (fs.existsSync(marker('running', name))) fs.writeFileSync(marker('killed', name), ''); fs.rmSync(marker('running', name), { force: true }); process.exit(0); }
if (sub === 'container') process.exit(fs.existsSync(marker('running', args.at(-1))) ? 0 : 1);
if (sub !== 'run') process.exit(125);
// Unsupported flags and undelegated cgroup controllers fail like Podman 4.9: message on stderr, exit 125.
const rejected = Object.entries(config.reject ?? {}).find(([flag]) => args.some(arg => arg.split('=')[0] === flag));
if (rejected) { process.stderr.write(rejected[1] + '\\n'); process.exit(125); }
const name = args[args.indexOf('--name') + 1], behavior = config.run[args.at(-1)] ?? (args.at(-1) === 'sandbox-probe' ? { output: 'sandbox-probe-ok\\n' } : { output: 'unknown command', exitCode: 127 });
fs.writeFileSync(marker('running', name), '');
const finish = code => { fs.rmSync(marker('running', name), { force: true }); process.exit(code); };
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
export async function fakeReviewSandbox(t, dir, state, config, limits) {
  const fake = await fakePodman(dir, config); t.after(fake.cleanup);
  return { fake, sandbox: createReviewSandbox({ state, env: fake.env, ...(limits ? { limits } : {}) }) };
}
