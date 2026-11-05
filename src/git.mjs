import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { devNull } from 'node:os';

const exec = promisify(execFile);
export const PAGE_SIZE = 200;
export const MAX_COMMITS = 2000;
const MAX_FILES = 1000;
const MAX_DIFF = 64000;

export function assertHash(hash) {
  if (typeof hash !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(hash)) {
    throw new Error('Invalid commit ID. Refresh the graph and select a commit again.');
  }
}

export async function git(path, args, { signal, allowMissing = false, diff = false, allowDiffExit = false, config = [], write = false } = {}) {
  // Inherited Git overrides must not redirect a selected workspace to another repository.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', LC_ALL: 'C', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' });
  try {
    const { stdout } = await exec('git', ['--no-pager', '--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', '-c', 'diff.submodule=short', '-c', 'diff.relative=false', '-c', 'color.ui=false', ...(write ? ['-c', 'core.hooksPath=' + devNull, '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'merge.autoStash=false', '-c', 'rebase.autoStash=false'] : []), ...config, '-C', path, ...args], {
      env, signal, timeout: write ? 90000 : 15000, maxBuffer: diff ? MAX_DIFF : 4 * 1024 * 1024, encoding: 'utf8', windowsHide: true
    });
    return diff ? { text: stdout, truncated: false } : stdout;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (diff && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return { text: String(error.stdout ?? '').slice(0, MAX_DIFF), truncated: true };
    }
    if (allowDiffExit && error.code === 1) return diff ? { text: String(error.stdout ?? ''), truncated: false } : String(error.stdout ?? '');
    if (allowMissing && error.code === 1) return '';
    if (error.code === 'ENOENT') throw new Error('Git is not available to Orca. Install Git and restart Orca.');
    if (error.killed) throw new Error(write ? 'Git timed out. Inspect repository status before retrying; an operation may still need recovery.' : 'Git took too long. Try a smaller branch, then refresh.');
    throw new Error(String(error.stderr || error.message).trim().slice(0, 800));
  }
}

export function parseLog(output) {
  if (!output) return [];
  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  if (fields.length % 5) throw new Error('Git returned an unreadable history record.');
  const commits = [];
  for (let i = 0; i < fields.length; i += 5) {
    const [hash, parents, author, date, subject] = fields.slice(i, i + 5);
    assertHash(hash);
    commits.push({ hash, parents: parents ? parents.split(' ') : [], author: author.slice(0, 200), date, subject: subject.slice(0, 500) });
  }
  return commits;
}

export function parseFiles(output) {
  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  const files = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++];
    const first = fields[i++];
    const renamed = /^[RC]/.test(status);
    const path = renamed ? fields[i++] : first;
    if (typeof path !== 'string') throw new Error('Git returned an unreadable file change.');
    files.push({ status: status[0], path, ...(renamed ? { oldPath: first } : {}) });
  }
  return files;
}

export function parseNumstat(output) {
  const stats = new Map(), records = output.split('\0');
  if (records.at(-1) === '') records.pop();
  for (let i = 0; i < records.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(records[i]);
    if (!match) throw new Error('Git returned unreadable line counts.');
    // --no-index uses the two-path NUL form even with rename detection off.
    const path = match[3] || records[i += 2];
    if (!path) throw new Error('Git returned unreadable line counts.');
    stats.set(path, { additions: match[1] === '-' ? null : Number(match[1]), deletions: match[2] === '-' ? null : Number(match[2]) });
  }
  return stats;
}

const statusArgs = ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--ignore-submodules=none'];
const diffOptions = ['--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=none'];
export function parseStatus(output) {
  const files = new Map();
  for (const record of output.split('\0').filter(Boolean)) {
    if (!/^[ MADRCUT?!]{2} [\s\S]+$/.test(record)) throw new Error('Git returned an unreadable working-tree status.');
    const xy = record.slice(0, 2), path = record.slice(3), untracked = xy === '??';
    const conflict = xy.includes('U') || xy === 'AA' || xy === 'DD';
    const file = { path, status: conflict ? 'U' : untracked ? 'A' : xy.includes('D') ? 'D' : xy.includes('A') ? 'A' : 'M', staged: !untracked && xy[0] !== ' ', unstaged: !untracked && xy[1] !== ' ', untracked, conflict };
    const prior = files.get(path);
    if (prior && (untracked || prior.untracked)) files.set(path, { ...file, status: 'M', staged: true, untracked: true, recreated: true });
    else files.set(path, file);
  }
  return [...files.values()];
}

