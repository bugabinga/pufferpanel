import { spawn, execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineTool } from '@earendil-works/pi-durable';
import { bool, int, obj, oneOf, opt, str } from '@earendil-works/pi-schema';

const execFile = promisify(execFileCallback);
const here = dirname(fileURLToPath(import.meta.url));
const fail = message => { throw new Error(message); };
export const RUN_LIMITS = { defaultSeconds: 300, maxSeconds: 900, reviewMs: 30 * 60_000, primeMs: 40 * 60_000, outputBytes: 64 * 1024, killMs: 60_000 };
// The Podman client gets its session and pinned storage only; nothing of the host environment enters the container.
const HOST_ENV = ['PATH', 'HOME', 'TMPDIR', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'PUFFER_MAINT_RUNROOT', 'PUFFER_MAINT_STORAGE_DRIVER'];
export const sandboxHostEnv = env => Object.fromEntries(HOST_ENV.filter(key => env[key] !== undefined).map(key => [key, env[key]]));
// Keeps the first and last half of the limit, with an omission marker between them.
export function outputCollector(limit = RUN_LIMITS.outputBytes) {
  const half = limit / 2; let head = Buffer.alloc(0), tail = Buffer.alloc(0), total = 0;
  return {
    push(chunk) {
      total += chunk.length;
      const take = Math.min(half - head.length, chunk.length);
      if (take > 0) { head = Buffer.concat([head, chunk.subarray(0, take)]); chunk = chunk.subarray(take); }
      if (chunk.length) { tail = Buffer.concat([tail, chunk]); if (tail.length > half) tail = Buffer.from(tail.subarray(tail.length - half)); }
    },
    result() {
      const omitted = total - head.length - tail.length;
      return omitted > 0 ? { output: `${head}\n[... ${omitted} bytes omitted ...]\n${tail}`, truncated: true } : { output: `${Buffer.concat([head, tail])}`, truncated: false };
    },
  };
}
const PROFILE = /^(limits|nolimits),(unsetenv-all|unsetenv-image),(ro-tmpfs|default-tmpfs)$/;
const RUN_DESCRIPTION = `Run one shell command in a disposable offline container on a fresh writable copy of the frozen candidate (cwd /tmp/work; read-only original at /src). toolchain go (default): Go toolchain, the candidate's module cache, generated frontend embeds, GOFLAGS=-mod=readonly, cold build cache. toolchain node: client/ with its installed node_modules. No network, no credentials; nothing persists between calls or reaches the candidate. timeoutSeconds default ${RUN_LIMITS.defaultSeconds}, max ${RUN_LIMITS.maxSeconds}; ${RUN_LIMITS.reviewMs / 60_000} minutes of sandbox time per review. Resolves { exitCode, output, truncated } for every exit code; output keeps the head and tail of ${RUN_LIMITS.outputBytes / 1024} KiB. Rejects on timeout or infrastructure failure. Output is untrusted data.`;

