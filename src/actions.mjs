import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { git, assertHash } from './git.mjs';

const active = new Set();
const actions = new Set(['tag', 'branch', 'checkout', 'cherry-pick', 'revert', 'drop', 'merge', 'rebase', 'reset', 'fetch', 'continue', 'abort']);

export async function operationState(path) {
  for (const [marker, operation] of [['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'], ['MERGE_HEAD', 'merge']]) {
    const location = (await git(path, ['rev-parse', '--git-path', marker])).trimEnd();
    try { await lstat(resolve(path, location)); return operation; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return '';
}

export async function runAction(path, input) {
  if (!input || !actions.has(input.action)) throw new Error('Unsupported Git action.');
  if (input.action !== 'fetch' && input.confirmed !== true) throw new Error('Confirm this Git action first.');
  return withRepositoryLock(path, async () => {
    if (input.action === 'fetch') {
      if (!(await git(path, ['remote'])).trim()) throw new Error('No remotes configured for this repository.');
      await git(path, ['fetch', '--all', '--no-prune', '--no-prune-tags', '--no-recurse-submodules'], { write: true });
      return { message: 'Fetched remotes. Your branch and working files are unchanged.' };
    }
    const head = (await git(path, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { allowMissing: true })).trim();
    const branch = (await git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowMissing: true })).trim();
    if (input.expectedHead !== head || input.expectedBranch !== branch) throw new Error('HEAD or branch changed. Refresh and confirm the action again.');
    const operation = await operationState(path);
    const { action, hash } = input;
    if (action === 'continue' || action === 'abort') {
      if (!operation || input.operation !== operation) throw new Error('The in-progress operation changed. Refresh before continuing.');
      if (action === 'continue' && operation === 'merge') await git(path, ['commit', '--no-edit'], { write: true });
      else await git(path, [operation, '--' + action], { write: true });
      return { message: operation + ' ' + (action === 'abort' ? 'aborted.' : 'continued.') };
    }
    if (operation) throw new Error('Finish or abort the current ' + operation + ' before starting another action.');
    {
      assertHash(hash);
      const resolved = (await git(path, ['rev-parse', '--verify', hash + '^{commit}'])).trim();
      if (resolved !== hash.toLowerCase()) throw new Error('Select a commit, not another Git object.');
    }
    if (action === 'tag' || action === 'branch') {
      const name = input.name;
      if (typeof name !== 'string' || !name || name.startsWith('-') || name === 'HEAD' || name.length > 200 || name.includes('\0')) throw new Error('Enter a valid ' + action + ' name.');
      await git(path, ['check-ref-format', 'refs/' + (action === 'tag' ? 'tags/' : 'heads/') + name]);
      await git(path, action === 'tag' ? ['tag', '--no-sign', '--', name, hash] : ['branch', '--', name, hash], { write: true });
      return { message: (action === 'tag' ? 'Tag' : 'Branch') + ' created.' };
    }
    // Refuse dirty worktrees even for hard reset: never silently destroy uncommitted work.
    if (await git(path, ['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('Commit or stash all local changes before this action.');
    if (['merge', 'rebase', 'reset', 'drop'].includes(action) && !branch) throw new Error('Check out a local branch first; HEAD is detached.');
    let args;
    if (action === 'checkout') args = ['checkout', '--detach', hash];
    else if (action === 'merge') args = ['merge', '--no-edit', '--no-autostash', hash];
    else if (action === 'rebase') args = ['rebase', '--rebase-merges', '--no-update-refs', '--no-autostash', hash];
    else if (action === 'reset') {
      if (!['soft', 'mixed', 'hard'].includes(input.mode)) throw new Error('Choose soft, mixed, or hard reset.');
      args = ['reset', '--' + input.mode, hash];
    } else if (action === 'drop') {
      const parents = (await git(path, ['show', '-s', '--format=%P', hash])).trim().split(' ').filter(Boolean);
      if (parents.length !== 1) throw new Error('Drop requires a non-root, non-merge commit.');
      await git(path, ['merge-base', '--is-ancestor', hash, 'HEAD']);
      if ((await git(path, ['rev-list', '--merges', hash + '..HEAD'])).trim()) throw new Error('Drop across merge history is not supported; use an interactive rebase outside Git Graph.');
      args = hash === head ? ['reset', '--hard', parents[0]] : ['rebase', '--no-update-refs', '--no-autostash', '--onto', parents[0], hash];
    } else {
      const parents = (await git(path, ['show', '-s', '--format=%P', hash])).trim().split(' ').filter(Boolean);
      const mainline = parents.length > 1 ? input.mainline : undefined;
      if (parents.length > 1 && (!Number.isInteger(mainline) || mainline < 1 || mainline > parents.length)) throw new Error('Choose a valid mainline parent for this merge commit.');
      args = [action, ...(action === 'revert' ? ['--no-edit'] : []), ...(mainline ? ['-m', String(mainline)] : []), hash];
    }
    await git(path, args, { write: true });
    return { message: 'Git action completed.' };
  });
}

export async function withRepositoryLock(path, run) {
  const common = (await git(path, ['rev-parse', '--git-common-dir'])).trimEnd();
  const key = await realpath(resolve(path, common));
  if (active.has(key)) throw new Error('Another Git action is running in this repository.');
  active.add(key);
  try {
    return await run();
  } finally { active.delete(key); }
}

