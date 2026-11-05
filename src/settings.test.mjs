import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheDiff, orcaCommand, diffPluginKey } from './diff-cache.mjs';
import { preferences, defaults, linkUrl, findIssueLinks } from './preferences.mjs';
import { readConfiguration, changeConfiguration, readPreferences, savePreferences, settingsKey } from './repository-settings.mjs';
import { readHistory } from './git.mjs';
import activate from './worker.mjs';

const exec = promisify(execFile);
async function repo(t) {
  const path = await mkdtemp(join(tmpdir(), 'graph-settings-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const git = async (...args) => (await exec('git', ['-C', path, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } })).stdout.trim();
  await git('init', '-b', 'main'); await git('config', 'commit.gpgsign', 'false');
  const file = (name, value) => writeFile(join(path, name), value);
  const commit = async name => { await git('add', '--all'); await git('commit', '-m', name); return git('rev-parse', 'HEAD'); };
  return { path, git, file, commit };
}
function storage() { const data = new Map(); return { get: async key => data.get(key), set: async (key, value) => { data.set(key, value); } }; }

test('preferences validate issue rules, migrate legacy links and discard PR settings', () => {
  assert.deepEqual(preferences(), defaults);
  assert.deepEqual(preferences({ layout: 'compact', name: 'Old display name' }), { ...defaults, layout: 'compact' });
  assert.throws(() => preferences({ layout: 'unknown' }), /layout/);
  assert.throws(() => preferences({ showStashes: 'yes' }), /Invalid setting/);
  assert.throws(() => preferences({ initialBranch: '--all' }), /initial branch/);
  const rule = url => ({ issueLinks: [{ prefix: '#', url }] });
  assert.throws(() => preferences(rule('javascript:alert({issue})')), /HTTPS/);
  assert.throws(() => preferences(rule('https://user:secret@example.invalid/{issue}')), /credentials/);
  assert.throws(() => preferences(rule('https://example.invalid/issues/')), /must contain/);
  assert.throws(() => preferences(rule('https://example.invalid/{issue}/{oops}')), /Unknown URL/);
  assert.throws(() => preferences(rule('https://example.invalid/{issue}/{branch}')), /Unknown URL/);
  assert.throws(() => preferences(rule('https://example.invalid/{issue}/{')), /unmatched/);
  const url = 'https://example.invalid/issues/{issue}';
  assert.deepEqual(preferences({ issueUrl: url, pullRequestUrl: 'old', pullRequestBase: 'main' }).issueLinks, [{ prefix: '#', url }]);
  assert.equal('pullRequestUrl' in preferences({ pullRequestUrl: 'old' }), false);
  assert.deepEqual(preferences({ issueUrl: url, issueLinks: [] }).issueLinks, []);
  for (const value of [null, {}, 'invalid', Array.from({ length: 21 }, () => ({ prefix: '#', url }))]) assert.throws(() => preferences({ issueLinks: value }), /20 issue-link/);
  for (const prefix of ['', 'has space', '\u0000', 'x'.repeat(41)]) assert.throws(() => preferences({ issueLinks: [{ prefix, url }] }), /prefix/);
  assert.throws(() => preferences({ issueLinks: [{ prefix: '#', url }, { prefix: '#', url }] }), /different prefix/);
  assert.throws(() => preferences({ issueLinks: [{ prefix: '#', url: 123 }] }), /prefix and URL/);
  assert.equal(linkUrl(url, { issue: 'a&b' }), 'https://example.invalid/issues/a%26b');
});

test('issue links route literal prefixes, preserve text and reject partial identifiers', () => {
  const rules = preferences({ issueLinks: [
    { prefix: '#', url: 'https://example.invalid/issues/{issue}' },
    { prefix: 'PROJ-', url: 'https://tracker.invalid/PROJ-{issue}' },
    { prefix: '[x].', url: 'https://example.invalid/literal/{issue}' },
    { prefix: '##', url: 'https://example.invalid/double/{issue}' }
  ] }).issueLinks;
  const message = 'Fix #12, PROJ-9 and [x].4; ##8\nignore fooPROJ-2 #12word #4_5 proj-1 PROJ-3é. <img> #12';
  const found = findIssueLinks(message, rules);
  assert.deepEqual(found.map(item => item.text), ['#12', 'PROJ-9', '[x].4', '##8', '#12']);
  assert.equal(found[1].url, 'https://tracker.invalid/PROJ-9');
  assert.equal(found[2].url, 'https://example.invalid/literal/4');
  assert.equal(found[3].url, 'https://example.invalid/double/8');
  for (const item of found) assert.equal(message.slice(item.index, item.index + item.text.length), item.text);
  assert.deepEqual(findIssueLinks(message, []), []);
});

test('repository preferences persist independently and share nested-folder identity', async t => {
  const a = await repo(t), b = await repo(t), orca = { storage: storage() };
  await mkdir(join(a.path, 'nested'));
  assert.equal(await settingsKey(a.path), await settingsKey(join(a.path, 'nested')));
  await savePreferences(orca, a.path, { layout: 'compact', showTags: false });
  assert.equal((await readPreferences(orca, a.path)).layout, 'compact');
  assert.equal((await readPreferences(orca, b.path)).layout, 'flexible');
  await assert.rejects(savePreferences(orca, a.path, { diffView: 'bad' }), /diff location/);
  assert.equal((await readPreferences(orca, a.path)).showTags, false);
});

test('configuration requires confirmation and fresh state, edits only local identity and remotes', async t => {
  const r = await repo(t); await r.file('a', 'one\n'); await r.commit('root');
  let config = await readConfiguration(r.path);
  const change = async input => { config = await changeConfiguration(r.path, { confirmed: true, snapshot: config.snapshot, ...input }); return config; };
  const before = await r.git('status', '--porcelain');
  await assert.rejects(changeConfiguration(r.path, { action: 'identity', snapshot: config.snapshot }), /Confirm/);
  await assert.rejects(change({ action: 'identity', name: 'Tester', email: 'invalid' }), /email/);
  await change({ action: 'identity', name: 'Local Tester', email: 'local@example.invalid' });
  assert.equal(await r.git('config', '--local', 'user.name'), 'Local Tester');
  assert.equal(config.user.email, 'local@example.invalid');
  await assert.rejects(changeConfiguration(r.path, { action: 'identity-remove', confirmed: true, snapshot: 'old' }), /changed/);
  await change({ action: 'identity-remove' }); assert.equal(config.user.hasLocalName, false); assert.equal(config.user.hasLocalEmail, false);
  await assert.rejects(change({ action: 'remote-add', name: 'origin', fetchUrl: 'ext::evil' }), /helpers/);
  await assert.rejects(change({ action: 'remote-add', name: '-origin', fetchUrl: '/tmp/remote' }), /Remote names/);
  await change({ action: 'remote-add', name: 'origin', fetchUrl: 'https://example.invalid/repo.git', pushUrl: 'git@example.invalid:repo.git' });
  assert.deepEqual(config.remotes[0].pushUrls, ['git@example.invalid:repo.git']);
  await change({ action: 'remote-edit', name: 'origin', fetchUrl: '/tmp/local-remote', pushUrl: '' });
  assert.deepEqual(config.remotes[0].fetchUrls, ['/tmp/local-remote']); assert.deepEqual(config.remotes[0].pushUrls, []);
  await r.git('config', '--add', 'remote.origin.url', '/tmp/another'); config = await readConfiguration(r.path);
  await assert.rejects(change({ action: 'remote-edit', name: 'origin', fetchUrl: '/tmp/new' }), /multiple URLs/);
  await change({ action: 'remote-remove', name: 'origin' }); assert.equal(config.remotes.length, 0);
  assert.equal(await r.git('status', '--porcelain'), before);
});

test('history settings really select tags, stashes, first parents and reflog-only commits', async t => {
  const r = await repo(t); await r.file('base', 'root'); const root = await r.commit('root');
  await r.git('checkout', '--detach'); await r.file('tag-file', 'tag'); const tag = await r.commit('tag only'); await r.git('tag', 'only-tag'); await r.git('checkout', 'main');
  assert.ok((await readHistory(r.path)).commits.some(c => c.hash === tag));
  assert.ok(!(await readHistory(r.path, { showTags: false })).commits.some(c => c.hash === tag));
  assert.ok(!(await readHistory(r.path, { showTags: false })).refs.some(r => r.kind === 'tag'));
  await r.git('checkout', '-b', 'side'); await r.file('side', 'side'); const side = await r.commit('side'); await r.git('checkout', 'main');
  await r.file('main', 'main'); await r.commit('main'); await r.git('merge', '--no-ff', 'side', '-m', 'merge');
  const all = await readHistory(r.path, { ref: 'refs/heads/main' });
  const first = await readHistory(r.path, { ref: 'refs/heads/main', firstParent: true });
  assert.ok(all.commits.some(c => c.hash === side)); assert.ok(!first.commits.some(c => c.hash === side));
  await r.file('base', 'stashed'); await r.git('stash', 'push', '-m', 'saved'); const stash = await r.git('rev-parse', 'refs/stash');
  assert.ok(!(await readHistory(r.path)).commits.some(c => c.hash === stash));
  const withStash = await readHistory(r.path, { showStashes: true });
  assert.ok(withStash.commits.some(c => c.hash === stash)); assert.equal(withStash.refs.find(r => r.kind === 'stash').name, 'stash@{0}');
  assert.equal((await readHistory(r.path, { showStashes: true, ref: 'stash@{0}' })).commits[0].hash, stash);
  await r.git('checkout', '--detach', root); await r.file('lost', 'recoverable'); const lost = await r.commit('reflog only'); await r.git('checkout', 'main');
  assert.ok(!(await readHistory(r.path)).commits.some(c => c.hash === lost));
  assert.ok((await readHistory(r.path, { includeReflogs: true })).commits.some(c => c.hash === lost));
  assert.notEqual(all.snapshot, first.snapshot);
  await assert.rejects(readHistory(r.path, { firstParent: 'yes' }), /Invalid history/);
});

test('diff CLI discovery uses the running macOS bundle without relying on PATH', () => {
  const app = '/Volumes/Apps with spaces/Orca.app/Contents';
  const helper = app + '/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper';
  assert.equal(orcaCommand({ PATH: '/usr/bin:/bin' }, helper, 'darwin'), app + '/Resources/bin/orca');
  assert.equal(orcaCommand({}, app + '/MacOS/Orca', 'darwin'), app + '/Resources/bin/orca');
  assert.equal(orcaCommand({ ORCA_CLI_COMMAND: '/custom/orca' }, helper, 'darwin'), '/custom/orca');
  assert.equal(orcaCommand({ ORCA_DEV_REPO_ROOT: '/dev/orca' }, helper, 'darwin'), 'orca-dev');
  assert.equal(orcaCommand({}, '/usr/local/bin/node', 'darwin'), 'orca');
  assert.equal(orcaCommand({}, '/usr/bin/node', 'linux'), 'orca-ide');
  assert.equal(orcaCommand({}, 'C:/Orca/node.exe', 'win32'), 'orca');
});

test('cached diffs target the installed publisher and refuse ambiguous installations', () => {
  const plugin = key => ({ pluginKey: key, status: 'running', needsReconsent: false, customEditors: [{ id: 'git-graph-diff' }] });
  assert.equal(diffPluginKey([plugin('local.git-graph')]), 'local.git-graph');
  assert.equal(diffPluginKey([plugin('alice.git-graph')]), 'alice.git-graph');
  assert.equal(diffPluginKey([plugin('alice.git-graph'), { ...plugin('local.git-graph'), status: 'disabled' }]), 'alice.git-graph');
  assert.throws(() => diffPluginKey([plugin('local.git-graph'), plugin('alice.git-graph')]), /exactly one/);
  assert.throws(() => diffPluginKey([{ ...plugin('alice.git-graph'), needsReconsent: true }]), /exactly one/);
  assert.throws(() => diffPluginKey([plugin('alice.other-plugin')]), /exactly one/);
});

test('cache snapshots preserve exact committed and working diffs without dirtying repositories', async t => {
  const r = await repo(t), directory = await mkdtemp(join(tmpdir(), 'graph-diff-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = 'odd\tname.txt'; await r.file(file, 'old\n'); const root = await r.commit('root');
  await r.file(file, 'new\n'); const hash = await r.commit('change');
  const input = { hash, file };
  const first = await cacheDiff(r.path, input, undefined, directory);
  assert.equal((await stat(first)).mode & 0o777, 0o600);
  const value = JSON.parse(await readFile(first, 'utf8'));
  assert.match(value.text, /-old/); assert.match(value.text, /\+new/); assert.equal(value.file, file);
  assert.equal(first, await cacheDiff(r.path, input, undefined, directory));
  assert.equal(await r.git('status', '--porcelain'), '');
  await r.file(file, 'dirty\n'); const before = await r.git('status', '--porcelain');
  const working = await cacheDiff(r.path, { hash: 'working-tree', file }, undefined, directory);
  assert.match(JSON.parse(await readFile(working, 'utf8')).text, /\+dirty/);
  await r.file(file, 'changed again\n'); assert.equal(working, await cacheDiff(r.path, { hash: 'working-tree', file }, undefined, directory));
  assert.match(JSON.parse(await readFile(working, 'utf8')).text, /changed again/);
  assert.equal(await r.git('status', '--porcelain'), before);
  const rootFile = await cacheDiff(r.path, { hash: root, file }, undefined, directory); assert.match(JSON.parse(await readFile(rootFile, 'utf8')).text, /\+old/);
  await assert.rejects(cacheDiff(r.path, { hash, file: '../outside' }, undefined, directory), /Select a file/);
  await assert.rejects(cacheDiff(r.path, input, undefined, r.path), /outside/);
  await assert.rejects(cacheDiff(r.path, input, undefined, join(r.path, 'cache', 'nested')), /outside/);
  await assert.rejects(stat(join(r.path, 'cache')), { code: 'ENOENT' });
  const abort = new AbortController(); abort.abort(); await assert.rejects(cacheDiff(r.path, input, abort.signal, directory));
  await symlink(r.path, join(directory, 'redirect')); await assert.rejects(cacheDiff(r.path, input, undefined, join(directory, 'redirect')), /outside/);
  await assert.rejects(cacheDiff(r.path, input, undefined, join(directory, 'redirect', 'cache')), /outside/);
  await assert.rejects(stat(join(r.path, 'cache')), { code: 'ENOENT' });
});

test('new worker endpoints authorize workspace IDs and apply stored history settings', async t => {
  const r = await repo(t); await r.file('a', 'root'); await r.commit('root'); await r.git('tag', 'v1');
  const handlers = new Map();
  activate({ storage: storage(), panels: { handle: (name, fn) => handlers.set(name, fn) }, host: { call: async () => ({ workspaces: [{ id: 'local', path: r.path, hostId: 'local' }], truncated: false }) } });
  const call = (name, input) => handlers.get(name)(input, { signal: new AbortController().signal });
  for (const name of ['preferences', 'preferences-save', 'configuration', 'configuration-change', 'open-diff']) await assert.rejects(call(name, { workspaceId: 'unknown', path: r.path }), /no longer available/);
  await call('preferences-save', { workspaceId: 'local', path: '/evil', preferences: { showTags: false } });
  assert.equal((await call('preferences', { workspaceId: 'local' })).showTags, false);
  assert.equal((await call('history', { workspaceId: 'local', showTags: true })).refs.some(ref => ref.kind === 'tag'), false);
});