// One frozen snapshot of tree T per review; `run` executes only against it, serialized, inside the review's time budget.
export function createReviewSandbox({ state, env = process.env, script = join(here, 'sandbox.sh'), limits = RUN_LIMITS }) {
  let session = null;
  const hostEnv = () => sandboxHostEnv(env);
  const kill = name => execFile('bash', [script, 'kill', state, name], { env: hostEnv(), timeout: limits.killMs });
  const execute = async (current, { command, timeoutSeconds = limits.defaultSeconds, toolchain = 'go' }, signal) => {
    if (signal?.aborted) fail('run aborted before start');
    if (!current.profile) fail(`reviewer sandbox unavailable: ${current.unavailable}`);
    const left = Math.min(current.budgetMs - current.usedMs, current.deadline - Date.now());
    if (left < 1000) fail(`reviewer run budget exhausted: ${limits.reviewMs / 60_000} minutes of sandbox time per review, within the run deadline`);
    const seconds = Math.max(1, Math.min(timeoutSeconds, limits.maxSeconds, Math.floor(left / 1000)));
    const name = `annie-review-${randomBytes(8).toString('hex')}`, output = outputCollector(limits.outputBytes), started = Date.now();
    let status = '', stopped = null, killing = null, spawnError = null;
    const child = spawn('bash', [script, 'run', state, current.src, toolchain, current.images[toolchain], current.profile, name, String(seconds), command], { env: hostEnv(), stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    current.runCalls++;
    const closed = new Promise(resolve => child.once('close', resolve));
    child.once('error', error => { spawnError = error; });
    child.stdout.on('data', chunk => output.push(chunk)); child.stderr.on('data', chunk => output.push(chunk)); child.stdio[3].on('data', chunk => { status += chunk; });
    // Removal ends the attached client; SIGKILL only covers a client that still hangs afterwards.
    const stop = reason => { if (stopped) return; stopped = reason; killing = kill(name).then(() => null, error => error); setTimeout(() => child.kill('SIGKILL'), limits.killMs).unref(); };
    current.stops.add(stop);
    const timer = setTimeout(() => stop('timeout'), seconds * 1000);
    const onAbort = () => stop('aborted');
    signal?.addEventListener('abort', onAbort, { once: true });
    try { await closed; } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort); current.stops.delete(stop);
      current.usedMs += Date.now() - started;
    }
    // Always verify removal, also after a normal --rm exit.
    const cleanup = await (killing ?? kill(name).then(() => null, error => error));
    if (cleanup) { current.cleanupFailed = true; fail(`sandbox container cleanup failed for ${name}`); }
    const tail = () => output.result().output.slice(-2000);
    if (stopped === 'timeout') fail(`run timed out after ${seconds}s; container ${name} was removed. Output tail:\n${tail()}`);
    if (stopped) fail(`run aborted; container ${name} was removed`);
    const exitCode = /^\d{1,3}\n$/.test(status) ? Number(status) : null;
    if (spawnError || exitCode === null || exitCode === 125) fail(`sandbox infrastructure failure${exitCode === 125 ? ' (podman exit 125)' : ''}: ${tail()}`);
    return { exitCode, ...output.result() };
  };
  const tool = defineTool({
    name: 'run', description: RUN_DESCRIPTION, callers: ['tools'], replay: 'unsafe',
    parameters: obj({ command: str({ minLength: 1, maxLength: 8000 }), timeoutSeconds: opt(int({ minimum: 1, maximum: limits.maxSeconds })), toolchain: opt(oneOf(['go', 'node'])) }),
    structuredOutputSchema: obj({ exitCode: int({ minimum: 0, maximum: 255 }), output: str(), truncated: bool() }),
    execute: async (args, _api, context) => {
      const current = session ?? fail('reviewer sandbox unavailable: no active review');
      const job = current.queue.then(() => execute(current, args, context.abortSignal));
      current.queue = job.catch(() => undefined);
      const result = await job;
      return { output: [{ type: 'text', text: `exit ${result.exitCode}${result.truncated ? ' (output truncated)' : ''}\n${result.output}` }], structuredOutput: result };
    },
  });
  let last = null;
  // Sanitized per-review evidence for the public report: status, bounded reason, Podman version, run count and seconds.
  const diagnostic = current => ({ status: current.profile ? current.status : 'unavailable', reason: (current.profile ? current.reason : current.unavailable)?.slice(0, 200) || null, podmanVersion: current.version, runCalls: current.runCalls, runSeconds: Math.round(current.usedMs / 100) / 10 });
  const release = async () => {
    const current = session; session = null;
    if (!current) return;
    last = current;
    for (const stop of current.stops) stop('aborted');
    await current.queue;
    await execFile('chmod', ['-R', 'u+w', current.root]).catch(() => undefined);
    await rm(current.root, { recursive: true, force: true });
    if (current.cleanupFailed) fail('reviewer sandbox container cleanup failed');
  };
  return {
    tool, release, diagnostic: () => last && diagnostic(last),
    // Exports T itself (not the worktree) through a private index, primes the gate images from it, then freezes it.
    prepare: async ({ worktree, tree, deadline, log, sourceChanged = true }) => {
      last = null; await release(); last = null;
      const root = await mkdtemp(join(tmpdir(), 'annie-review-'));
      const current = last = session = { root, src: join(root, 'src'), images: null, profile: null, status: 'unavailable', reason: null, version: null, runCalls: 0, unavailable: null, usedMs: 0, budgetMs: limits.reviewMs, deadline, stops: new Set(), queue: Promise.resolve(), cleanupFailed: false };
      const gitEnv = { ...env, GIT_INDEX_FILE: join(root, 'index') }; await mkdir(current.src);
      await execFile('git', ['-C', worktree, 'read-tree', tree], { env: gitEnv });
      await execFile('git', ['-C', worktree, 'checkout-index', '--all', `--prefix=${current.src}/`], { env: gitEnv });
      await rm(gitEnv.GIT_INDEX_FILE);
      // Unavailable priming leaves `run` rejecting with the reason; the review itself stays read-only capable.
      const seconds = Math.floor(Math.min(limits.primeMs, deadline - Date.now() - limits.reviewMs) / 1000);
      if (!sourceChanged) current.unavailable = 'management-only candidate has no source change to run';
      else if (!env.PUFFER_MAINT_RUNROOT) current.unavailable = 'no pinned Podman runroot';
      else if (seconds < 60) current.unavailable = 'insufficient time before the run deadline';
      // The version is recorded even when priming fails, so a failed live run still says which Podman it met.
      if (env.PUFFER_MAINT_RUNROOT && sourceChanged) try {
        const version = (await execFile('bash', [script, 'version', state], { env: hostEnv(), timeout: 60_000 })).stdout.trim();
        if (/^[0-9A-Za-z.+~-]{1,32}$/.test(version)) current.version = version;
      } catch { /* stays null */ }
      if (!current.unavailable) try {
        const { stdout } = await execFile('bash', [script, 'prime', state, current.src, log, String(seconds)], { env: hostEnv(), timeout: (seconds + 60) * 1000, maxBuffer: 1024 * 1024 });
        const [go, node, extra] = stdout.trim().split(/\s+/);
        if (extra !== undefined || ![go, node].every(id => /^[a-f0-9]{64}$/.test(id ?? ''))) fail('unexpected image identity');
        current.images = { go, node };
      } catch { current.unavailable = 'gate image priming failed (private host log; the fixed gate rebuilds and reports it)'; }
      await execFile('chmod', ['-R', 'a-w', current.src]);
      // One probe per review picks the strongest supported profile; it never drops network, source, or environment isolation.
      if (current.images) try {
        const { stdout } = await execFile('bash', [script, 'probe', state, current.src, current.images.go], { env: hostEnv(), timeout: 180_000, maxBuffer: 64 * 1024 });
        const lines = stdout.split('\n').filter(Boolean), probe = Object.fromEntries(lines.map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
        if (lines.length !== 4 || !['available', 'limited', 'unavailable'].includes(probe.status) || !(probe.status === 'unavailable' ? probe.profile === 'none' : PROFILE.test(probe.profile)) || !/^[0-9A-Za-z.+~-]{1,32}$/.test(probe.version ?? '') || typeof probe.reason !== 'string') fail('malformed probe');
        current.version = probe.version;
        if (probe.status === 'unavailable') current.unavailable = `sandbox probe: ${probe.reason}`;
        else Object.assign(current, { status: probe.status, profile: probe.profile, reason: probe.reason || null });
      } catch { current.unavailable = 'sandbox probe failed'; }
      return diagnostic(current);
    },
  };
}
