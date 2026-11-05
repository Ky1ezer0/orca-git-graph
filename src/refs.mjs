export function refBadges(refs, head) {
  const labels = new Map(), branches = new Map();
  for (const ref of refs) {
    if (ref.kind === 'branch') branches.set(ref.hash + ':' + ref.label, { label: ref.label, kind: ref.kind, remotes: [], title: ref.label });
  }
  for (const ref of refs) {
    if (!labels.has(ref.hash)) labels.set(ref.hash, []);
    const badges = labels.get(ref.hash);
    const slash = ref.label.indexOf('/');
    const local = ref.kind === 'remote' && slash > 0 ? branches.get(ref.hash + ':' + ref.label.slice(slash + 1)) : undefined;
    if (local) {
      local.remotes.push(ref.label.slice(0, slash));
      local.title += '\n' + ref.label;
    } else {
      badges.push(ref.kind === 'branch' ? branches.get(ref.hash + ':' + ref.label) : { label: (ref.kind === 'tag' ? 'tag: ' : '') + ref.label, kind: ref.kind, remotes: [], title: ref.label });
    }
  }
  if (head) labels.set(head, [{ label: 'HEAD', kind: 'head', remotes: [], title: 'HEAD' }, ...(labels.get(head) || [])]);
  return labels;
}
