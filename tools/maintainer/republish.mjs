// Model-free republish of reviewed source already persisted on trunk; never pushes Git refs.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { REF, isSha, versionFor } from './task.mjs';
import { git, ancestor, githubRead, protectedPolicy } from './pr.mjs';
const execFile = promisify(callback);
const here = dirname(fileURLToPath(import.meta.url));
const fail = reason => { throw Error(reason); };
export function republishPlan(raw) {
  let plan = null; try { plan = JSON.parse(raw ?? 'null'); } catch { /* invalid below */ }
  const day = typeof plan?.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(plan.day) && Number.isFinite(Date.parse(`${plan.day}T00:00:00Z`)) && new Date(`${plan.day}T00:00:00Z`).toISOString().slice(0, 10) === plan.day;
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) || Object.keys(plan).sort().join(',') !== 'day,releaseCommit,runId,version' || !Number.isSafeInteger(plan.runId) || plan.runId < 1 || !isSha(plan.releaseCommit) || !day || plan.version !== versionFor(plan.day) || !/^[1-9]\d*\.[1-9]\d*\.[1-9]\d*$/.test(plan.version)) fail('invalid republish plan');
  return plan;
}
async function reachable(source, commit) {
  const remote = (await git(source, 'ls-remote', 'origin', REF)).split(/\s/)[0];
  if (!isSha(remote)) fail('remote trunk unavailable');
  if (remote !== commit) await git(source, 'fetch', '--no-tags', 'origin', remote);
  if (!await ancestor(source, commit, remote)) fail('release commit not reachable from current trunk');
}
async function identity(worktree, plan) {
  if (await git(worktree, 'rev-parse', 'HEAD') !== plan.releaseCommit || await git(worktree, 'status', '--porcelain')) fail('republish worktree identity mismatch');
  return git(worktree, 'rev-parse', 'HEAD^{tree}');
}
async function report(env, dir) {
  if (!dir) fail('explicit report directory required');
  let plan = null; try { plan = republishPlan(env.ANNIE_REPUBLISH); } catch { /* reported below */ }
  let publicationDigest = null;
  if (plan) try {
    const runDir = join(resolve(env.PUFFER_MAINT_STATE), 'runs', plan.day), receipt = (await readFile(join(runDir, 'publish.ok'), 'utf8')).trim();
    const proof = Object.fromEntries((await readFile(join(runDir, 'remote-proof'), 'utf8')).trim().split(/\r?\n/).map(line => line.split('=')));
    if (receipt === plan.releaseCommit && proof.revision === receipt && proof.version === plan.version && /^sha256:[a-f0-9]{64}$/.test(proof.digest)) publicationDigest = proof.digest;
  } catch { /* publication not verified */ }
  const stage = (env.ANNIE_REPUBLISH_STAGES ?? '').split(',').map(item => item.split('=')).find(([name, outcome]) => outcome !== 'success');
  const reason = !plan ? 'invalid-republish-plan' : stage && /^[a-z]{1,16}$/.test(stage[0]) && ['failure', 'cancelled', 'skipped'].includes(stage[1]) ? `${stage[0]}-${stage[1]}` : 'publication-unverified';
  const value = { runId: plan?.runId ?? null, releaseCommit: plan?.releaseCommit ?? null, version: plan?.version ?? null, ...(publicationDigest ? { publicationDigest } : { reason }) };
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, 'report.json'), JSON.stringify(value), { mode: 0o600 });
  if (env.GITHUB_STEP_SUMMARY) await writeFile(env.GITHUB_STEP_SUMMARY, `## ☠️ Annie: republish ${publicationDigest ? 'verified' : 'failed'}\n\nNo model, no Git push; source was already on trunk.\n\nRun: ${value.runId ?? '?'}; source: ${value.releaseCommit ?? '?'}; version: ${value.version ?? '?'}; ${publicationDigest ? `digest: ${publicationDigest}` : `reason: ${reason}`}.\n`, { flag: 'a' });
  return value;
}
export async function republish(command, env = process.env, arg = null, { fetchImpl = fetch } = {}) {
  if (command === 'report') return report(env, arg);
  const plan = republishPlan(env.ANNIE_REPUBLISH);
  const source = resolve(env.PUFFER_MAINT_SOURCE), state = resolve(env.PUFFER_MAINT_STATE), worktree = join(state, 'republish-worktree'), runDir = join(state, 'runs', plan.day);
  if (env.GITHUB_ACTIONS === 'true' && command !== 'gate') {
    if (env.HONEST_ANNIE_ENABLED !== 'true') fail('trusted effects disabled');
    const read = path => githubRead(path, { token: env.GH_TOKEN, fetchImpl });
    const [branch, rules] = await Promise.all([read('/branches/trunk'), read('/rules/branches/trunk?per_page=100')]);
    if (branch.protected !== false || !Array.isArray(rules) || rules.length || !isSha(branch.commit?.sha)) fail('current effects policy blocks automation');
    // Executed harness comes only from the trusted checkout, which must equal current trunk policy; the persisted
    // release commit is build input and may carry an older harness.
    const [current, trusted] = await Promise.all([branch.commit.sha, env.GITHUB_SHA].map(commit => protectedPolicy(read, commit)));
    if (current !== trusted) fail('trusted checkout policy differs from current trunk');
  }
  await reachable(source, plan.releaseCommit);
  if (command === 'verify') {
    try { await git(source, 'worktree', 'add', '--detach', worktree, plan.releaseCommit); } catch { /* retained worktree verified below */ }
    await identity(worktree, plan); await mkdir(runDir, { recursive: true, mode: 0o700 }); return;
  }
  const tree = await identity(worktree, plan), tokenless = { ...env, GH_TOKEN: '', GITHUB_TOKEN: '', ANNIE_GH_TOKEN: '', TMPDIR: tmpdir() };
  if (command === 'gate') { await mkdir(runDir, { recursive: true, mode: 0o700 }); await execFile('bash', [join(here, 'gate.sh'), worktree, runDir], { env: tokenless, maxBuffer: 1024 * 1024 }); return; }
  if ((await readFile(join(runDir, 'gate.ok'), 'utf8').catch(() => '')).trim() !== tree) fail('independent republish gate required');
  if (command === 'authorize') return;
  if (command === 'publish') { await execFile('bash', [join(here, 'publish.sh'), worktree, plan.version, runDir], { env: tokenless, maxBuffer: 1024 * 1024 }); return; }
  fail('unknown republish command');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) republish(process.argv[2], process.env, process.argv[3]).catch(error => { console.error(error.message); process.exitCode = 1; });
