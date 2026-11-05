import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAction, operationState } from './actions.mjs';
import { readHistory } from './git.mjs';
const exec = promisify(execFile);
async function repo(t) {
  const path = await mkdtemp(join(tmpdir(), 'graph-actions-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const git = async (...args) => (await exec('git', ['-C', path, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Graph Test'); await git('config', 'user.email', 'test@example.invalid');
  await git('config', 'commit.gpgsign', 'false');
  const file = (name, value) => writeFile(join(path, name), value);
  const commit = async (name, value = name) => { await file(name, value); await git('add', '--all'); await git('commit', '-m', name); return git('rev-parse', 'HEAD'); };
  const act = async (action, data = {}) => { const h = await readHistory(path); return runAction(path, { action, hash: h.head, expectedHead: h.head, expectedBranch: h.branch, confirmed: true, ...data }); };
  return { path, git, file, commit, act };
}
test('actions validate confirmation, stale state, names and dirty work before changing Git', async t => {
  const r = await repo(t); const root = await r.commit('root');
  await assert.rejects(r.act('unknown'), /Unsupported/);
  await assert.rejects(r.act('reset', { confirmed: false }), /Confirm/);
  await assert.rejects(r.act('reset', { expectedHead: '0'.repeat(40) }), /changed/);
  await assert.rejects(r.act('reset', { expectedBranch: 'wrong' }), /changed/);
  await assert.rejects(r.act('tag', { name: '--bad' }), /valid/);
  await assert.rejects(r.act('tag', { name: 'bad..name' }));
  await assert.rejects(r.act('branch', { name: 'HEAD' }), /valid/);
  await assert.rejects(r.act('checkout', { hash: '--bad' }), /Invalid commit/);
  await r.act('tag', { name: 'release' }); await r.act('branch', { name: 'feature/test' });
  assert.equal(await r.git('rev-parse', 'release'), root);
  assert.equal(await r.git('rev-parse', 'feature/test'), root);
  await assert.rejects(r.act('tag', { name: 'release' }), /already exists/);
  await r.file('untracked', 'precious');
  for (const action of ['checkout', 'cherry-pick', 'revert', 'drop', 'merge', 'rebase', 'reset']) await assert.rejects(r.act(action, { mode: 'hard' }), /Commit or stash/);
  assert.equal(await readFile(join(r.path, 'untracked'), 'utf8'), 'precious');
  assert.equal(await r.git('rev-parse', 'HEAD'), root);
});
test('checkout detaches, reset modes preserve their intended index/worktree state', async t => {
  for (const mode of ['soft', 'mixed', 'hard']) {
    const r = await repo(t); const root = await r.commit('root'); const tip = await r.commit('second');
    await r.act('reset', { hash: root, mode }); assert.equal(await r.git('rev-parse', 'HEAD'), root);
    assert.equal(await r.git('diff', '--cached', '--name-only'), mode === 'soft' ? 'second' : '');
    if (mode === 'hard') await assert.rejects(readFile(join(r.path, 'second')), /ENOENT/);
    else assert.equal(await readFile(join(r.path, 'second'), 'utf8'), 'second');
    await r.git('reset', '--hard', tip); await r.act('checkout', { hash: root });
    assert.equal((await readHistory(r.path)).branch, '');
    await assert.rejects(r.act('reset', { mode: 'hard' }), /detached/);
  }
});
test('cherry-pick, revert and merge create correct history without running hooks or signing', async t => {
  const r = await repo(t); await r.commit('root'); await r.git('checkout', '-b', 'feature');
  const feature = await r.commit('feature-file'); await r.git('checkout', 'main');
  await writeFile(join(r.path, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  await r.git('config', 'core.hooksPath', join(r.path, '.git', 'hooks')); await r.git('config', 'commit.gpgsign', 'true');
  await r.act('cherry-pick', { hash: feature }); assert.equal(await readFile(join(r.path, 'feature-file'), 'utf8'), 'feature-file');
  await r.act('revert'); await assert.rejects(readFile(join(r.path, 'feature-file')), /ENOENT/);
  await r.git('config', 'commit.gpgsign', 'false'); await r.git('config', 'core.hooksPath', '/dev/null');
  await r.git('checkout', 'feature'); const next = await r.commit('next'); await r.git('checkout', 'main');
  await r.act('merge', { hash: next });
  assert.equal((await r.git('show', '-s', '--format=%P', 'HEAD')).split(' ').length, 2);
  await assert.rejects(r.act('revert', { mainline: 0 }), /mainline/);
  await r.act('revert', { mainline: 1 }); await assert.rejects(readFile(join(r.path, 'next')), /ENOENT/);
});
test('rebase and drop replay linear commits and reject root drops', async t => {
  const r = await repo(t); const root = await r.commit('root');
  await r.git('checkout', '-b', 'feature'); const feature = await r.commit('feature');
  await r.git('checkout', 'main'); await r.commit('dropped'); const last = await r.commit('last');
  await r.act('rebase', { hash: feature });
  assert.equal(await r.git('merge-base', 'HEAD', feature), feature);
  assert.notEqual(await r.git('rev-parse', 'HEAD'), last);
  const rewrittenDrop = await r.git('rev-parse', 'HEAD~1');
  await r.act('drop', { hash: rewrittenDrop });
  await assert.rejects(readFile(join(r.path, 'dropped')), /ENOENT/);
  assert.equal(await readFile(join(r.path, 'last'), 'utf8'), 'last');
  await r.act('drop'); assert.equal(await r.git('rev-parse', 'HEAD'), feature);
  await assert.rejects(r.act('drop', { hash: root }), /non-root/);
});
test('conflicted actions expose recovery, block other writes, then abort or continue', async t => {
  const r = await repo(t); await r.commit('file', 'base\n');
  await r.git('checkout', '-b', 'feature'); const feature = await r.commit('file', 'feature\n');
  await r.git('checkout', 'main'); const main = await r.commit('file', 'main\n');
  await assert.rejects(r.act('cherry-pick', { hash: feature })); assert.equal(await operationState(r.path), 'cherry-pick');
  await assert.rejects(r.act('tag', { name: 'blocked' }), /Finish or abort/);
  await assert.rejects(r.act('abort', { operation: 'merge' }), /operation changed/);
  await r.act('abort', { operation: 'cherry-pick' }); assert.equal(await r.git('rev-parse', 'HEAD'), main);
  await assert.rejects(r.act('merge', { hash: feature })); assert.equal(await operationState(r.path), 'merge');
  await r.file('file', 'resolved\n'); await r.git('add', 'file'); await r.act('continue', { operation: 'merge' });
  assert.equal(await operationState(r.path), ''); assert.equal((await r.git('show', '-s', '--format=%P', 'HEAD')).split(' ').length, 2);
});
test('fetch updates remote refs without confirmation, merging, or changing dirty files', async t => {
  const remote = await repo(t); const base = await remote.commit('base');
  const r = await repo(t); await r.git('remote', 'add', 'origin', remote.path); await r.git('fetch', 'origin'); await r.git('checkout', '-B', 'main', '--track', 'origin/main');
  const next = await remote.commit('upstream');
  await r.file('dirty', 'keep this');
  await runAction(r.path, { action: 'fetch' });
  assert.equal(await r.git('rev-parse', 'origin/main'), next);
  assert.equal(await r.git('rev-parse', 'HEAD'), base);
  assert.equal(await readFile(join(r.path, 'dirty'), 'utf8'), 'keep this');
  const local = await r.commit('local'); const diverged = await remote.commit('diverged');
  await r.act('fetch', { confirmed: false });
  assert.equal(await r.git('rev-parse', 'origin/main'), diverged);
  assert.equal(await r.git('rev-parse', 'HEAD'), local);
  await r.git('checkout', '--detach'); await r.act('fetch', { confirmed: false });
  assert.equal((await readHistory(r.path)).branch, '');
});
test('working snapshots detect repeated edits without status or HEAD changes', async t => {
  const r = await repo(t); await r.commit('file'); await r.file('file', 'first');
  const a = await readHistory(r.path); await r.file('file', 'second and longer'); const b = await readHistory(r.path);
  assert.equal(a.snapshot, b.snapshot); assert.notEqual(a.workingSnapshot, b.workingSnapshot);
});

test('concurrent mutations serialize and failed actions release the repository lock', async t => {
  const r = await repo(t); const head = await r.commit('root');
  const input = { action: 'tag', name: 'one', hash: head, expectedHead: head, expectedBranch: 'main', confirmed: true };
  const results = await Promise.allSettled([runAction(r.path, input), runAction(r.path, { ...input, name: 'two' })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /Another Git action/);
  await assert.rejects(r.act('reset', { mode: 'invalid' }), /Choose soft/);
  await r.act('branch', { name: 'after-failure' });
  await assert.rejects(r.act('fetch'), /No remotes/);
});
test('rebase conflicts can be continued or aborted', async t => {
  const r = await repo(t); await r.commit('file', 'base');
  await r.git('checkout', '-b', 'feature'); const feature = await r.commit('file', 'feature');
  await r.git('checkout', 'main'); const original = await r.commit('file', 'main');
  await assert.rejects(r.act('rebase', { hash: feature })); assert.equal(await operationState(r.path), 'rebase');
  await r.act('abort', { operation: 'rebase' }); assert.equal(await r.git('rev-parse', 'HEAD'), original);
  await assert.rejects(r.act('rebase', { hash: feature })); await r.file('file', 'resolved'); await r.git('add', 'file');
  await r.act('continue', { operation: 'rebase' }); assert.equal(await operationState(r.path), '');
  assert.equal((await readHistory(r.path)).branch, 'main');
});
