import { defaults, findIssueLinks } from './preferences.mjs';
import { setupSettings } from './settings.mjs';
import { refBadges } from './refs.mjs';
import { COLORS, ROW_HEIGHT, LANE_WIDTH, GRAPH_PADDING, graphPaths, layoutGraph } from './graph.mjs';

const $ = id => document.getElementById(id);
const ui = Object.fromEntries(['settings', 'settings-page', 'search', 'search-count', 'search-prev', 'search-next', 'pull', 'context-menu', 'action-dialog', 'action-form', 'action-title', 'action-description', 'action-name-label', 'action-name', 'action-mode-label', 'action-mode', 'action-parent-label', 'action-parent', 'action-cancel', 'action-submit', 'operation-bar', 'operation-message', 'operation-continue', 'operation-abort', 'workspace', 'ref', 'refresh', 'status', 'notice', 'history', 'commits', 'empty', 'more', 'details', 'detail-status', 'detail-content', 'commit-id', 'commit-parents', 'commit-author', 'commit-committer', 'commit-date', 'diff-pane', 'message', 'comparison', 'file-heading', 'files', 'diff-status', 'diff', 'close', 'tree-view', 'list-view'].map(id => [id, $(id)]));
const state = { workspaces: [], commits: [], refs: [], head: '', selected: '', snapshot: '', busy: false, workspaceNotice: '', fileView: 'tree', files: [], selectedFile: '', workingTree: null, branch: '', operation: '', actionBusy: false, workingSnapshot: '', historyRef: '' };
let historyRequest, detailRequest, diffRequest, expansion;
const WORKING = 'working-tree';
let graphRows = new Map(), graphLayout = [];
let graphWidth = 110, graphScale = 1;
const compact = matchMedia('(max-width: 760px)');
let prefs = { ...defaults };
const isCompact = () => compact.matches;
let rowHeight;
function applyRowLayout() {
  const padding = prefs.layout === 'compact' ? 0 : 4;
  rowHeight = prefs.layout === 'compact' ? (isCompact() ? 54 : 24) : (isCompact() ? 64 : 36);
  document.body.classList.toggle('compact-layout', isCompact());
  ui.history.style.setProperty('--commit-row-height', rowHeight + 'px');
  ui.history.style.setProperty('--commit-row-padding', padding + 'px');
}
applyRowLayout();
const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const date = new Intl.DateTimeFormat(undefined, { month: 'short', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const fullDate = value => new Date(value).toLocaleString();
const node = (tag, className, text) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
};
function status(el, text, error = false) {
  el.textContent = text;
  el.classList.toggle('error', error);
}
function request(name, input, controller) {
  return window.orca.plugin.request(name, input, { signal: controller.signal, timeoutMs: name === 'action' ? 120000 : 60000 });
}
function setBusy(busy) {
  state.busy = busy;
  busy ||= state.actionBusy;
  ui.pull.disabled = busy || !state.workspaces.length;
  ui.settings.disabled = busy || !state.workspaces.length;
  ui['operation-continue'].disabled = busy;
  ui['operation-abort'].disabled = busy;
  ui.refresh.disabled = busy;
  ui.workspace.disabled = busy || !state.workspaces.length;
  ui.ref.disabled = busy || !state.workspaces.length;
  ui.more.disabled = busy;
  ui.history.setAttribute('aria-busy', String(busy));
}
function closeDetails(restoreFocus = false) {
  detailRequest?.abort(); diffRequest?.abort();
  const selected = state.selected;
  state.selected = '';
  redrawGraphBoundary(selected);
  ui.details.hidden = true;
  document.body.append(ui.details);
  expansion?.remove(); expansion = undefined;
  for (const row of ui.commits.querySelectorAll('.commit')) {
    row.setAttribute('aria-pressed', 'false');
    row.setAttribute('aria-expanded', 'false');
    if (restoreFocus && row.dataset.hash === selected) row.focus();
  }
}
function empty(text) {
  ui.empty.textContent = text;
  ui.empty.hidden = !text;
}
function svgElement(tag, attributes) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, String(value));
  return el;
}
function drawGraph(row, width) {
  const height = row.height;
  const svg = svgElement('svg', { width, height, 'aria-hidden': 'true', class: 'graph' });
  const x = column => (GRAPH_PADDING + column * LANE_WIDTH) * graphScale;
  for (const path of graphPaths(graphLayout, graphLayout.indexOf(row), state.selected)) {
    svg.append(svgElement('path', { d: path.d, transform: 'scale(' + graphScale + ' ' + height / ROW_HEIGHT + ')', 'vector-effect': 'non-scaling-stroke', stroke: path.workingTree ? 'var(--muted)' : COLORS[path.color], 'stroke-width': 2.3, 'stroke-linecap': 'round', fill: 'none' }));
  }
  svg.append(svgElement('circle', { cx: x(row.column), cy: height / 2, r: Math.min(row.workingTree || row.hash === state.head ? 5 : 4.3, LANE_WIDTH * graphScale / 3), fill: row.workingTree ? 'var(--orca-background, #1e1e1e)' : COLORS[row.color], stroke: row.workingTree ? 'var(--muted)' : COLORS[row.color], 'stroke-width': row.workingTree ? 2 : 0 }));
  return svg;
}
function redrawGraphBoundary(hash) {
  const index = graphLayout.findIndex(row => row.hash === hash);
  if (index < 0) return;
  for (const row of graphLayout.slice(index, index + 2)) {
    ui.commits.querySelector('[data-hash="' + row.hash + '"] .graph')?.replaceWith(drawGraph(row, graphWidth));
  }
}
function attachDetails(hash) {
  const row = ui.commits.querySelector('[data-hash="' + hash + '"]');
  if (!row) return;
  expansion?.remove();
  expansion = node('div', 'expansion');
  const svg = svgElement('svg', { width: graphWidth, viewBox: '0 0 ' + graphWidth + ' 1', preserveAspectRatio: 'none', 'aria-hidden': 'true', class: 'graph-continuation' });
  for (const edge of graphRows.get(hash).edges.filter(edge => edge.end === 'bottom')) {
    const x = (GRAPH_PADDING + edge.to * LANE_WIDTH) * graphScale;
    svg.append(svgElement('line', { x1: x, x2: x, y1: 0, y2: 1, stroke: hash === WORKING ? 'var(--muted)' : COLORS[edge.color], 'stroke-width': 2.3, 'vector-effect': 'non-scaling-stroke' }));
  }
  expansion.append(svg, ui.details);
  row.after(expansion);
}
function renderFiles(files) {
  const root = { folders: new Map(), files: [] };
  for (const file of files) {
    const parts = state.fileView === 'tree' ? file.path.split('/') : [file.path];
    const name = parts.pop();
    let group = root;
    for (const part of parts) {
      if (!group.folders.has(part)) group.folders.set(part, { folders: new Map(), files: [] });
      group = group.folders.get(part);
    }
    group.files.push({ ...file, name });
  }
  const render = (group, list) => {
    for (const [name, child] of group.folders) {
      const li = node('li'), folder = node('details', 'file-folder'), title = node('summary', '', name), nested = node('ul');
      folder.open = true;
      render(child, nested); folder.append(title, nested); li.append(folder); list.append(li);
    }
    for (const file of group.files) {
      const li = node('li'), button = node('button', 'file'); button.type = 'button'; button.title = file.path; button.dataset.status = file.status; button.dataset.path = file.path;
      button.setAttribute('aria-label', ({ A: 'Added', M: 'Modified', D: 'Deleted' }[file.status] || file.status) + ' ' + file.path); button.setAttribute('aria-pressed', String(file.path === state.selectedFile));
      button.append(node('span', 'file-status', file.status), node('span', 'file-path', file.name));
      const counts = node('span', 'file-counts');
      if (Number.isInteger(file.additions) && Number.isInteger(file.deletions)) {
        counts.append(node('span', 'lines-added', '+' + file.additions), node('span', 'count-divider', '|'), node('span', 'lines-deleted', '-' + file.deletions));
        counts.setAttribute('aria-label', file.additions + ' lines added, ' + file.deletions + ' lines deleted');
      } else counts.textContent = file.countLabel || (file.additions === null ? 'Binary' : 'Counts unavailable');
      button.setAttribute('aria-label', button.getAttribute('aria-label') + ', ' + (counts.getAttribute('aria-label') || counts.textContent));
      if (file.countNote) { counts.title = file.countNote; button.title += '\n' + file.countNote; }
      button.append(counts);
      const stage = [file.staged ? 'Staged' : '', file.unstaged ? 'Unstaged' : '', file.untracked ? 'Untracked' : ''].filter(Boolean).join(' + ');
      if (stage) { button.title += '\n' + stage; button.append(node('span', 'file-stage', stage)); }

      button.addEventListener('click', () => showDiff(state.selected, file.path, button)); li.append(button); list.append(li);
    }
  };
  ui.files.replaceChildren(); render(root, ui.files);
  for (const mode of ['tree', 'list']) { ui[mode + '-view'].setAttribute('aria-pressed', String(state.fileView === mode)); ui[mode + '-view'].disabled = !files.length; }
}
const columnSizes = {
  graph: { min: 110, width: 110 }, summary: { min: 160, width: 220 },
  date: { min: 100, width: 148 }, author: { min: 80, width: 116 }, hash: { min: 82, width: 82 }
};
const customWidths = new Map();
const columnHeaders = [...document.querySelectorAll('[data-column]')];
function updateResizeLabels() {
  for (const header of columnHeaders) {
    const size = columnSizes[header.dataset.column], handle = header.querySelector('.column-resize');
    handle.setAttribute('aria-valuemin', size.min);
    handle.setAttribute('aria-valuemax', Math.max(5000, size.min, Math.round(header.getBoundingClientRect().width)));
    handle.setAttribute('aria-valuenow', Math.round(header.getBoundingClientRect().width));
    handle.setAttribute('aria-valuetext', Math.round(header.getBoundingClientRect().width) + ' pixels');
  }
}
function applyColumnWidths() {
  for (const [key, size] of Object.entries(columnSizes)) {
    const width = Math.max(size.min, Math.min(Math.max(5000, size.min), customWidths.get(key) ?? size.width));
    ui.history.style.setProperty('--' + key + '-width', width + 'px');
  }
  ui.history.style.setProperty('--summary-column', customWidths.has('summary') ? 'var(--summary-width)' : 'minmax(var(--summary-width), 1fr)');
  updateResizeLabels();
}
for (const header of columnHeaders) {
  const key = header.dataset.column, handle = node('span', 'column-resize');
  handle.tabIndex = 0; handle.setAttribute('role', 'separator'); handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', header.textContent + ' column width'); handle.setAttribute('aria-controls', 'commits');
  handle.title = 'Drag to resize; arrow keys adjust; double-click or Enter resets';
  header.append(handle);
  let drag;
  const resize = width => { customWidths.set(key, Math.max(columnSizes[key].min, Math.min(Math.max(5000, columnSizes[key].min), width))); applyColumnWidths(); };
  const reset = () => { customWidths.delete(key); applyColumnWidths(); };
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault(); handle.focus(); handle.setPointerCapture(event.pointerId);
    drag = { x: event.clientX, width: header.getBoundingClientRect().width };
    document.body.classList.add('resizing');
  });
  handle.addEventListener('pointermove', event => { if (drag) resize(drag.width + event.clientX - drag.x); });
  const stop = () => { drag = undefined; document.body.classList.remove('resizing'); };
  handle.addEventListener('lostpointercapture', stop);
  handle.addEventListener('pointerup', stop); handle.addEventListener('pointercancel', stop);
  handle.addEventListener('dblclick', reset);
  handle.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'Enter'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Enter') reset();
    else resize(event.key === 'Home' ? columnSizes[key].min : header.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 50 : 10));
  });
}
new ResizeObserver(updateResizeLabels).observe(document.querySelector('.columns'));
applyColumnWidths();