async function workingConfig(path, signal) {
  // --no-textconv does not disable clean/process filters during working-tree reads.
  const names = await git(path, ['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'], { signal, allowMissing: true });
  const prefixes = new Set(names.split('\0').filter(Boolean).map(name => name.slice(0, name.lastIndexOf('.'))));
  return [...prefixes].flatMap(prefix => ['-c', prefix + '.clean=', '-c', prefix + '.smudge=', '-c', prefix + '.process=', '-c', prefix + '.required=false']);
}

async function workingStatus(path, signal) {
  return git(path, statusArgs, { signal, config: await workingConfig(path, signal) });
}

async function workingState(path, signal) {
  const root = (await git(path, ['rev-parse', '--show-toplevel'], { signal })).replace(/\r?\n$/, '');
  const config = await workingConfig(root, signal);
  const [raw, rawHead] = await Promise.all([
    git(root, statusArgs, { signal, config }),
    git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { signal, allowMissing: true })
  ]);
  const files = parseStatus(raw), head = rawHead.trim();
  // Hashing an empty tree without -w does not create objects or touch the index.
  const base = head || (await git(root, ['hash-object', '-t', 'tree', devNull], { signal })).trim();
  return { root, head, base, files, config };
}

async function untrackedKind(root, file) {
  if (!file || file.includes('\0') || isAbsolute(file)) throw new Error('Invalid file path.');
  const absolute = resolve(root, file), parent = await realpath(dirname(absolute));
  const rel = relative(await realpath(root), parent);
  if (rel === '..' || rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || isAbsolute(rel)) throw new Error('File is outside the selected repository.');
  const stat = await lstat(absolute);
  if (stat.isFile() || stat.isSymbolicLink()) return 'file';
  return stat.isDirectory() ? 'Directory (not expanded)' : 'Special file (not read)';
}

export async function readWorkingDetails(path, signal) {
  const { root, head, base, files, config } = await workingState(path, signal);
  const stats = parseNumstat(await git(root, ['diff', ...diffOptions, '--numstat', '-z', base, '--'], { signal, config }));
  const shown = files.slice(0, MAX_FILES).map(file => ({ ...file, ...(stats.get(file.path) || { additions: 0, deletions: 0 }) }));
  // Bound subprocess concurrency and never read ignored files or descend nested repositories.
  for (let i = 0; i < shown.length; i += 8) await Promise.all(shown.slice(i, i + 8).map(async file => {
    if (file.conflict) { Object.assign(file, { additions: null, deletions: null, countLabel: 'Unmerged' }); return; }
    if (!file.untracked) return;
    const kind = await untrackedKind(root, file.path);
    if (kind !== 'file') { Object.assign(file, { additions: null, deletions: null, countLabel: kind }); return; }
    const output = await git(root, ['diff', '--no-index', ...diffOptions, '--numstat', '-z', '--', devNull, file.path], { signal, config, allowDiffExit: true });
    const counts = [...parseNumstat(output).values()][0] || { additions: 0, deletions: 0 };
    if (file.recreated) {
      counts.additions = counts.additions === null || file.additions === null ? null : counts.additions + file.additions;
      counts.deletions = counts.deletions === null || file.deletions === null ? null : counts.deletions + file.deletions;
      file.countNote = 'Staged deletion plus untracked replacement; counts show both changes, not net lines.';
    }
    Object.assign(file, counts);
  }));
  return { workingTree: true, filtersDisabled: config.length > 0, head, files: shown, totalFiles: files.length, staged: files.filter(f => f.staged).length, unstaged: files.filter(f => f.unstaged).length, untracked: files.filter(f => f.untracked).length, conflicts: files.filter(f => f.conflict).length };
}

