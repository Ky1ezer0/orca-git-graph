import test from 'node:test';
import assert from 'node:assert/strict';
import { refBadges } from './refs.mjs';

const ref = (hash, kind, label) => ({ hash, kind, label });

test('combines matching local and remote names only at the same commit', () => {
  const refs = [ref('a', 'remote', 'origin/feature/topic'), ref('a', 'branch', 'feature/topic'), ref('a', 'remote', 'upstream/feature/topic'), ref('b', 'remote', 'origin/main'), ref('a', 'branch', 'main'), ref('a', 'remote', 'origin/other'), ref('a', 'tag', 'feature/topic'), ref('a', 'stash', 'stash@{0}')];
  const before = structuredClone(refs);
  const badges = refBadges(refs, 'a');
  assert.deepEqual(badges.get('a').map(b => b.label), ['HEAD', 'feature/topic', 'main', 'origin/other', 'tag: feature/topic', 'stash@{0}']);
  assert.deepEqual(badges.get('a')[1].remotes, ['origin', 'upstream']);
  assert.equal(badges.get('a')[1].title, 'feature/topic\norigin/feature/topic\nupstream/feature/topic');
  assert.deepEqual(badges.get('a')[2].remotes, []);
  assert.equal(badges.get('b')[0].label, 'origin/main');
  assert.deepEqual(refs, before);
});

test('keeps unrelated same-commit references and detached HEAD visible', () => {
  const badges = refBadges([ref('a', 'branch', 'topic'), ref('a', 'branch', 'feature/topic'), ref('a', 'remote', 'origin/feature/topic'), ref('a', 'remote', 'origin/topic'), ref('a', 'remote', 'origin/topic-extra')], 'detached');
  assert.deepEqual(badges.get('a').map(b => [b.label, b.remotes]), [['topic', ['origin']], ['feature/topic', ['origin']], ['origin/topic-extra', []]]);
  assert.equal(badges.get('detached')[0].kind, 'head');
  assert.equal(refBadges([], '').size, 0);
});