function renderCommits() {
  const dirty = state.workingTree?.totalFiles > 0;
  const commits = dirty ? [{ hash: WORKING, parents: state.head && state.commits.some(c => c.hash === state.head) ? [state.head] : [], subject: 'Uncommitted Changes (' + state.workingTree.totalFiles + ')', author: '', date: '', workingTree: true }, ...state.commits] : state.commits;
  const layout = graphLayout = layoutGraph(prefs.firstParent ? commits.map(commit => ({ ...commit, parents: commit.parents.slice(0, 1) })) : commits);
  graphRows = new Map(layout.map(row => [row.hash, row]));
  const naturalWidth = GRAPH_PADDING * 2 + Math.max(1, ...layout.map(row => row.width)) * LANE_WIDTH;
  graphWidth = isCompact() ? Math.min(100, Math.max(40, Math.ceil(naturalWidth * .64))) : Math.max(110, naturalWidth);
  graphScale = isCompact() ? graphWidth / naturalWidth : 1;
  ui.history.style.setProperty('--compact-graph-width', graphWidth + 'px');
  columnSizes.graph = { min: graphWidth, width: graphWidth };
  const labels = refBadges(state.refs, state.head);
  const fragment = document.createDocumentFragment();
  commits.forEach((commit, i) => {
    const wrapper = node('div'); wrapper.setAttribute('role', 'listitem');
    const row = node('button', 'commit' + (commit.workingTree ? ' working-tree' : commit.parents.length > 1 ? ' merge' : '')); row.type = 'button'; row.dataset.hash = commit.hash;
    row.tabIndex = commit.hash === state.selected || (!state.selected && i === 0) ? 0 : -1;
    row.setAttribute('aria-pressed', String(commit.hash === state.selected));
    row.setAttribute('aria-expanded', String(commit.hash === state.selected));
    row.setAttribute('aria-controls', 'details');
    const refs = labels.get(commit.hash) || [];
    layout[i].height = rowHeight - (prefs.layout === 'compact' && isCompact() && !refs.length ? 16 : 0);
    row.style.setProperty('--commit-row-height', layout[i].height + 'px');
    const refNames = refs.map(ref => ref.title.replaceAll('\n', ', ')).join(', ');
    row.setAttribute('aria-label', [commit.subject, commit.author, commit.date ? fullDate(commit.date) : '', commit.workingTree ? '' : commit.hash.slice(0, 8), refNames, commit.parents.length > 1 ? 'Merge commit' : ''].filter(Boolean).join('. '));
    row.title = commit.subject + '\n' + refNames;
    const summary = node('span', 'summary');
    if (refs.length) {
      const badges = node('span', 'refs');
      for (const ref of refs) {
        const badge = node('span', 'ref' + (ref.kind === 'head' ? ' head' : '') + (ref.remotes.length ? ' grouped' : ''));
        badge.title = ref.title; badge.style.setProperty('--branch-color', COLORS[layout[i].color]);
        if (ref.remotes.length) {
          const icon = node('span', 'ref-icon');
          const svg = svgElement('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' });
          svg.append(svgElement('path', { d: 'M4 5v6m0-3c5 0 8-1 8-3' }));
          for (const [cx, cy] of [[4, 3], [4, 13], [12, 3]]) svg.append(svgElement('circle', { cx, cy, r: 1.5 }));
          icon.append(svg);
          badge.append(icon, node('span', 'ref-name', ref.label), node('span', 'ref-remote', ref.remotes.join(', ')));
        } else badge.textContent = ref.label;
        badges.append(badge);
      }
      summary.append(badges);
    }
    summary.append(node('span', 'subject', commit.subject || '(no commit message)'));
    const meta = node('span', 'commit-meta'); meta.setAttribute('aria-hidden', 'true');
    if (commit.workingTree) meta.textContent = 'Working tree · select to review';
    else {
      meta.append(node('span', 'meta-author', commit.author), node('code', 'meta-hash', commit.hash.slice(0, 7)));
      if (commit.date) { const time = node('time', '', shortDate.format(new Date(commit.date))); time.dateTime = commit.date; time.title = fullDate(commit.date); meta.append(time); }
    }
    summary.append(meta);
    const time = node('time', 'commit-date', commit.date ? date.format(new Date(commit.date)) : ''); if (commit.date) { time.dateTime = commit.date; time.title = fullDate(commit.date); }
    const author = node('span', 'author', commit.author); author.title = commit.author;
    const id = node('code', 'commit-hash', commit.workingTree ? '' : commit.hash.slice(0, 8)); id.title = commit.workingTree ? '' : commit.hash;
    row.append(drawGraph(layout[i], graphWidth), summary, time, author, id);
    if (!commit.workingTree) {
      row.addEventListener('contextmenu', event => { event.preventDefault(); openMenu(commit, row, event.clientX, event.clientY); });
      row.addEventListener('keydown', event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); const rect = row.getBoundingClientRect(); openMenu(commit, row, Math.min(rect.left + graphWidth, innerWidth - 280), rect.bottom); } });
    }
    row.addEventListener('click', () => state.selected === commit.hash ? closeDetails(true) : showCommit(commit.hash));
    wrapper.append(row); fragment.append(wrapper);
  });
  document.body.append(ui.details);
  ui.commits.replaceChildren(fragment);
  if (state.selected) attachDetails(state.selected);
  const labelWidths = [...ui.commits.querySelectorAll('.refs')].map(badges => Math.ceil(badges.getBoundingClientRect().width));
  const labelWidth = Math.max(0, ...labelWidths);
  columnSizes.summary = { min: Math.max(160, labelWidth + 96), width: labelWidth + 220 };
  applyColumnWidths();
  updateSearch(false);
}
compact.addEventListener('change', () => {
  applyRowLayout();
  const focused = document.activeElement?.dataset.hash;
  const scroll = ui.history.scrollTop;
  renderCommits();
  ui.history.scrollLeft = 0; ui.history.scrollTop = scroll;
  if (focused) ui.commits.querySelector('[data-hash="' + focused + '"]')?.focus({ preventScroll: true });
});
ui.commits.addEventListener('keydown', event => {
  const rows = [...ui.commits.querySelectorAll('.commit')];
  const i = rows.indexOf(document.activeElement);
  if (i < 0) return;
  let next;
  if (event.key === 'ArrowDown') next = Math.min(i + 1, rows.length - 1);
  if (event.key === 'ArrowUp') next = Math.max(i - 1, 0);
  if (event.key === 'Home') next = 0;
  if (event.key === 'End') next = rows.length - 1;
  if (next === undefined) return;
  event.preventDefault(); rows[i].tabIndex = -1; rows[next].tabIndex = 0; rows[next].focus();
});
function renderRefs() {
  const selected = ui.ref.value;
  ui.ref.replaceChildren(new Option(prefs.showTags ? 'All branches and tags' : 'All branches', ''), new Option('Current branch / HEAD', 'HEAD'));
  for (const kind of ['branch', 'remote', 'tag', 'stash']) {
    const group = node('optgroup'); group.label = { branch: 'Local branches', remote: 'Remote branches (cached)', tag: 'Tags', stash: 'Stashes' }[kind];
    for (const ref of state.refs.filter(item => item.kind === kind)) group.append(new Option(ref.label, ref.name));
    if (group.children.length) ui.ref.append(group);
  }
  ui.ref.value = selected;
}
async function loadHistory(append = false, quiet = false) {
  if (state.actionBusy) return;
  closeMenu();
  const previousSelection = state.selected, previousFile = state.selectedFile;
  const scroll = ui.history.scrollTop, loaded = state.commits.length;
  const focusedHash = document.activeElement?.dataset.hash;
  historyRequest?.abort();
  const controller = historyRequest = new AbortController();
  if (!append && !quiet) {
    closeDetails(); state.commits = []; state.refs = []; state.workingTree = null; ui.commits.replaceChildren(); ui.more.hidden = true; ui.history.scrollTop = 0;
  }
  if (quiet) state.busy = true;
  else { empty(''); setBusy(true); status(ui.status, append ? 'Loading older commits…' : 'Reading local Git history…'); }
  try {
    const result = await request('history', { workspaceId: ui.workspace.value, ref: ui.ref.value, offset: append ? state.commits.length : 0, snapshot: state.snapshot }, controller);
    if (controller.signal.aborted) return;
    if (quiet && ui.ref.value === state.historyRef && result.snapshot === state.snapshot && result.workingSnapshot === state.workingSnapshot && (result.operation || '') === state.operation) return;
    if (quiet) {
      while (result.hasMore && result.commits.length < loaded) {
        const page = await request('history', { workspaceId: ui.workspace.value, ref: ui.ref.value, offset: result.commits.length, snapshot: result.snapshot }, controller);
        if (controller.signal.aborted) return;
        result.commits.push(...page.commits); result.hasMore = page.hasMore; result.limited = page.limited;
      }
      if (previousSelection !== WORKING && !result.commits.some(c => c.hash === previousSelection) || previousSelection === WORKING && !result.workingTree?.totalFiles) closeDetails();
    }
    Object.assign(state, { historyRef: ui.ref.value, branch: result.branch, operation: result.operation || '', commits: append ? [...state.commits, ...result.commits] : result.commits, refs: result.refs, head: result.head, snapshot: result.snapshot });
    if (!append) { state.workingTree = result.workingTree || null; state.workingSnapshot = result.workingSnapshot; }
    renderRefs(); renderCommits();
    ui['operation-bar'].hidden = !state.operation;
    ui['operation-message'].textContent = state.operation ? state.operation + ' in progress. Resolve and stage conflicts outside Git Graph, then Continue, or Abort.' : '';
    if (quiet) {
      if (state.selected === WORKING) { await showCommit(WORKING); const button = [...ui.files.querySelectorAll('.file')].find(b => b.dataset.path === previousFile); if (button) { state.selectedFile = previousFile; button.setAttribute('aria-pressed', 'true'); if (prefs.diffView === 'inline') await showDiff(WORKING, previousFile, button); } }
      if (focusedHash) ui.commits.querySelector('[data-hash="' + focusedHash + '"]')?.focus({ preventScroll: true });
      if (controller.signal.aborted) return;
      ui.history.scrollTop = scroll;
    }
    status(ui.status, state.commits.length + ' commits · ' + (result.branch || (result.head ? 'Detached HEAD' : 'No commits yet')));
    const notes = [state.workspaceNotice, result.shallow ? 'Shallow clone: earlier history is unavailable locally.' : '', result.refsTruncated ? 'Showing the first 2,000 references.' : '', result.limited ? '2,000-commit limit reached. Select a branch or tag to narrow history.' : ''].filter(Boolean);
    ui.notice.textContent = notes.join(' '); ui.notice.hidden = !notes.length;
    empty(state.commits.length || state.workingTree?.totalFiles ? '' : 'No commits yet. Once this repository has a commit, its history will appear here.');
    ui.more.hidden = !result.hasMore;
  } catch (error) {
    if (!controller.signal.aborted) { status(ui.status, error.message || String(error), true); if (!state.commits.length) empty('Choose another repository or press Refresh to retry.'); }
  } finally { if (!controller.signal.aborted) setBusy(false); }
}
async function refresh() {
  if (state.actionBusy) return;
  closeMenu();
  historyRequest?.abort(); closeDetails();
  const controller = historyRequest = new AbortController();
  setBusy(true); status(ui.status, 'Loading workspaces…');
  try {
    const result = await request('workspaces', {}, controller);
    if (controller.signal.aborted) return;
    const previous = ui.workspace.value;
    state.workspaces = result.workspaces;
    ui.workspace.replaceChildren(...result.workspaces.map(w => new Option(w.path.replace(/[/\\]+$/, '').split(/[/\\]/).at(-1) + ' · ' + (w.branch || w.name), w.id)));
    ui.workspace.value = result.workspaces.some(w => w.id === previous) ? previous : result.selectedId || result.workspaces[0]?.id || '';
    ui.workspace.title = result.workspaces.find(w => w.id === ui.workspace.value)?.path || '';
    state.workspaceNotice = [result.remoteCount ? 'Remote workspaces are not supported in this version.' : '', result.truncated ? 'Orca returned a partial workspace list.' : ''].filter(Boolean).join(' ');
    if (!result.workspaces.length) {
      ui.commits.replaceChildren(); ui.more.hidden = true; state.commits = []; state.workingTree = null; state.branch = ''; state.operation = ''; ui['operation-bar'].hidden = true;
      ui.notice.hidden = true; status(ui.status, 'No local workspaces');
      empty('Open a local Git repository in Orca, then press Refresh. Remote workspaces are not supported yet.');
      setBusy(false); return;
    }
    await loadWorkspace();
  } catch (error) {
    if (!controller.signal.aborted) { status(ui.status, error.message || String(error), true); setBusy(false); }
  }
}
async function showCommit(hash) {
  detailRequest?.abort(); diffRequest?.abort();
  const controller = detailRequest = new AbortController();
  const previous = state.selected;
  state.selected = hash;
  redrawGraphBoundary(previous); redrawGraphBoundary(hash);
  state.files = []; state.selectedFile = ''; renderFiles(state.files);
  for (const row of ui.commits.querySelectorAll('.commit')) { const selected = row.dataset.hash === hash; row.setAttribute('aria-pressed', String(selected)); row.setAttribute('aria-expanded', String(selected)); row.tabIndex = selected ? 0 : -1; }
  attachDetails(hash);
  ui.details.hidden = false; ui['detail-content'].hidden = true; ui['diff-pane'].hidden = true; ui.diff.hidden = true; ui.details.scrollTop = 0;
  status(ui['detail-status'], hash === WORKING ? 'Reading uncommitted changes…' : 'Reading commit…'); status(ui['diff-status'], '');
  try {
    const result = await request(hash === WORKING ? 'working-details' : 'details', { workspaceId: ui.workspace.value, hash }, controller);
    if (controller.signal.aborted) return;
    document.querySelector('.commit-metadata').hidden = !!result.workingTree;
    if (result.workingTree) {
      ui.details.setAttribute('aria-label', 'Uncommitted changes');
      ui.message.textContent = [result.staged + ' staged', result.unstaged + ' unstaged', result.untracked + ' untracked', result.conflicts ? result.conflicts + ' conflicts' : ''].filter(Boolean).join(' · ');
      ui.comparison.textContent = 'Net changes against ' + (result.head ? 'HEAD ' + result.head.slice(0, 8) : 'an empty repository') + '. Files may be both staged and unstaged. Refresh after editing; staged changes canceled in the working tree have zero net lines. Deleted-and-recreated files show both the staged deletion and untracked replacement.' + (result.filtersDisabled ? ' Git clean/process filters are disabled for safety; counts use on-disk contents.' : '');
    } else {
      ui.details.setAttribute('aria-label', 'Commit details');
    ui['commit-id'].textContent = result.hash;
    ui['commit-parents'].replaceChildren(...(result.parents.length ? result.parents.map(parent => node('code', 'parent-id', parent)) : [document.createTextNode('None (root commit)')]));
    ui['commit-author'].textContent = result.author + (result.authorEmail ? ' <' + result.authorEmail + '>' : '');
    ui['commit-committer'].textContent = result.committer ? result.committer + (result.committerEmail ? ' <' + result.committerEmail + '>' : '') : 'Not available';
    ui['commit-date'].textContent = fullDate(result.date);
    renderMessage(result.message);
    ui.comparison.textContent = result.parents.length > 1 ? 'Merge commit · Changes compared with first parent ' + result.parents[0].slice(0, 8) : result.parents.length ? 'Compared with parent ' + result.parents[0].slice(0, 8) : 'Root commit · All added files';
    }
    ui['file-heading'].textContent = result.totalFiles + ' changed files' + (result.files.length < result.totalFiles ? ' · showing first ' + result.files.length : '');
    state.files = result.files; renderFiles(state.files);
    status(ui['detail-status'], ''); ui['detail-content'].hidden = false;
    status(ui['diff-status'], result.files.length ? 'Select a file to view its diff.' : 'No file changes against this parent.');
  } catch (error) { if (!controller.signal.aborted) status(ui['detail-status'], error.message || String(error), true); }
}
async function showDiff(hash, file, button) {
  diffRequest?.abort();
  state.selectedFile = file;
  const controller = diffRequest = new AbortController();
  for (const item of ui.files.querySelectorAll('button')) item.setAttribute('aria-pressed', String(item === button));
  ui['diff-pane'].hidden = false;
  status(ui['diff-status'], 'Reading diff…'); ui.diff.hidden = true;
  try {
    if (prefs.diffView === 'main') {
      status(ui['diff-status'], 'Opening main-panel diff…');
      const result = await request('open-diff', { workspaceId: ui.workspace.value, hash, file }, controller);
      if (!controller.signal.aborted) status(ui['diff-status'], result.message);
      return;
    }
    const result = await request(hash === WORKING ? 'working-diff' : 'diff', { workspaceId: ui.workspace.value, hash, file }, controller);
    if (controller.signal.aborted) return;
    ui.diff.replaceChildren(...result.text.split('\n').map(line => node('span', 'diff-line' + (line.startsWith('+') && !line.startsWith('+++') ? ' add' : line.startsWith('-') && !line.startsWith('---') ? ' remove' : line.startsWith('@@') ? ' hunk' : ''), line)));
    ui.diff.hidden = !result.text;
    status(ui['diff-status'], file + (result.note ? ' · ' + result.note : '') + (result.truncated ? ' · Diff truncated at 64 KB.' : !result.text ? ' · No textual diff.' : ''));
  } catch (error) { if (!controller.signal.aborted) status(ui['diff-status'], error.message || String(error), true); }
}
let searchMatches = [], matchIndex = -1, menuAnchor, pendingAction, menuScrollTop, menuScrollLeft;
function updateSearch(jump = true) {
  const query = ui.search.value.trim().toLocaleLowerCase();
  const previous = searchMatches[matchIndex];
  searchMatches = query ? state.commits.filter(commit => [commit.hash, commit.subject, commit.author, ...state.refs.filter(ref => ref.hash === commit.hash).map(ref => ref.label)].some(value => value.toLocaleLowerCase().includes(query))).map(commit => commit.hash) : [];
  matchIndex = searchMatches.length ? Math.max(0, searchMatches.indexOf(previous)) : -1;
  paintSearch(jump);
}
function paintSearch(jump) {
  const current = searchMatches[matchIndex];
  for (const row of ui.commits.querySelectorAll('.commit')) {
    row.classList.toggle('search-match', searchMatches.includes(row.dataset.hash));
    row.classList.toggle('search-current', row.dataset.hash === current);
  }
  ui['search-count'].textContent = ui.search.value.trim() ? (matchIndex + 1) + '/' + searchMatches.length : '';
  ui['search-count'].title = 'Matches in ' + state.commits.length + ' loaded commits. Load older commits to search further.';
  ui['search-prev'].disabled = ui['search-next'].disabled = !searchMatches.length;
  if (jump && current) ui.commits.querySelector('[data-hash="' + current + '"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function nextMatch(step) {
  if (!searchMatches.length) return;
  matchIndex = (matchIndex + step + searchMatches.length) % searchMatches.length;
  paintSearch(true);
}
ui.search.addEventListener('input', () => updateSearch());
ui.search.addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); nextMatch(event.shiftKey ? -1 : 1); }
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); ui.search.value = ''; updateSearch(false); }
});
ui['search-prev'].addEventListener('click', () => nextMatch(-1));
ui['search-next'].addEventListener('click', () => nextMatch(1));
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f' && !ui['action-dialog'].open && ui['settings-page'].hidden) { event.preventDefault(); ui.search.focus(); ui.search.select(); }
});

