import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHistory, readDetails, readDiff, parseLog, parseFiles, parseNumstat, assertHash, readWorkingDetails, readWorkingDiff, parseStatus } from './git.mjs';
import { layoutGraph, edgePath, graphPaths } from './graph.mjs';
import activate from './worker.mjs';

const exec = promisify(execFile);
async function repo(t) {
  const path = await mkdtemp(join(tmpdir(), 'orca-git-graph-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const git = async (...args) => (await exec('git', ['-C', path, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Graph Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Graph Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } })).stdout.trim();
  await git('init', '-b', 'main');
  await git('config', 'commit.gpgsign', 'false');
  return { path, git, file: (name, content) => writeFile(join(path, name), content), commit: async message => { await git('add', '--all'); await git('commit', '-m', message); return git('rev-parse', 'HEAD'); } };
}

test('empty and non-Git folders have deliberate outcomes', async t => {
  const r = await repo(t);
  const result = await readHistory(r.path);
  assert.deepEqual(result.commits, []);
  assert.equal(result.branch, 'main');
  assert.equal(result.hasMore, false);
  const dir = await mkdtemp(join(tmpdir(), 'orca-not-git-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(readHistory(dir), /not a git repository/);
});

test('branches, annotated tags, merge topology, and first-parent diffs', async t => {
  const r = await repo(t);
  await r.file('base.txt', 'base\n'); const root = await r.commit('Root <script> is plain text');
  await r.git('checkout', '-b', 'feature');
  await r.file('feature.txt', 'feature\n'); const feature = await r.commit('Feature');
  await r.git('checkout', 'main');
  await r.file('main.txt', 'main\n'); const main = await r.commit('Main');
  await r.git('merge', '--no-ff', 'feature', '-m', 'Merge feature');
  const merge = await r.git('rev-parse', 'HEAD');
  await r.git('tag', '-a', 'v1.0', '-m', 'Release');
  const before = await r.git('status', '--porcelain=v1');
  const history = await readHistory(r.path);
  assert.equal(history.head, merge);
  assert.equal(history.commits[0].hash, merge);
  assert.deepEqual(history.commits[0].parents, [main, feature]);
  assert.equal(history.commits.length, 4);
  assert.ok(history.refs.some(ref => ref.kind === 'tag' && ref.label === 'v1.0' && ref.hash === merge));
  assert.equal(history.commits.at(-1).hash, root);
  const filtered = await readHistory(r.path, { ref: 'refs/heads/feature' });
  assert.deepEqual(filtered.commits.map(c => c.hash), [feature, root]);
  const details = await readDetails(r.path, merge);
  assert.equal(details.authorEmail, 'test@example.invalid');
  assert.equal(details.committer, 'Graph Test');
  assert.equal(details.committerEmail, 'test@example.invalid');
  assert.deepEqual(details.files, [{ status: 'A', path: 'feature.txt', additions: 1, deletions: 0 }]);
  assert.match((await readDiff(r.path, merge, 'feature.txt')).text, /\+feature/);
  assert.deepEqual((await readDetails(r.path, root)).files, [{ status: 'A', path: 'base.txt', additions: 1, deletions: 0 }]);
  assert.match((await readDiff(r.path, root, 'base.txt')).text, /\+base/);
  assert.equal(await r.git('status', '--porcelain=v1'), before);
  await r.git('checkout', '--detach', feature);
  const detached = await readHistory(r.path);
  assert.equal(detached.branch, ''); assert.equal(detached.head, feature);
});

test('literal paths, binary changes, deletions, truncation, and unsafe inputs', async t => {
  const r = await repo(t);
  const odd = 'odd\tname\n[abc].txt';
  await r.file(odd, 'only odd file\n'); await r.file('other.txt', 'other\n'); await r.file('binary.bin', Buffer.from([0, 1, 2]));
  const root = await r.commit('Paths and binary');
  assert.ok((await readDetails(r.path, root)).files.some(f => f.path === odd));
  const diff = await readDiff(r.path, root, odd);
  assert.match(diff.text, /only odd file/); assert.doesNotMatch(diff.text, /other.txt/);
  assert.match((await readDiff(r.path, root, 'binary.bin')).text, /Binary files/);
  await r.file('large.txt', 'new line\n'.repeat(20000));
  await rm(join(r.path, 'other.txt'));
  const second = await r.commit('Large file and deletion');
  assert.equal((await readDetails(r.path, second)).files.find(f => f.path === 'other.txt').status, 'D');
  const large = await readDiff(r.path, second, 'large.txt');
  assert.equal(large.truncated, true); assert.ok(large.text.length <= 64000);
  await assert.rejects(readDiff(r.path, root, '../outside'), /Select a file/);
  await assert.rejects(readDetails(r.path, '--output=bad'), /Invalid commit/);
  await assert.rejects(readHistory(r.path, { ref: '--all' }), /no longer exists/);
  await assert.rejects(readHistory(r.path, { offset: -1 }), /Invalid history page/);
  await assert.rejects(readHistory(r.path, { offset: 2000 }), /Invalid history page/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readHistory(r.path, { signal: controller.signal }), /abort/i);
});

test('pagination has no duplicates and rejects a moving history', async t => {
  const r = await repo(t);
  await r.file('a', 'a'); let hash = await r.commit('root');
  const tree = await r.git('rev-parse', 'HEAD^{tree}');
  for (let i = 0; i < 204; i++) hash = await r.git('commit-tree', tree, '-p', hash, '-m', 'Commit ' + i);
  await r.git('update-ref', 'refs/heads/main', hash);
  const first = await readHistory(r.path);
  assert.equal(first.commits.length, 200); assert.equal(first.hasMore, true);
  const last = await readHistory(r.path, { offset: 200, snapshot: first.snapshot });
  assert.equal(last.commits.length, 5); assert.equal(last.hasMore, false);
  assert.equal(new Set([...first.commits, ...last.commits].map(c => c.hash)).size, 205);
  await r.git('tag', 'moved-snapshot');
  await assert.rejects(readHistory(r.path, { offset: 200, snapshot: first.snapshot }), /History changed/);
});

test('parsers preserve tab/newline filenames and reject malformed records', () => {
  assert.deepEqual(parseFiles('R100\0old\tname\0new\nname\0M\0regular\0'), [{ status: 'R', oldPath: 'old\tname', path: 'new\nname' }, { status: 'M', path: 'regular' }]);
  assert.throws(() => parseFiles('A\0'), /unreadable/);
  assert.throws(() => parseLog('not a record'), /unreadable/);
  assert.throws(() => assertHash('HEAD'), /Invalid commit/);
  assert.doesNotThrow(() => assertHash('a'.repeat(64)));
});

test('graph lanes preserve ancestry across merges, octopus merges, roots, and page boundaries', () => {
  const commits = [
    { hash: 'merge', parents: ['main', 'feature', 'third'] },
    { hash: 'main', parents: ['base'] },
    { hash: 'feature', parents: ['base'] },
    { hash: 'third', parents: ['base'] },
    { hash: 'base', parents: [] },
    { hash: 'unrelated', parents: ['old'] }
  ];
  const rows = layoutGraph(commits);
  assert.equal(rows[0].edges.filter(e => e.start === 'node').length, 3);
  assert.equal(rows[4].edges.filter(e => e.start === 'node').length, 0);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    assert.equal(row.edges.filter(e => e.start === 'node').length, commits[i].parents.length);
    for (const edge of row.edges) { assert.ok(edge.from >= 0); assert.ok(edge.to >= 0); }
    if (i + 1 < rows.length) {
      const bottoms = [...new Set(row.edges.filter(e => e.end === 'bottom').map(e => e.to))].sort();
      const tops = [...new Set(rows[i + 1].edges.filter(e => e.start === 'top').map(e => e.from))].sort();
      assert.deepEqual(bottoms, tops);
    }
  }
  assert.deepEqual(layoutGraph(commits.slice(0, 3)), rows.slice(0, 3));
  assert.deepEqual(layoutGraph([]), []);
});

test('worker accepts only host-listed local workspace IDs, never client paths', async t => {
  const r = await repo(t); await r.file('a', 'a'); await r.commit('root');
  const handlers = new Map();
  activate({ storage: { get: async () => null }, host: { call: async name => name === 'workspace.list' ? { workspaces: [
    { id: 'local', kind: 'worktree', name: 'Test', branch: 'main', path: r.path, hostId: 'local' },
    { id: 'remote', kind: 'worktree', name: 'Remote', branch: 'main', path: r.path, hostId: 'remote-host' },
    { id: 'folder', kind: 'folder', name: 'Folder', branch: null, path: r.path, hostId: null }
  ], truncated: false } : { displayName: 'Test', branch: 'main' } }, panels: { handle: (name, fn) => handlers.set(name, fn) } });
  const call = (name, input) => handlers.get(name)(input, { signal: new AbortController().signal });
  const list = await call('workspaces', {});
  assert.equal(list.selectedId, 'local'); assert.equal(list.remoteCount, 1);
  assert.equal(list.workspaces.length, 2);
  assert.equal((await call('history', { workspaceId: 'local', path: '/not/the/repo' })).commits.length, 1);
  assert.equal((await call('history', { workspaceId: 'folder' })).commits.length, 1);
  await assert.rejects(call('history', { workspaceId: 'remote' }), /no longer available/);
  await assert.rejects(call('history', { workspaceId: 'unknown', path: r.path }), /no longer available/);
  await assert.rejects(call('history', null), /Choose a local/);
  await assert.rejects(call('action', { workspaceId: 'remote', action: 'tag', confirmed: true }), /no longer available/);
  await assert.rejects(call('action', { workspaceId: 'unknown', path: r.path, action: 'reset', confirmed: true }), /no longer available/);
  const head = await r.git('rev-parse', 'HEAD');
  await call('action', { workspaceId: 'local', path: '/not/the/repo', action: 'tag', name: 'worker-tag', hash: head, expectedHead: head, expectedBranch: 'main', confirmed: true });
  assert.equal(await r.git('rev-parse', 'worker-tag'), head);
  await r.file('pending', 'pending change\n');
  assert.equal((await call('working-details', { workspaceId: 'local' })).totalFiles, 1);
  assert.match((await call('working-diff', { workspaceId: 'local', file: 'pending' })).text, /pending change/);
  await assert.rejects(call('working-details', { workspaceId: 'remote' }), /no longer available/);
  await assert.rejects(call('working-diff', { workspaceId: 'unknown', file: 'pending' }), /no longer available/);
});

test('manifest declares workspace access and points to existing entrypoints', async () => {
  const manifest = JSON.parse(await readFile(new URL('../orca-plugin.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.capabilities, [{ kind: 'workspace:read' }, { kind: 'storage:own' }]);
  assert.deepEqual(manifest.contributes.customEditors.map(editor => editor.extensions), [['.git-graph-diff']]);
  await readFile(new URL('../' + manifest.contributes.customEditors[0].entry, import.meta.url));
  assert.equal(manifest.contributes.newFiles, undefined);
  assert.deepEqual(manifest.contributes.panels, [{ id: 'git-graph', title: 'Git Graph', icon: 'branch', entry: 'src/panel.html', ui: 'html' }]);
  await readFile(new URL('../' + manifest.main, import.meta.url));
  await readFile(new URL('../' + manifest.contributes.panels[0].entry, import.meta.url));
});


test('nested folder workspaces use repository-relative file paths', async t => {
  const r = await repo(t);
  await mkdir(join(r.path, 'nested'));
  await r.file('nested/file.txt', 'first\n');
  const root = await r.commit('root');
  const nested = join(r.path, 'nested');
  assert.match((await readDiff(nested, root, 'nested/file.txt')).text, /\+first/);
  await r.file('nested/file.txt', 'second\n');
  const second = await r.commit('update');
  await r.git('config', 'diff.relative', 'true');
  await r.git('config', 'color.ui', 'always');
  const details = await readDetails(nested, second);
  assert.deepEqual(details.files, [{ status: 'M', path: 'nested/file.txt', additions: 1, deletions: 1 }]);
  const diff = await readDiff(nested, second, 'nested/file.txt');
  assert.match(diff.text, /\+second/);
  assert.doesNotMatch(diff.text, /\x1b\[/);
});

test('all branches and tags exclude internal checkpoint refs', async t => {
  const r = await repo(t);
  await r.file('file.txt', 'tracked history'); const root = await r.commit('root');
  const tree = await r.git('rev-parse', 'HEAD^{tree}');
  const checkpoint = await r.git('commit-tree', tree, '-m', 'internal checkpoint');
  await r.git('update-ref', 'refs/pi/checkpoints/test', checkpoint);
  assert.deepEqual((await readHistory(r.path)).commits.map(c => c.hash), [root]);
  await r.git('tag', 'public-tag', checkpoint);
  assert.ok((await readHistory(r.path)).commits.some(c => c.hash === checkpoint));
});

test('branches keep separate stable lanes until their shared ancestor', () => {
  const commits = [
    { hash: 'merge', parents: ['trunk', 'pink', 'green'] },
    { hash: 'trunk', parents: ['base'] },
    { hash: 'pink', parents: ['base'] },
    { hash: 'green', parents: ['base'] },
    { hash: 'base', parents: [] }
  ];
  const rows = layoutGraph(commits);
  assert.deepEqual(rows.map(row => row.column), [0, 0, 1, 2, 0]);
  assert.ok(rows[2].edges.some(edge => edge.from === 1 && edge.to === 1 && edge.start === 'node'));
  assert.ok(rows[3].edges.some(edge => edge.from === 1 && edge.to === 1 && edge.end === 'bottom'));
  assert.deepEqual(rows[4].edges.map(edge => [edge.from, edge.to, edge.end]), [[0, 0, 'node'], [1, 0, 'node'], [2, 0, 'node']]);
  for (let i = 0; i < rows.length - 1; i++) {
    assert.deepEqual(rows[i].edges.filter(e => e.end === 'bottom').map(e => [e.to, e.color]).sort(), rows[i + 1].edges.filter(e => e.start === 'top').map(e => [e.from, e.color]).sort());
  }
  assert.deepEqual(layoutGraph(commits.slice(0, 4)), rows.slice(0, 4));
});

test('ending a lane does not shift a still-active branch', () => {
  const rows = layoutGraph([
    { hash: 'merge', parents: ['left-root', 'right'] },
    { hash: 'left-root', parents: [] },
    { hash: 'right', parents: ['old'] },
    { hash: 'new-tip', parents: ['old'] },
    { hash: 'old', parents: [] }
  ]);
  assert.equal(rows[2].column, 1);
  assert.equal(rows[3].column, 0);
  assert.ok(rows[1].edges.some(edge => edge.from === 1 && edge.to === 1));
  assert.equal(rows[4].edges.filter(edge => edge.end === 'node').length, 2);
});


test('full-row graph curves join across boundaries and flatten only for open details', () => {
  const rows = layoutGraph([{ hash: 'm', parents: ['a', 'b'] }, { hash: 'a', parents: ['base'] }, { hash: 'b', parents: ['base'] }, { hash: 'base', parents: [] }]);
  assert.equal(edgePath({ from: 1, to: 1, start: 'top', end: 'bottom' }), 'M 40 0 V 28');
  assert.ok(graphPaths(rows, 0).some(p => p.d.includes(' C ')));
  for (let i = 0; i < rows.length - 1; i++) {
    const current = graphPaths(rows, i), next = graphPaths(rows, i + 1);
    for (const edge of rows[i].edges.filter(e => e.end === 'bottom')) {
      const lower = current.filter(p => p.color === edge.color).at(-1).d.split(/[ ,]+/);
      const upper = next.find(p => p.color === edge.color).d.split(/[ ,]+/);
      assert.equal(Number(lower.at(-2)), Number(upper[1]));
      assert.equal(Number(lower.at(-1)), 28); assert.equal(Number(upper[2]), 0);
    }
  }
  const closed = graphPaths(rows, 0).at(-1).d;
  const open = graphPaths(rows, 0, 'm').at(-1).d;
  assert.notEqual(open, closed);
  assert.match(open, /40 28$/);
  assert.match(graphPaths(rows, 1, 'm').find(p => p.color === 1).d, /^M 40 0/);
});

test('line counts preserve literal paths and distinguish binary from zero changes', () => {
  assert.deepEqual([...parseNumstat('13\t12\todd\tname\n.txt\0-\t-\timage.png\0' + '0\t0\tmode.txt\0')], [
    ['odd\tname\n.txt', { additions: 13, deletions: 12 }],
    ['image.png', { additions: null, deletions: null }],
    ['mode.txt', { additions: 0, deletions: 0 }]
  ]);
  assert.throws(() => parseNumstat('bad\0'), /unreadable line counts/);
});


test('uncommitted changes include staged, unstaged, untracked, binary and literal paths without writes', async t => {
  const r = await repo(t);
  await r.file('edit.txt', 'one\ntwo\n'); await r.file('gone.txt', 'remove me\n');
  await r.file('.gitignore', 'ignored.txt\n'); await r.commit('base');
  assert.equal((await readHistory(r.path)).workingTree.totalFiles, 0);
  await r.file('edit.txt', 'one\nstaged\n'); await r.git('add', 'edit.txt');
  await r.file('edit.txt', 'one\nworking\nextra\n'); await rm(join(r.path, 'gone.txt'));
  const odd = 'new\tfile\n[1].txt'; await r.file(odd, 'new line\nlast');
  await r.file('binary.bin', Buffer.from([0, 1, 2])); await r.file('ignored.txt', 'secret');
  await symlink('/does/not/exist', join(r.path, 'link'));
  await mkdir(join(r.path, 'nested'));
  const status = await r.git('status', '--porcelain=v1');
  const index = await readFile(join(r.path, '.git/index'));
  const history = await readHistory(r.path); assert.equal(history.workingTree.totalFiles, 5);
  const details = await readWorkingDetails(join(r.path, 'nested'));
  assert.equal(details.totalFiles, 5); assert.equal(details.staged, 1); assert.equal(details.unstaged, 2); assert.equal(details.untracked, 3);
  const edit = details.files.find(f => f.path === 'edit.txt');
  assert.equal(edit.additions, 2); assert.equal(edit.deletions, 1); assert.equal(edit.staged, true); assert.equal(edit.unstaged, true);
  const added = details.files.find(f => f.path === odd); assert.equal(added.additions, 2); assert.equal(added.deletions, 0);
  assert.equal(details.files.find(f => f.path === 'binary.bin').additions, null);
  assert.equal(details.files.find(f => f.path === 'gone.txt').deletions, 1);
  assert.equal(details.files.find(f => f.path === 'link').additions, 1);
  assert.match((await readWorkingDiff(r.path, odd)).text, /\+new line/);
  assert.match((await readWorkingDiff(r.path, 'edit.txt')).text, /\+working/);
  assert.match((await readWorkingDiff(r.path, 'gone.txt')).text, /-remove me/);
  assert.match((await readWorkingDiff(r.path, 'link')).text, /\+\/does\/not\/exist/);
  assert.match((await readWorkingDiff(r.path, 'binary.bin')).text, /Binary files/);
  await assert.rejects(readWorkingDiff(r.path, '../outside'), /currently changed/);
  await assert.rejects(readWorkingDiff(r.path, 'ignored.txt'), /currently changed/);
  assert.deepEqual(await readFile(join(r.path, '.git/index')), index);
  assert.equal(await r.git('status', '--porcelain=v1'), status);
});

test('unborn repositories and staged changes canceled in the working tree remain visible', async t => {
  const r = await repo(t);
  await r.file('new', 'first\n'); await r.git('add', 'new'); await r.file('new', 'second\n');
  let details = await readWorkingDetails(r.path);
  assert.equal(details.head, ''); assert.equal(details.files[0].additions, 1);
  assert.match((await readWorkingDiff(r.path, 'new')).text, /\+second/);
  await r.commit('first');
  await r.file('new', 'staged\n'); await r.git('add', 'new'); await r.file('new', 'second\n');
  details = await readWorkingDetails(r.path);
  assert.equal(details.totalFiles, 1); assert.equal(details.files[0].additions, 0); assert.equal(details.files[0].deletions, 0);
  assert.equal((await readWorkingDiff(r.path, 'new')).text, '');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readWorkingDetails(r.path, controller.signal), /abort/i);
});

test('unmerged files are labeled and large untracked diffs stay bounded', async t => {
  const r = await repo(t); await r.file('conflict', 'base\n'); await r.commit('base');
  await r.git('checkout', '-b', 'feature'); await r.file('conflict', 'feature\n'); await r.commit('feature');
  await r.git('checkout', 'main'); await r.file('conflict', 'main\n'); await r.commit('main');
  await assert.rejects(r.git('merge', 'feature'));
  const details = await readWorkingDetails(r.path);
  assert.equal(details.conflicts, 1); assert.equal(details.files[0].countLabel, 'Unmerged');
  assert.match((await readWorkingDiff(r.path, 'conflict')).text, /<<<<<<< HEAD/);
  await r.file('large', 'new line\n'.repeat(20000));
  const diff = await readWorkingDiff(r.path, 'large');
  assert.equal(diff.truncated, true); assert.ok(diff.text.length <= 64000);
});

test('status and two-path numstat records preserve unusual names', () => {
  assert.equal(parseStatus('?? a\tb\nc\0')[0].path, 'a\tb\nc');
  assert.deepEqual([...parseNumstat('2\t0\t\0/dev/null\0a\tb\nc\0')], [['a\tb\nc', { additions: 2, deletions: 0 }]]);
  assert.throws(() => parseStatus('broken\0'), /unreadable/);
});


test('staged deletion and untracked replacement share one row and expose both changes', async t => {
  const r = await repo(t); await r.file('same.txt', 'old\n'); await r.commit('base');
  await r.git('rm', 'same.txt'); await r.file('same.txt', 'new\nextra\n');
  assert.equal((await readHistory(r.path)).workingTree.totalFiles, 1);
  const details = await readWorkingDetails(r.path);
  assert.equal(details.files.length, 1);
  const file = details.files[0];
  assert.equal(file.status, 'M'); assert.equal(file.recreated, true);
  assert.equal(file.additions, 2); assert.equal(file.deletions, 1);
  assert.match(file.countNote, /not net lines/);
  const diff = await readWorkingDiff(r.path, file.path);
  assert.match(diff.text, /-old/); assert.match(diff.text, /\+new/); assert.match(diff.note, /replacement/);
});

test('working-tree reads never run configured clean or process filters', async t => {
  const r = await repo(t);
  await r.file('file.txt', 'original\n'); await r.file('.gitattributes', '*.txt filter=probe\n'); await r.commit('base');
  await r.git('config', 'filter.probe.clean', 'touch filter-ran; cat');
  await r.git('config', 'filter.probe.process', 'touch process-ran; exit 1');
  await r.git('config', 'filter.probe.required', 'true');
  await r.file('file.txt', 'changed content\n'); await r.file('new.txt', 'untracked content\n');
  const index = await readFile(join(r.path, '.git/index'));
  assert.equal((await readHistory(r.path)).workingTree.totalFiles, 2);
  const details = await readWorkingDetails(r.path); assert.equal(details.filtersDisabled, true);
  assert.equal(details.files.find(f => f.path === 'file.txt').additions, 1);
  assert.match((await readWorkingDiff(r.path, 'file.txt')).text, /changed content/);
  assert.match((await readWorkingDiff(r.path, 'new.txt')).text, /untracked content/);
  await assert.rejects(readFile(join(r.path, 'filter-ran')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(r.path, 'process-ran')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(r.path, '.git/index')), index);
});