export async function readWorkingDiff(path, file, signal) {
  if (typeof file !== 'string' || file.includes('\0')) throw new Error('Invalid file path.');
  const { root, base, files, config } = await workingState(path, signal);
  const selected = files.slice(0, MAX_FILES).find(item => item.path === file);
  if (!selected) throw new Error('Select a currently changed file. Refresh if it changed.');
  if (selected.untracked) {
    const kind = await untrackedKind(root, file);
    if (kind !== 'file') return { text: kind + '. No textual diff.', truncated: false };
    const added = await git(root, ['diff', '--no-index', ...diffOptions, '--', devNull, file], { signal, config, diff: true, allowDiffExit: true });
    if (!selected.recreated) return added;
    const deleted = await git(root, ['diff', ...diffOptions, base, '--', file], { signal, config, diff: true });
    const text = deleted.text + added.text;
    return { text: text.slice(0, MAX_DIFF), truncated: deleted.truncated || added.truncated || text.length > MAX_DIFF, note: 'Staged deletion followed by untracked replacement.' };
  }
  return git(root, ['diff', ...diffOptions, base, '--', file], { signal, config, diff: true });
}

export async function readHistory(path, { offset = 0, ref = '', snapshot = '', showTags = true, showStashes = false, includeReflogs = false, firstParent = false, signal } = {}) {
  if (!Number.isInteger(offset) || offset < 0 || offset >= MAX_COMMITS || offset % PAGE_SIZE !== 0) throw new Error('Invalid history page.');
  if (typeof ref !== 'string' || typeof snapshot !== 'string') throw new Error('Invalid history filter.');
  if (![showTags, showStashes, includeReflogs, firstParent].every(value => typeof value === 'boolean')) throw new Error('Invalid history options.');
  await git(path, ['rev-parse', '--git-dir'], { signal });
  const [rawRefs, rawHead, branch, shallow, rawWorkingStatus] = await Promise.all([
    git(path, ['for-each-ref', '--format=%(objectname)%00%(*objectname)%00%(refname)%00%(symref)', 'refs/heads', 'refs/remotes', 'refs/tags'], { signal }),
    git(path, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { signal, allowMissing: true }),
    git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { signal, allowMissing: true }),
    git(path, ['rev-parse', '--is-shallow-repository'], { signal }),
    offset ? Promise.resolve(null) : workingStatus(path, signal)
  ]);
  const head = rawHead.trim();
  const refs = rawRefs.trimEnd().split('\n').filter(Boolean).map(line => {
    const [hash, peeled, name, symbolic] = line.split('\0');
    return { hash: peeled || hash, name, symbolic, label: name.replace(/^refs\/(heads|remotes|tags)\//, ''), kind: name.startsWith('refs/tags/') ? 'tag' : name.startsWith('refs/remotes/') ? 'remote' : 'branch' };
  }).filter(item => !item.symbolic && (showTags || item.kind !== 'tag'));
  const stashes = showStashes ? (await git(path, ['stash', 'list', '--format=%H%x00%gd'], { signal })).trimEnd().split('\n').filter(Boolean).map(line => { const [hash, name] = line.split('\0'); assertHash(hash); return { hash, name, label: name, kind: 'stash' }; }) : [];
  refs.push(...stashes);
  const reflog = includeReflogs ? await git(path, ['reflog', '--all', '--format=%H', '--max-count=2000'], { signal }) : '';
  if (ref && ref !== 'HEAD' && !refs.some(item => item.name === ref)) throw new Error('That reference no longer exists. Refresh the graph.');
  const { createHash } = await import('node:crypto');
  const currentSnapshot = createHash('sha256').update(rawRefs + rawHead + branch + JSON.stringify([showTags, showStashes, includeReflogs, firstParent, stashes, reflog])).digest('hex');
  let workingSnapshot;
  if (rawWorkingStatus !== null) {
    const root = (await git(path, ['rev-parse', '--show-toplevel'], { signal })).trimEnd();
    const stamps = await Promise.all(parseStatus(rawWorkingStatus).slice(0, MAX_FILES).map(async file => {
      try { const stat = await lstat(resolve(root, file.path)); return [file.path, stat.mtimeMs, stat.ctimeMs, stat.size]; }
      catch (error) { if (error.code === 'ENOENT') return [file.path, 'missing']; throw error; }
    }));
    workingSnapshot = createHash('sha256').update(rawWorkingStatus + JSON.stringify(stamps)).digest('hex');
  }
  if (offset && snapshot !== currentSnapshot) throw new Error('History changed while you were browsing. Refresh before loading more commits.');
  const revisions = ref ? (ref === 'HEAD' && !head ? [] : [ref]) : ['--branches', '--remotes', ...(showTags ? ['--tags'] : []), ...(head ? ['HEAD'] : []), ...stashes.map(stash => stash.hash), ...(includeReflogs ? ['--reflog'] : [])];
  const raw = revisions.length && (head || refs.length || reflog) ? await git(path, ['log', ...(firstParent ? ['--first-parent'] : []), '--topo-order', '-z', '--format=%H%x00%P%x00%an%x00%aI%x00%s', '--max-count=' + (PAGE_SIZE + 1), '--skip=' + offset, ...revisions, '--'], { signal }) : '';
  const all = parseLog(raw);
  // shortcut: keep at most 2,000 rows in the DOM; add virtualization for larger browsing sessions.
  return { workingSnapshot, ...(rawWorkingStatus === null ? {} : { workingTree: { totalFiles: parseStatus(rawWorkingStatus).length } }), commits: all.slice(0, PAGE_SIZE), refs: refs.slice(0, 2000), refsTruncated: refs.length > 2000, head, branch: branch.trim(), shallow: shallow.trim() === 'true', snapshot: currentSnapshot, hasMore: all.length > PAGE_SIZE && offset + PAGE_SIZE < MAX_COMMITS, limited: all.length > PAGE_SIZE && offset + PAGE_SIZE >= MAX_COMMITS };
}

export async function readDetails(path, hash, signal) {
  assertHash(hash);
  const raw = await git(path, ['show', '-s', '--format=%H%x00%P%x00%an%x00%aI%x00%ae%x00%cn%x00%ce%x00%B', hash, '--'], { signal });
  const [id, parentText, author, date, authorEmail, committer, committerEmail, ...message] = raw.split('\0');
  assertHash(id);
  const parents = parentText ? parentText.split(' ') : [];
  const comparison = parents.length ? [parents[0], hash] : [hash];
  const args = ['diff-tree', '--root', '--no-commit-id', '-r', '-z', '--no-renames', '--no-ext-diff', '--no-textconv'];
  const [changed, counts] = await Promise.all([
    git(path, [...args, '--name-status', ...comparison, '--'], { signal }),
    git(path, [...args, '--numstat', ...comparison, '--'], { signal })
  ]);
  const stats = parseNumstat(counts);
  const files = parseFiles(changed).map(file => ({ ...file, ...stats.get(file.path) }));
  return { hash: id, parents, author: author.slice(0, 200), date, authorEmail: authorEmail.slice(0, 200), committer: committer.slice(0, 200), committerEmail: committerEmail.slice(0, 200), message: message.join('\0').trimEnd().slice(0, 16000), files: files.slice(0, MAX_FILES), totalFiles: files.length };
}

export async function readDiff(path, hash, file, signal) {
  if (typeof file !== 'string' || file.includes('\0')) throw new Error('Invalid file path.');
  const details = await readDetails(path, hash, signal);
  if (!details.files.some(item => item.path === file)) throw new Error('Select a file changed in this commit.');
  const args = details.parents.length ? ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', details.parents[0], hash] : ['show', '--format=', '--root', '--no-ext-diff', '--no-textconv', '--no-renames', hash];
  // diff-tree paths are repository-relative, even when Orca opened a nested folder.
  const root = (await git(path, ['rev-parse', '--show-toplevel'], { signal })).replace(/\r?\n$/, '');
  return git(root, [...args, '--', file], { signal, diff: true });
}