const menuItems = [
  ['tag', 'Add Tag…'], ['branch', 'Create Branch…'], null,
  ['checkout', 'Checkout…'], ['cherry-pick', 'Cherry Pick…'], ['revert', 'Revert…'], ['drop', 'Drop…'], null,
  ['merge', 'Merge into current branch…'], ['rebase', 'Rebase current branch on this Commit…'], ['reset', 'Reset current branch to this Commit…'], null,
  ['copy-hash', 'Copy Commit Hash to Clipboard'], ['copy-subject', 'Copy Commit Subject to Clipboard']
];
function closeMenu(focus = false) {
  ui['context-menu'].hidden = true;
  if (focus) menuAnchor?.focus({ preventScroll: true });
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const field = node('textarea'); field.value = text; field.setAttribute('aria-label', 'Clipboard text');
    field.style.position = 'fixed'; field.style.top = '-10000px'; document.body.append(field); field.select();
    const copied = document.execCommand('copy'); field.remove();
    if (!copied) throw new Error('Clipboard access was denied. Open commit details and copy the text manually.');
  }
}
function openMenu(commit, row, x, y) {
  if (state.busy || state.actionBusy || ui['action-dialog'].open) return;
  menuAnchor = row;
  menuScrollTop = ui.history.scrollTop; menuScrollLeft = ui.history.scrollLeft;
  const menu = ui['context-menu']; menu.replaceChildren();
  for (const item of menuItems) {
    if (!item) { const separator = node('hr'); separator.setAttribute('role', 'separator'); menu.append(separator); continue; }
    const [action, label] = item, button = node('button', '', label);
    button.type = 'button'; button.setAttribute('role', 'menuitem'); button.tabIndex = -1;
    button.disabled = !action.startsWith('copy-') && (!!state.operation || (['merge', 'rebase', 'reset', 'drop'].includes(action) && !state.branch) || (action === 'drop' && commit.parents.length !== 1));
    button.addEventListener('click', async () => {
      closeMenu(true);
      if (action.startsWith('copy-')) {
        try { await copyText(action === 'copy-hash' ? commit.hash : commit.subject); status(ui.status, 'Copied to clipboard.'); }
        catch (error) { status(ui.status, error.message, true); }
      } else openAction(action, commit);
    });
    menu.append(button);
  }
  menu.hidden = false; menu.style.left = '0px'; menu.style.top = '0px';
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(x, innerWidth - rect.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, innerHeight - rect.height - 8)) + 'px';
  menu.querySelector('button:not(:disabled)')?.focus();
}
ui['context-menu'].addEventListener('keydown', event => {
  const buttons = [...ui['context-menu'].querySelectorAll('button:not(:disabled)')];
  let index = buttons.indexOf(document.activeElement);
  if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); event.stopPropagation(); closeMenu(true); return; }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
  buttons[index]?.focus();
});
document.addEventListener('pointerdown', event => { if (!ui['context-menu'].contains(event.target)) closeMenu(); });
ui.history.addEventListener('scroll', () => {
  if (ui.history.scrollTop !== menuScrollTop || ui.history.scrollLeft !== menuScrollLeft) closeMenu();
}, { passive: true });
window.addEventListener('resize', () => closeMenu());
window.addEventListener('blur', () => closeMenu());

