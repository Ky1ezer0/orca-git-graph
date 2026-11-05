function render(value) {
  if (!value || value.version !== 1 || !['file', 'repository', 'revision', 'capturedAt', 'text'].every(key => typeof value[key] === 'string') || value.text.length > 100000) throw new Error('This is not a valid Git Graph diff snapshot. Open a file from the graph again.');
  document.getElementById('title').textContent = value.file;
  document.getElementById('metadata').textContent = value.repository + ' · ' + (value.revision === 'working-tree' ? 'Working tree against HEAD' : 'Commit ' + value.revision.slice(0, 12) + ' against its first parent (empty tree for a root commit)') + ' · Captured ' + new Date(value.capturedAt).toLocaleString();
  document.getElementById('diff-notice').textContent = [value.note || '', value.truncated ? 'Diff truncated at 64 KB.' : '', !value.text ? 'No textual changes.' : '', 'Snapshot only. Click the file in Git Graph again to refresh.'].filter(Boolean).join(' ');
  let old = 0, next = 0, inHunk = false;
  const fragment = document.createDocumentFragment();
  for (const line of value.text.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (line.startsWith('diff ')) inHunk = false;
    if (hunk) { old = Number(hunk[1]); next = Number(hunk[2]); inHunk = true; }
    const kind = hunk ? 'hunk' : inHunk && line.startsWith('+') ? 'add' : inHunk && line.startsWith('-') ? 'remove' : '';
    const row = document.createElement('div'); row.className = 'patch-line ' + kind;
    const before = document.createElement('span'), after = document.createElement('span'), code = document.createElement('span');
    before.className = after.className = 'patch-number'; before.setAttribute('aria-hidden', 'true'); after.setAttribute('aria-hidden', 'true');
    if (inHunk && !hunk && /^[ +\-]/.test(line)) { if (kind !== 'add') before.textContent = old++; if (kind !== 'remove') after.textContent = next++; }
    code.className = 'patch-code'; code.textContent = line; row.append(before, after, code); fragment.append(row);
  }
  document.getElementById('patch').replaceChildren(fragment);
}
function show(value) { try { render(value); } catch (error) { document.getElementById('patch').replaceChildren(); document.getElementById('diff-notice').textContent = error.message; } }
try {
  const session = await window.orca.document.session({ decode: content => { try { return content.kind === 'text' ? JSON.parse(content.text) : null; } catch { return null; } }, encode: value => ({ kind: 'text', text: JSON.stringify(value) }) });
  show(session.value); session.onReplace(show);
  window.addEventListener('pagehide', () => session.dispose());
} catch (error) { document.getElementById('diff-notice').textContent = error.message; }
