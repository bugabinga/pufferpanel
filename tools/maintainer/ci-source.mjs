import { mkdir, readFile, writeFile, copyFile, rm, mkdtemp, readdir, lstat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { selectedTask, bindTask, readJSON, isSha, REF } from './task.mjs';
import { git, ancestor, verifyPRHistory, checkPR, checkBranchPolicy, githubRead, protectedPolicy } from './pr.mjs';
import { reportFor } from './report.mjs';
import { reviewFeedback } from './feedback.mjs';
import { validatePlan, executePlan } from './management.mjs';
const execFile = promisify(callback);
const here = dirname(fileURLToPath(import.meta.url));
export async function metadata(artifact, task, githubSha) {
  const raw = await readJSON(join(artifact, 'result.json'));
  for (const key of ['base', 'tree', 'commit', 'releaseCommit']) if (raw.sourceIdentity && raw[key] !== raw.sourceIdentity[key]) throw Error('inconsistent CI source metadata');
  const run = { ...raw, ...raw.sourceIdentity };
  if (!['publishing', 'managing'].includes(run.phase) || !/^\d{4}-\d{2}-\d{2}$/.test(run.day ?? '') || run.version !== run.day.split('-').map(Number).join('.') || !/^[1-9]\d*\.[1-9]\d*\.[1-9]\d*$/.test(run.version) || ![run.base, run.tree].every(isSha) || run.phase === 'publishing' && !isSha(run.commit) || run.base !== (task?.base ?? githubSha)) throw Error('invalid CI release metadata');
  bindTask(run, task);
  if (task?.kind === 'management' && run.phase !== 'managing') throw Error('management task cannot integrate source');
  if (run.phase === 'managing') {
    if (run.commit || run.releaseCommit) throw Error('management-only task cannot claim a source commit');
    run.expectedParents = [run.base];
  }
  run.expectedParents ??= [run.base];
  if (run.expectedParents.length < 1 || run.expectedParents.length > 2 || run.expectedParents[0] !== run.base || !run.expectedParents.every(isSha) || run.expectedParents.length === 2 && (!task || run.expectedParents[1] !== task.upstreamSha || run.trustedUpstreamPin !== task.upstreamSha) || run.taskKind === 'pr' && run.expectedParents.length !== 1) throw Error('invalid full ordered parents or trusted upstream pin');
  run.releaseCommit ??= run.commit;
  if (run.taskKind !== 'pr' && run.releaseCommit !== run.commit) throw Error('invalid actual source identity');
  return run;
}
export async function verifyCandidate(worktree, run, task) {
  const parents = (await git(worktree, 'show', '-s', '--format=%P', run.commit)).split(' ').filter(Boolean);
  if (parents.length !== run.expectedParents.length || parents.some((p, i) => p !== run.expectedParents[i]) || await git(worktree, 'rev-parse', 'HEAD') !== run.commit || await git(worktree, 'rev-parse', 'HEAD^{tree}') !== run.tree || await git(worktree, 'status', '--porcelain')) throw Error('candidate identity mismatch');
  if (await git(worktree, 'diff', '--name-only', run.base, run.commit, '--', 'tools/maintainer', '.github')) throw Error('candidate changed trusted harness or CI');
  if (run.taskKind === 'pr') await verifyPRHistory(worktree, task, run.tree);
}
export function allowedOld(cwd, run, old) {
  if (!isSha(old) || /^0+$/.test(old)) return Promise.resolve(false);
  if (run.taskKind !== 'pr') return Promise.resolve(old === run.base || old === run.commit);
  return Promise.all([ancestor(cwd, run.base, old), ancestor(cwd, old, run.releaseCommit)]).then(values => values.every(Boolean));
}
export async function pushSource(source, run, task, { fetchImpl = fetch, beforePush } = {}) {
  const origin = await git(source, 'remote', 'get-url', 'origin');
  const auth = ['-c', 'credential.helper=', '-c', 'credential.helper=!f() { printf "username=x-access-token\\npassword=%s\\n" "$GH_TOKEN"; }; f'];
  const remote = (await git(source, ...auth, 'ls-remote', origin, REF)).split(/\s/)[0];
  if (remote !== run.releaseCommit) {
    // Fetch advertised old objects only to prove permitted ancestry, never reset source.
    if (isSha(remote)) await git(source, ...auth, 'fetch', '--no-tags', origin, remote);
    if (!await allowedOld(source, run, remote)) throw Error('trunk advanced/deleted/rewound; refusing stale release or history overwrite');
    if (task?.kind === 'pr') await checkPR(task, { fetchImpl, token: process.env.GH_TOKEN });
    else if (task) await checkBranchPolicy({ fetchImpl, token: process.env.GH_TOKEN });
    const hooks = await mkdtemp(join(tmpdir(), 'annie-push-'));
    try {
      // Guard reads Git's push advertisement, not the earlier ls-remote result.
      // Git receive-pack additionally compares this old OID atomically server-side.
      const guard = `#!/usr/bin/env node\nimport fs from 'node:fs';import {execFileSync} from 'node:child_process';\nconst r=${JSON.stringify({ base: run.base, commit: run.commit, release: run.releaseCommit, observed: remote, pr: run.taskKind === 'pr' })};\nconst ancestor=(a,b)=>{try{execFileSync('git',['merge-base','--is-ancestor',a,b],{stdio:'ignore'});return true;}catch{return false;}};\nconst lines=fs.readFileSync(0,'utf8').trim().split('\\n');\nif(lines.length!==1)process.exit(1);\nconst [local,oid,ref,old]=lines[0].split(/\\s+/);\nif(ref!=='refs/heads/trunk'||oid!==r.release||!/^([a-f0-9]{40})$/.test(old)||/^0+$/.test(old)||(r.pr?!(ancestor(r.observed,old)&&ancestor(r.base,old)&&ancestor(old,r.release)):!(old===r.base||old===r.commit))) {console.error('advertised trunk changed/deleted/rewound');process.exit(1);}\n`;
      await writeFile(join(hooks, 'pre-push'), guard, { mode: 0o700 });
      await beforePush?.();
      await git(source, ...auth, '-c', `core.hooksPath=${hooks}`, 'push', origin, `${run.releaseCommit}:${REF}`);
    } finally { await rm(hooks, { recursive: true, force: true }); }
  }
  const actual = (await git(source, ...auth, 'ls-remote', origin, REF)).split(/\s/)[0];
  if (actual !== run.releaseCommit) throw Error('source persistence not verified');
  return { actualSource: actual, tree: run.tree };
}
export async function ciSource(command, env = process.env) {
  const source = resolve(env.PUFFER_MAINT_SOURCE), state = resolve(env.PUFFER_MAINT_STATE), artifact = resolve(env.HONEST_ANNIE_ARTIFACT);
  const task = selectedTask(env);
  if (env.GITHUB_ACTIONS === 'true' && ['push', 'management', 'feedback', 'authorize-publication', 'publish'].includes(command)) {
    if (env.HONEST_ANNIE_ENABLED !== 'true' || !task) throw Error('trusted effects disabled or task missing');
    const options = { token: env.GH_TOKEN };
    const branch = await githubRead('/branches/trunk', options);
    const rules = await githubRead('/rules/branches/trunk?per_page=100', options);
    if (branch.protected !== false || !Array.isArray(rules) || rules.length) throw Error('current effects policy blocks automation');
    const read = path => githubRead(path, options);
    const [original, current] = await Promise.all([protectedPolicy(read, task.base), protectedPolicy(read, branch.commit.sha)]);
    if (original !== current) throw Error('effects policy changed since original task');
  }
  if (command === 'feedback') {
    const raw = await readJSON(join(artifact, 'result.json'));
    const run = { ...raw, ...raw.sourceIdentity };
    const receipt = await reviewFeedback(run, task);
    const dir = join(state, 'runs', run.day); await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, 'action-receipts.json'), JSON.stringify([receipt]), { mode: 0o600 }); return;
  }
  if (command === 'export') {
    await mkdir(artifact, { recursive: true, mode: 0o700 });
    if ((await lstat(artifact)).isSymbolicLink()) throw Error('artifact directory must not be a symlink');
    const allowed = ['result.json', 'gate.ok', 'candidate.bundle', 'management.json'];
    for (const name of await readdir(artifact)) {
      if (!allowed.includes(name) || (await lstat(join(artifact, name))).isDirectory()) throw Error('unchecked file in gated artifact directory');
      await rm(join(artifact, name));
    }
    const raw = await readJSON(env.PUFFER_MAINT_RESULT);
    // Re-allowlist before export, never copy transcripts, raw plans, or logs.
    const safe = reportFor(raw);
    if (!raw.sourceIdentity && raw.expectedParents === undefined && isSha(raw.base)) safe.sourceIdentity.expectedParents = [raw.base];
    await writeFile(join(artifact, 'result.json'), JSON.stringify(safe), { mode: 0o600 });
    if (raw.phase === 'rejected') {
      if (task) bindTask({ ...safe, ...safe.sourceIdentity, releaseCommit: task.kind === 'pr' ? task.head : safe.releaseCommit }, task);
      await writeFile(env.GITHUB_OUTPUT, `candidate=false\nsourcecandidate=false\nmanagement=false\nfeedback=${task?.kind === 'pr' && safe.reason === 'review-rejected' && safe.findings.length > 0}\n`, { flag: 'a' }); return;
    }
    if (raw.phase === 'published' && raw.commit === null) {
      await writeFile(env.GITHUB_OUTPUT, 'candidate=false\n', { flag: 'a' }); return;
    }
  }
  const run = await metadata(artifact, task, env.GITHUB_SHA);
  const runDir = join(state, 'runs', run.day), worktree = join(state, 'worktree');
  const gateReceipt = async path => { if ((await readFile(path, 'utf8')).trim() !== run.tree) throw Error('clean, gated candidate required'); };
  if (command === 'export') {
    if (run.managementApproved) {
      const plan = await readJSON(join(runDir, 'management.json')); validatePlan(plan, run);
      await writeFile(join(artifact, 'management.json'), JSON.stringify(plan), { mode: 0o600 });
    }
    if (run.phase === 'publishing') {
      await verifyCandidate(worktree, run, task); await gateReceipt(join(runDir, 'gate.ok'));
      await copyFile(join(runDir, 'gate.ok'), join(artifact, 'gate.ok'));
      const refs = ['HEAD'];
      if (task?.kind === 'pr') { await git(worktree, 'update-ref', 'refs/maintainer/pr-head', task.head); refs.push('refs/maintainer/pr-head'); }
      await git(worktree, 'bundle', 'create', join(artifact, 'candidate.bundle'), ...refs, `^${run.base}`);
    }
    await writeFile(env.GITHUB_OUTPUT, `candidate=${run.phase === 'publishing'}\n${task ? `sourcecandidate=${run.phase === 'publishing'}\nmanagement=${Boolean(run.managementApproved)}\n` : ''}`, { flag: 'a' }); return;
  }
  if (command === 'management-check') {
    if (!run.managementApproved) throw Error('no approved management artifact');
    const actions = validatePlan(await readJSON(join(artifact, 'management.json')), run);
    await writeFile(env.GITHUB_OUTPUT, `adminAction=${actions.some(action => action.kind === 'enable-issues')}\n`, { flag: 'a' }); return;
  }
  if (command === 'management') {
    if (!run.managementApproved) throw Error('no approved management artifact');
    if (run.phase === 'managing') {
      if (await git(source, 'rev-parse', `${run.base}^{tree}`) !== run.tree) throw Error('management-only source tree changed');
      const remote = (await git(source, 'ls-remote', 'origin', REF)).split(/\s/)[0];
      if (remote !== run.base) throw Error('management-only source context is stale');
    }
    if (run.phase === 'publishing') {
      const proof = await readJSON(join(runDir, 'source.ok'));
      if (proof.actualSource !== run.releaseCommit || proof.tree !== run.tree) throw Error('source persistence required before management');
    }
    const receipts = await executePlan(await readJSON(join(artifact, 'management.json')), run);
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    await writeFile(join(runDir, 'action-receipts.json'), JSON.stringify(receipts), { mode: 0o600 });
    if (receipts.some(r => r.status === 'failed')) throw Error('management actions failed; inspect sanitized receipts');
    return;
  }
  if (run.phase !== 'publishing') throw Error('management-only task has no source candidate');
  if (command === 'import') {
    const checkout = await git(source, 'rev-parse', 'HEAD');
    if (checkout !== run.base && checkout !== run.releaseCommit) throw Error('trusted checkout is not candidate base or actual source');
    await git(source, 'bundle', 'verify', join(artifact, 'candidate.bundle'));
    await git(source, 'fetch', join(artifact, 'candidate.bundle'), 'HEAD:refs/heads/honest-annie-candidate', ...(task?.kind === 'pr' ? ['refs/maintainer/pr-head:refs/maintainer/pr-head'] : []));
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    await git(source, 'worktree', 'add', '--detach', worktree, run.commit);
    await verifyCandidate(worktree, run, task); await gateReceipt(join(artifact, 'gate.ok'));
    await rm(join(runDir, 'gate.ok'), { force: true }); return;
  }
  await verifyCandidate(worktree, run, task); await gateReceipt(join(artifact, 'gate.ok'));
  if (command === 'gate') { await execFile('bash', [join(here, 'gate.sh'), worktree, runDir], { env: { ...env, TMPDIR: tmpdir() } }); return; }
  try { await gateReceipt(join(runDir, 'gate.ok')); } catch { throw Error('independent release gate required'); }
  if (command === 'push') {
    const proof = await pushSource(source, run, task);
    await writeFile(join(runDir, 'source.ok'), JSON.stringify(proof), { mode: 0o600 }); return;
  }
  if (command === 'publish' || command === 'authorize-publication') {
    const proof = await readJSON(join(runDir, 'source.ok'));
    if (proof.actualSource !== run.releaseCommit || proof.tree !== run.tree) throw Error('source persistence required before publication');
    const remote = (await git(source, 'ls-remote', 'origin', REF)).split(/\s/)[0];
    if (remote !== run.releaseCommit) throw Error('actual source no longer on trunk');
    if (command === 'authorize-publication') return;
    const actual = join(state, 'release-worktree');
    try { await git(source, 'worktree', 'add', '--detach', actual, run.releaseCommit); } catch { if (await git(actual, 'rev-parse', 'HEAD') !== run.releaseCommit) throw Error('unexpected release checkout'); }
    if (await git(actual, 'rev-parse', 'HEAD^{tree}') !== run.tree || await git(actual, 'status', '--porcelain')) throw Error('actual release tree changed');
    await execFile('bash', [join(here, 'publish.sh'), actual, run.version, runDir], { env: { ...env, GH_TOKEN: '', GITHUB_TOKEN: '', ANNIE_GH_TOKEN: '', TMPDIR: tmpdir() }, maxBuffer: 1024 * 1024 }); return;
  }
  throw Error('unknown CI source command');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) ciSource(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