function openAction(action, commit) {
  if (state.busy || state.actionBusy) return;
  pendingAction = { action, ...(commit ? { hash: commit.hash } : {}), expectedHead: state.head, expectedBranch: state.branch, workspaceId: ui.workspace.value, operation: state.operation };
  const label = menuItems.find(item => item?.[0] === action)?.[1].replace(/…$/, '') || ({ continue: 'Continue ' + state.operation, abort: 'Abort ' + state.operation }[action]);
  ui['action-title'].textContent = label;
  const descriptions = {
    tag: 'Create a lightweight tag at this commit. Existing tags are never overwritten.',
    branch: 'Create a local branch at this commit without switching branches.',
    checkout: 'Check out this commit with a detached HEAD. Create a branch before making new commits you want to keep.',
    'cherry-pick': 'Apply this commit to HEAD and create a new commit. Conflicts may require resolution.',
    revert: 'Create a new commit that undoes this commit. Existing history is preserved.',
    drop: 'Remove this commit from the current branch and replay later commits. This rewrites history; do not use on shared commits. Only linear, non-root commits can be dropped.',
    merge: 'Merge this commit into the current branch. This may create a merge commit or require conflict resolution.',
    rebase: 'Replay the current branch on this commit, preserving merges. This rewrites commit IDs; do not rebase shared history.',
    reset: 'Move the current branch to this commit. This rewrites history. Hard reset also removes the file changes in commits you leave behind.',
    continue: 'Continue the in-progress operation after resolving conflicts and staging the resolved files outside Git Graph.',
    abort: 'Abort the in-progress operation and restore its starting state. Conflict-resolution edits will be lost.'
  };
  ui['action-description'].textContent = (state.workspaces.find(w => w.id === ui.workspace.value)?.path || '') + '\nCurrent branch: ' + (state.branch || 'Detached HEAD') + (commit ? '\nCommit: ' + commit.hash.slice(0, 12) + ' — ' + commit.subject : '') + '\n\n' + descriptions[action] + '\n\nGit hooks and commit/tag signing are disabled for these actions.';
  ui['action-name-label'].hidden = !['tag', 'branch'].includes(action);
  ui['action-name'].required = !ui['action-name-label'].hidden;
  ui['action-name'].value = '';
  ui['action-mode-label'].hidden = action !== 'reset'; ui['action-mode'].value = 'soft';
  ui['action-parent-label'].hidden = !(['cherry-pick', 'revert'].includes(action) && commit.parents.length > 1);
  ui['action-parent'].replaceChildren(...(commit?.parents || []).map((parent, i) => new Option((i + 1) + ' — ' + parent.slice(0, 12), String(i + 1))));
  ui['action-submit'].textContent = 'Confirm';
  ui['action-dialog'].showModal();
  (ui['action-name'].required ? ui['action-name'] : ui['action-cancel']).focus();
}
ui['action-cancel'].addEventListener('click', () => ui['action-dialog'].close());
ui['action-dialog'].addEventListener('close', () => { pendingAction = undefined; });
ui['action-form'].addEventListener('submit', async event => {
  event.preventDefault();
  if (!pendingAction || state.actionBusy) return;
  const input = { ...pendingAction, confirmed: true, name: ui['action-name'].value.trim(), mode: ui['action-mode'].value, mainline: Number(ui['action-parent'].value) };
  ui['action-dialog'].close();
  await executeAction(input);
});
async function executeAction(input) {
  if (state.busy || state.actionBusy) return;
  state.actionBusy = true; historyRequest?.abort(); detailRequest?.abort(); diffRequest?.abort(); setBusy(true);
  status(ui.status, 'Running ' + input.action + '…');
  let message, failed = false;
  try { message = (await request('action', input, new AbortController())).message; }
  catch (error) { message = error.message || String(error); failed = true; }
  finally {
    state.actionBusy = false;
    if (input.action !== 'fetch') ui.ref.value = '';
    await loadHistory(false, true);
    status(ui.status, message, failed);
  }
}
ui.pull.addEventListener('click', () => executeAction({ action: 'fetch', workspaceId: ui.workspace.value }));
ui['operation-continue'].addEventListener('click', () => openAction('continue'));
ui['operation-abort'].addEventListener('click', () => openAction('abort'));
function autoRefresh() {
  if (!ui['settings-page'].hidden || !window.orca?.plugin || document.hidden || state.busy || state.actionBusy || !ui.workspace.value || !ui['context-menu'].hidden || ui['action-dialog'].open || document.body.classList.contains('resizing')) return;
  void loadHistory(false, true);
}
// shortcut: poll only visible tabs every five seconds; use host file events if provided later.
const refreshTimer = setInterval(autoRefresh, 5000);
window.addEventListener('focus', autoRefresh);
document.addEventListener('visibilitychange', autoRefresh);
window.addEventListener('pagehide', () => { clearInterval(refreshTimer); historyRequest?.abort(); detailRequest?.abort(); diffRequest?.abort(); });

