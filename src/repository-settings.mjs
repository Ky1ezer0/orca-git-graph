import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { git } from './git.mjs';
import { withRepositoryLock } from './actions.mjs';
import { preferences } from './preferences.mjs';

export async function settingsKey(path) {
  const root = await realpath((await git(path, ['rev-parse', '--show-toplevel'])).replace(/\r?\n$/, ''));
  return 'repository.' + createHash('sha256').update(root).digest('hex');
}
async function config(path, key, local = false) {
  return (await git(path, ['config', ...(local ? ['--local'] : []), '--null', '--get-all', key], { allowMissing: true })).split('\0').filter(Boolean);
}
export async function readConfiguration(path) {
  const [name, email, localName, localEmail, rawRemotes] = await Promise.all([
    config(path, 'user.name'), config(path, 'user.email'), config(path, 'user.name', true), config(path, 'user.email', true), git(path, ['remote'])
  ]);
  const names = rawRemotes.trim().split('\n').filter(Boolean);
  if (names.length > 50) throw new Error('Settings supports up to 50 remotes. Edit this repository’s Git configuration outside Git Graph.');
  const remotes = await Promise.all(names.map(async name => {
    const [fetchUrls, pushUrls] = await Promise.all([config(path, 'remote.' + name + '.url', true), config(path, 'remote.' + name + '.pushurl', true)]);
    return { name, fetchUrls, pushUrls };
  }));
  const result = { user: { name: name.at(-1) || '', email: email.at(-1) || '', localName: localName.at(-1) || '', localEmail: localEmail.at(-1) || '', hasLocalName: localName.length > 0, hasLocalEmail: localEmail.length > 0 }, remotes };
  return { ...result, snapshot: createHash('sha256').update(JSON.stringify(result)).digest('hex') };
}
function text(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Enter a valid ' + label + '.');
  return value.trim();
}
function remoteUrl(value) {
  const url = text(value, 'remote URL', 2048);
  if (url.startsWith('-') || url.includes('::') || !(/^(https?|ssh|git|file):\/\//.test(url) || /^[\w.-]+@[\w.-]+:.+/.test(url) || url.startsWith('/') || /^[A-Za-z]:[\\/]/.test(url))) throw new Error('Use an HTTP(S), SSH, Git, file URL, SCP address, or absolute local path. Remote helpers are not accepted.');
  return url;
}
export async function changeConfiguration(path, input) {
  if (input.confirmed !== true) throw new Error('Confirm this repository configuration change first.');
  return withRepositoryLock(path, async () => {
    const current = await readConfiguration(path);
    if (current.snapshot !== input.snapshot) throw new Error('Repository configuration changed. Reopen settings and try again.');
    if (input.action === 'identity') {
      const name = text(input.name, 'user name'), email = text(input.email, 'email');
      if (!/^[^\s<>@]+@[^\s<>@]+$/.test(email)) throw new Error('Enter a valid email address.');
      await git(path, ['config', '--local', '--replace-all', 'user.name', name], { write: true });
      await git(path, ['config', '--local', '--replace-all', 'user.email', email], { write: true });
    } else if (input.action === 'identity-remove') {
      if (current.user.hasLocalName) await git(path, ['config', '--local', '--unset-all', 'user.name'], { write: true });
      if (current.user.hasLocalEmail) await git(path, ['config', '--local', '--unset-all', 'user.email'], { write: true });
    } else if (['remote-add', 'remote-edit', 'remote-remove'].includes(input.action)) {
      const name = text(input.name, 'remote name', 100);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error('Remote names must use letters, numbers, dot, dash or underscore.');
      const existing = current.remotes.find(r => r.name === name);
      if (input.action === 'remote-add' ? !!existing : !existing) throw new Error('The remote changed. Reopen settings.');
      if (input.action === 'remote-remove') await git(path, ['remote', 'remove', name], { write: true });
      else {
        if (existing && (existing.fetchUrls.length !== 1 || existing.pushUrls.length > 1)) throw new Error('This remote has multiple URLs or inherited configuration. Edit it outside Git Graph to preserve all values.');
        const fetchUrl = remoteUrl(input.fetchUrl), pushUrl = input.pushUrl ? remoteUrl(input.pushUrl) : '';
        if (input.action === 'remote-add') await git(path, ['remote', 'add', name, fetchUrl], { write: true });
        else await git(path, ['remote', 'set-url', name, fetchUrl], { write: true });
        if (pushUrl) await git(path, ['config', '--local', '--replace-all', 'remote.' + name + '.pushurl', pushUrl], { write: true });
        else if (existing?.pushUrls.length) await git(path, ['config', '--local', '--unset-all', 'remote.' + name + '.pushurl'], { write: true });
      }
    } else throw new Error('Unsupported repository configuration action.');
    return readConfiguration(path);
  });
}
export async function readPreferences(orca, path) {
  return preferences(await orca.storage.get(await settingsKey(path)) || {});
}
export async function savePreferences(orca, path, value) {
  const validated = preferences(value);
  await orca.storage.set(await settingsKey(path), validated);
  return validated;
}
