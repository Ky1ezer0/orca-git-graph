import { mkdir, writeFile, rename, rm, realpath, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { platform } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { git, readDiff, readWorkingDiff } from './git.mjs';

const exec = promisify(execFile);
export async function cacheDiff(path, { hash, file }, signal) {
  const root = (await git(path, ['rev-parse', '--show-toplevel'], { signal })).replace(/\r?\n$/, '');
  const result = hash === 'working-tree' ? await readWorkingDiff(path, file, signal) : await readDiff(path, hash, file, signal);
  signal?.throwIfAborted();
  const actualRoot = await realpath(root);
  const cachePath = '.orca/git-graph-diffs/';
  if (await git(actualRoot, ['ls-files', '--', cachePath], { signal })) {
    throw new Error('The diff cache contains tracked files. Choose Inline in settings instead.');
  }
  // Reject redirected cache directories rather than writing snapshots outside this project.
  for (const directory of [join(actualRoot, '.orca'), resolve(actualRoot, cachePath)]) {
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!(await lstat(directory)).isDirectory()) throw new Error('The diff cache must use real directories, not symlinks.');
  }
  const actualDirectory = resolve(actualRoot, cachePath);
  // Git resolves info/exclude correctly for linked worktrees, too; never edit .gitignore.
  const excludePath = resolve(actualRoot, (await git(actualRoot, ['rev-parse', '--git-path', 'info/exclude'], { signal })).replace(/\r?\n$/, ''));
  await mkdir(dirname(excludePath), { recursive: true });
  const exclude = await open(excludePath, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try {
    if (!(await exclude.stat()).isFile()) throw new Error('Git info/exclude must be a regular file.');
    const contents = await exclude.readFile('utf8');
    const rule = '/' + cachePath;
    if (!contents.split(/\r?\n/).includes(rule)) await exclude.writeFile((contents && !contents.endsWith('\n') ? '\n' : '') + rule + '\n');
  } finally { await exclude.close(); }
  const key = createHash('sha256').update(JSON.stringify([actualRoot, hash, file])).digest('hex');
  const name = file.split('/').at(-1).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 70) || 'file';
  const target = resolve(actualDirectory, name + '-' + key.slice(0, 20) + '.git-graph-diff');
  if (!(await git(actualRoot, ['--no-literal-pathspecs', 'check-ignore', '--', target], { signal, allowMissing: true }))) {
    throw new Error('Git ignore rules expose the diff cache. Choose Inline in settings instead.');
  }
  signal?.throwIfAborted();
  const temporary = target + '.' + randomUUID() + '.tmp';
  const snapshot = { version: 1, repository: actualRoot, file, revision: hash, capturedAt: new Date().toISOString(), ...result };
  try {
    await writeFile(temporary, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    signal?.throwIfAborted();
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
  return target;
}

export function orcaCommand(env = process.env, executable = process.execPath, os = platform()) {
  if (env.ORCA_CLI_COMMAND) return env.ORCA_CLI_COMMAND;
  if (env.ORCA_DEV_REPO_ROOT) return 'orca-dev';
  // GUI workers may lack Orca on PATH; use the CLI bundled with their running app.
  const contents = os === 'darwin' && executable.match(/^(.*?\.app\/Contents)\/(?:MacOS|Frameworks)\//)?.[1];
  return contents ? join(contents, 'Resources', 'bin', 'orca') : os === 'linux' ? 'orca-ide' : 'orca';
}

export function diffPluginKey(plugins) {
  const matches = plugins.filter(plugin => plugin.pluginKey?.endsWith('.git-graph') &&
    ['running', 'idle'].includes(plugin.status) && !plugin.needsReconsent &&
    plugin.customEditors?.some(editor => editor.id === 'git-graph-diff'));
  if (matches.length !== 1) throw new Error('Enable exactly one Git Graph installation, then try again.');
  return matches[0].pluginKey;
}

export async function openCachedDiff(path, input, signal) {
  const target = await cacheDiff(path, input, signal);
  // shortcut: Orca has no historical diff host API; open our cache document through its supported CLI.
  const command = orcaCommand();
  try {
    const options = { signal, timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true };
    const listing = JSON.parse((await exec(command, ['plugin', 'list', '--json'], options)).stdout);
    if (!listing.ok) throw new Error(listing.error?.message || 'Could not find the installed Git Graph plugin.');
    const key = diffPluginKey(listing.result.plugins);
    const { stdout } = await exec(command, ['plugin', 'open', key, '--editor', target, '--json'], options);
    const result = JSON.parse(stdout);
    if (!result.ok) throw new Error(result.error?.message || 'Orca could not open the diff tab.');
  } catch (error) {
    let message = error.message;
    try { message = JSON.parse(error.stdout).error?.message || message; } catch {}
    throw new Error('Could not open the main-panel diff: ' + message + ' Choose Inline in settings to view it in the sidebar.');
  }
  return { opened: true, message: 'Opened read-only diff in the main panel. The snapshot is cached in .orca/git-graph-diffs/ and excluded from Git.' };
}