ui.refresh.addEventListener('click', refresh);
ui.workspace.addEventListener('change', () => { loadWorkspace().catch(error => status(ui.status, error.message, true)); });
ui.ref.addEventListener('change', () => loadHistory());
ui.more.addEventListener('click', () => loadHistory(true));
ui.close.addEventListener('click', () => closeDetails(true));
for (const mode of ['tree', 'list']) ui[mode + '-view'].addEventListener('click', () => { state.fileView = mode; renderFiles(state.files); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.defaultPrevented && !ui['action-dialog'].open && ui['settings-page'].hidden && !ui.details.hidden) { event.preventDefault(); closeDetails(true); } });
async function openLink(url) {
  try { await window.orca.shell.openExternal(url); }
  catch (error) { status(ui.status, error.message, true); }
}
function renderMessage(message) {
  ui.message.replaceChildren();
  let index = 0;
  for (const match of findIssueLinks(message, prefs.issueLinks)) {
    ui.message.append(document.createTextNode(message.slice(index, match.index)));
    const link = node('a', '', match.text); link.href = match.url;
    link.addEventListener('click', event => { event.preventDefault(); openLink(link.href); }); ui.message.append(link); index = match.index + match.text.length;
  }
  ui.message.append(document.createTextNode(message.slice(index)));
}

