import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Harness, createRegistry, AssistantEntry } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { RunDoc, reconcileCommit, snapshot } from './maintain.mjs';
import { installGitHubTools } from './github.mjs';

const ctx = BACKGROUND_CONTEXT;
async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'github-merge-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function fixture(t, responses, setup = async () => {}) {
  const dir = await scratch(t);
  const source = join(dir, 'source');
  const state = join(dir, 'state');
  await mkdir(source, { recursive: true });
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  git(source, 'init', '-q', '-b', 'main');
  git(source, 'config', 'user.name', 'test'); git(source, 'config', 'user.email', 'test@example.test');
  await writeFile(join(source, 'base.txt'), 'base\n');
  await mkdir(join(source, '.github'), { recursive: true }); await writeFile(join(source, '.github', 'protected'), 'original\n');
  await mkdir(join(source, 'tools/maintainer'), { recursive: true }); await writeFile(join(source, 'tools/maintainer', 'protected'), 'original\n');
  git(source, 'add', '.'); git(source, 'commit', '-qm', 'base');
  const base = git(source, 'rev-parse', 'HEAD');
  const upstream = join(dir, 'upstream');
  execFileSync('git', ['clone', '-q', source, upstream]);
  git(upstream, 'config', 'user.name', 'test'); git(upstream, 'config', 'user.email', 'test@example.test');
  await setup({ source, upstream, git, dir });
  const upstreamSha = git(upstream, 'rev-parse', 'HEAD');
  git(source, 'remote', 'add', 'upstream', upstream);
  git(source, 'fetch', '-q', 'upstream');
  const worktree = join(dir, 'worktree');
  execFileSync('git', ['-C', source, 'worktree', 'add', '-q', '-b', 'maintenance', worktree, base]);
  git(worktree, 'config', 'user.name', 'test'); git(worktree, 'config', 'user.email', 'test@example.test');
  const faux = fauxProvider(); faux.setResponses(responses);
  const models = createModels(); models.setProvider(faux.provider);
  const registry = createRegistry();
  const harness = await Harness.open(await openNodeSqliteStorage(join(dir, 'run.sqlite')), {
    models, registry, settings: { retry: { enabled: false, maxRetries: 0, baseDelayMs: 1000 } },
    env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? worktree, shellEnv: { PATH: process.env.PATH, HOME: dir, TMPDIR: tmpdir() } }),
  }, ctx);
  t.after(() => harness.close(ctx));
  const root = await harness.root(ctx);
  const extension = installGitHubTools(registry, { root, worktree, runDoc: RunDoc });
  await root.commit(async tx => {
    (await tx.doc(RunDoc, root.id)).run = { base, upstreamSha, upstreamRef: 'refs/heads/main', day: '2026-04-03' };
  }, ctx);
  await root.configure({ model: { provider: 'faux', modelId: 'faux-1' }, thinkingLevel: 'medium', extensions: [extension], cwd: worktree }, ctx);
  return { dir, source, upstream, worktree, git: (...args) => git(worktree, ...args), gitAt: git, base, upstreamSha, harness, root };
}
const callMerge = () => fauxAssistantMessage(fauxToolCall('merge_upstream', {}), { stopReason: 'toolUse' });
const end = () => fauxAssistantMessage('done');
async function invoke(f) {
  const req = `merge-test-${Math.random()}`;
  const settled = await (await f.root.submit({ type: 'input', requestId: req, content: 'Merge pinned upstream.' }, ctx)).wait(ctx);
  assert.equal(settled.status, 'done', JSON.stringify(settled));
  return f.root.commit(tx => tx.entry(AssistantEntry, settled.answer), ctx);
}
test('tool merges stored upstream pin despite remote gaining later commit, then reconcile commits both parents', async t => {
  const f = await fixture(t, [callMerge(), end()], async ({ upstream, git }) => {
    await writeFile(join(upstream, 'upstream.txt'), 'pinned\n'); git(upstream, 'add', '.'); git(upstream, 'commit', '-qm', 'pinned');
  });
  await writeFile(join(f.upstream, 'later.txt'), 'later\n'); f.gitAt(f.upstream, 'add', '.'); f.gitAt(f.upstream, 'commit', '-qm', 'later');
  await invoke(f);
  assert.equal(f.git('rev-parse', 'MERGE_HEAD'), f.upstreamSha);
  assert.throws(() => f.git('cat-file', '-e', 'HEAD:later.txt'));
  const result = { day: '2026-04-03', base: f.base, head: f.base, tree: f.git('write-tree'), diffHash: (await import('node:crypto')).createHash('sha256').update(`${f.git('diff', '--binary', 'HEAD')}\n`).digest('hex'), expectedParents: [f.base, f.upstreamSha] };
  const committed = await reconcileCommit(f.worktree, result);
  assert.deepEqual(f.git('show', '-s', '--format=%P', committed).split(' '), [f.base, f.upstreamSha]);
  assert.equal(await reconcileCommit(f.worktree, result), committed);
});
test('upstream protected additions and deletions restore exact base contents', async t => {
  const f = await fixture(t, [callMerge(), end()], async ({ upstream, git }) => {
    await writeFile(join(upstream, '.github', 'added'), 'no\n'); await writeFile(join(upstream, 'tools/maintainer', 'protected'), 'changed\n');
    await import('node:fs/promises').then(({ rm }) => rm(join(upstream, '.github', 'protected')));
    git(upstream, 'add', '-A'); git(upstream, 'commit', '-qm', 'protected changes');
  });
  await invoke(f);
  assert.equal(await readFile(join(f.worktree, '.github/protected'), 'utf8'), 'original\n');
  assert.equal(await readFile(join(f.worktree, 'tools/maintainer/protected'), 'utf8'), 'original\n');
  assert.equal(f.git('status', '--porcelain', '--', '.github', 'tools/maintainer'), '');
  assert.equal(f.git('rev-parse', 'MERGE_HEAD'), f.upstreamSha);
});
test('conflict is returned incomplete, preserving conflict evidence', async t => {
  const f = await fixture(t, [callMerge(), end()], async ({ upstream, git }) => {
    await writeFile(join(upstream, 'base.txt'), 'upstream\n'); git(upstream, 'add', '.'); git(upstream, 'commit', '-qm', 'conflict');
  });
  await writeFile(join(f.worktree, 'base.txt'), 'local\n');
  f.git('add', '.'); f.git('commit', '-qm', 'local');
  await f.root.commit(async tx => { (await tx.doc(RunDoc, f.root.id)).run.base = f.git('rev-parse', 'HEAD'); }, ctx);
  await invoke(f);
  assert.notEqual(f.git('diff', '--name-only', '--diff-filter=U'), '');
});
test('already-contained pin returns honest no-op without MERGE_HEAD', async t => {
  const f = await fixture(t, [callMerge(), end()]);
  await f.root.commit(async tx => { (await tx.doc(RunDoc, f.root.id)).run.upstreamSha = f.base; }, ctx);
  await invoke(f);
  assert.throws(() => f.git('rev-parse', '-q', '--verify', 'MERGE_HEAD'));
});
test('unchanged result tree retains an honest history merge rather than claiming no-op', async t => {
  const f = await fixture(t, [callMerge(), end()], async ({ upstream, git }) => {
    await writeFile(join(upstream, 'side.txt'), 'side\n'); git(upstream, 'add', '.'); git(upstream, 'commit', '-qm', 'side');
  });
  await invoke(f);
  assert.equal(f.git('rev-parse', 'MERGE_HEAD'), f.upstreamSha);
});
test('unchanged tree after protected restoration retains merge history for host commit', async t => {
  const f = await fixture(t, [callMerge(), end()], async ({ upstream, git }) => {
    await writeFile(join(upstream, '.github', 'added'), 'discarded\n'); git(upstream, 'add', '.'); git(upstream, 'commit', '-qm', 'protected only');
  });
  await invoke(f);
  assert.equal(f.git('write-tree'), f.git('rev-parse', `${f.base}^{tree}`));
  assert.equal(f.git('rev-parse', 'MERGE_HEAD'), f.upstreamSha);
  const current = await snapshot(f.worktree);
  const result = { day: '2026-04-03', base: f.base, head: f.base, tree: current.tree, diffHash: (await import('node:crypto')).createHash('sha256').update(current.diff).digest('hex'), expectedParents: [f.base, f.upstreamSha] };
  const commit = await reconcileCommit(f.worktree, result);
  assert.deepEqual(f.git('show', '-s', '--format=%P', commit).split(' '), [f.base, f.upstreamSha]);
});
test('nonconflict merge refusal leaves candidate incomplete and no MERGE_HEAD', async t => {
  const f = await fixture(t, [callMerge(), end()]);
  const unrelated = join(f.dir, 'unrelated'); await mkdir(unrelated);
  const git = (...args) => execFileSync('git', ['-C', unrelated, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.test');
  await writeFile(join(unrelated, 'other.txt'), 'other\n'); git('add', '.'); git('commit', '-qm', 'unrelated');
  f.gitAt(f.source, 'fetch', unrelated, 'main');
  const pin = f.gitAt(f.source, 'rev-parse', 'FETCH_HEAD');
  await f.root.commit(async tx => { (await tx.doc(RunDoc, f.root.id)).run.upstreamSha = pin; }, ctx);
  await invoke(f);
  assert.equal(f.git('rev-parse', 'HEAD'), f.base);
  assert.throws(() => f.git('rev-parse', '-q', '--verify', 'MERGE_HEAD'));
});