async function loadWorkspace() {
  historyRequest?.abort(); closeDetails(); setBusy(true);
  const workspaceId = ui.workspace.value;
  ui.workspace.title = state.workspaces.find(w => w.id === workspaceId)?.path || '';
  try {
    const value = await request('preferences', { workspaceId }, new AbortController());
    if (ui.workspace.value !== workspaceId) return;
    prefs = { ...defaults, ...value }; applyRowLayout();
    ui.ref.replaceChildren(new Option(prefs.initialBranch || 'All branches and tags', prefs.initialBranch));
    await loadHistory();
  } catch (error) { setBusy(false); status(ui.status, error.message, true); }
}
setupSettings({
  getWorkspace: () => state.workspaces.find(w => w.id === ui.workspace.value),
  getPreferences: () => prefs, getRefs: () => state.refs,
  onOpen: () => { closeMenu(); },
  onSave: async value => {
    const previous = prefs; prefs = value; applyRowLayout();
    if (['initialBranch', 'showTags', 'showStashes', 'includeReflogs', 'firstParent'].some(key => previous[key] !== value[key])) {
      if (previous.initialBranch !== value.initialBranch) ui.ref.replaceChildren(new Option(value.initialBranch || 'All branches', value.initialBranch));
      await loadHistory();
    } else {
      const scroll = ui.history.scrollTop;
      renderCommits(); ui.history.scrollTop = scroll;
      if (state.selected && state.selected !== WORKING) renderMessage(ui.message.textContent);
      if (previous.diffView !== value.diffView) { ui.diff.hidden = true; status(ui['diff-status'], 'Select a file to view its diff.'); }
    }
  }
});
if (window.orca?.plugin) {
  refresh().catch(error => { setBusy(false); status(ui.status, error.message || String(error), true); });
}
else { setBusy(false); ui.refresh.disabled = true; status(ui.status, 'Open Git Graph inside Orca to read your repositories.', true); }
