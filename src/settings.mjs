import { defaults, preferences } from './preferences.mjs';

export function setupSettings({ getWorkspace, getPreferences, getRefs, onSave, onOpen }) {
  const $ = id => document.getElementById(id);
  let workspaceId = '', configuration, action, remote, busy = false, revision = 0;
  let draft, lastSaved, pending, saveTimer, saveTask, edits = 0;
  const fields = Object.keys(defaults).filter(key => key !== 'issueLinks');
  const call = (name, input = {}) => window.orca.plugin.request(name, { workspaceId, ...input });
  const status = (text, error = false) => { $('settings-status').textContent = text; $('settings-status').classList.toggle('error', error); };
  async function close() {
    if (busy) return;
    try { draft = preferences(readForm()); }
    catch (error) { status('Not applied: ' + error.message, true); return; }
    pending = draft;
    if (!await save()) return;
    revision++;
    $('settings-page').hidden = true; document.body.classList.remove('settings-open'); $('settings').focus();
  }
  function readIssueLinks() {
    return [...$('issue-links').children].map(row => ({ prefix: row.querySelector('.issue-prefix').value, url: row.querySelector('.issue-url').value }));
  }
  function readForm() {
    return { ...Object.fromEntries(fields.map(key => [key, $('setting-' + key)[typeof defaults[key] === 'boolean' ? 'checked' : 'value']])), issueLinks: readIssueLinks() };
  }
  function savedStatus() {
    try { preferences(readForm()); status('Changes saved automatically.'); }
    catch (error) { status('Not applied: ' + error.message, true); }
  }
  function save() {
    clearTimeout(saveTimer);
    if (saveTask) return saveTask;
    saveTask = (async () => {
      while (pending) {
        const value = pending; pending = undefined;
        if (JSON.stringify(value) === JSON.stringify(lastSaved)) continue;
        status('Applying changes…');
        try {
          const saved = await call('preferences-save', { preferences: value });
          await onSave(saved); lastSaved = saved;
        } catch (error) { status('Changes not saved: ' + error.message + ' Edit a setting or close settings to retry.', true); return false; }
      }
      savedStatus(); return true;
    })().finally(() => { saveTask = undefined; });
    return saveTask;
  }
  function changed(key, delay = 0) {
    edits++;
    try { draft = preferences({ ...draft, [key]: readForm()[key] }); }
    catch (error) { status('Not applied: ' + error.message, true); return; }
    pending = draft; clearTimeout(saveTimer);
    if (delay) saveTimer = setTimeout(save, delay);
    else void save();
  }
  function addIssueLink(rule = { prefix: '', url: '' }) {
    const row = document.createElement('fieldset'); row.className = 'issue-link';
    const legend = document.createElement('legend'); row.append(legend);
    for (const [key, label, max, placeholder] of [['prefix', 'Issue prefix', 40, '# or PROJ-'], ['url', 'Issue URL template', 2000, 'https://example.com/issues/{issue}']]) {
      const wrapper = document.createElement('label'), input = document.createElement('input');
      input.className = 'issue-' + key; input.type = 'text'; input.maxLength = max; input.placeholder = placeholder; input.autocomplete = 'off'; input.value = rule[key];
      wrapper.append(document.createTextNode(label), input); row.append(wrapper);
    }
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      const focus = row.nextElementSibling?.querySelector('input') || row.previousElementSibling?.querySelector('input') || $('issue-link-add');
      row.remove(); labelIssueLinks(); changed('issueLinks'); focus.focus();
    });
    row.append(remove); $('issue-links').append(row); labelIssueLinks(); return row;
  }
  function labelIssueLinks() {
    [...$('issue-links').children].forEach((row, index) => {
      row.querySelector('legend').textContent = 'Issue link ' + (index + 1);
      row.querySelector('button').setAttribute('aria-label', 'Remove issue link ' + (index + 1));
    });
    $('issue-link-add').disabled = $('issue-links').children.length >= 20;
  }
  $('issue-link-add').addEventListener('click', () => { addIssueLink().querySelector('input').focus(); status('Enter a prefix and URL to apply this rule.'); });
  $('preferences-form').addEventListener('input', event => {
    if (event.isComposing) return;
    const key = event.target.closest('.issue-link') ? 'issueLinks' : event.target.id.replace('setting-', '');
    if (key in defaults) changed(key, event.target.type === 'text' ? 250 : 0);
  });
  $('preferences-form').addEventListener('compositionend', event => event.target.dispatchEvent(new Event('input', { bubbles: true })));
  $('preferences-form').addEventListener('submit', event => { event.preventDefault(); void save(); });
  function renderConfiguration(value) {
    configuration = value;
    const user = $('settings-user'); user.replaceChildren();
    for (const [label, text] of [['Name', value.user.name || 'Not configured'], ['Email', value.user.email || 'Not configured']]) {
      const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = text; user.append(dt, dd);
    }
    $('identity-remove').disabled = !(value.user.hasLocalName || value.user.hasLocalEmail);
    $('settings-remotes').replaceChildren();
    for (const item of value.remotes) {
      const row = document.createElement('div'); row.className = 'remote-setting';
      const title = document.createElement('strong'); title.textContent = item.name; row.append(title);
      for (const [label, urls] of [['Fetch', item.fetchUrls], ['Push', item.pushUrls.length ? item.pushUrls : item.fetchUrls]]) {
        const p = document.createElement('p'); p.textContent = label + ': ' + (urls.join(', ') || 'Inherited / not locally configured'); row.append(p);
      }
      const buttons = document.createElement('div'); buttons.className = 'setting-buttons';
      for (const [verb, label] of [['remote-edit', 'Edit…'], ['remote-remove', 'Remove…']]) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.setAttribute('aria-label', label.replace('…', '') + ' remote ' + item.name);
        button.addEventListener('click', () => configure(verb, item)); buttons.append(button);
      }
      row.append(buttons); $('settings-remotes').append(row);
    }
    if (!value.remotes.length) $('settings-remotes').textContent = 'No remotes configured.';
  }
  async function open() {
    if (busy || saveTask) return;
    const workspace = getWorkspace(); if (!workspace) return;
    const current = ++revision;
    workspaceId = workspace.id; configuration = undefined; onOpen();
    $('settings-page').hidden = false; document.body.classList.add('settings-open');
    $('settings-repository').textContent = workspace.path;
    const initial = $('setting-initialBranch'); initial.replaceChildren(new Option('Show all', ''), new Option('Current branch / HEAD', 'HEAD'));
    for (const ref of getRefs().filter(r => r.kind !== 'stash')) initial.add(new Option(ref.label, ref.name));
    const prefs = preferences(getPreferences());
    draft = lastSaved = prefs; pending = undefined; edits = 0; clearTimeout(saveTimer);
    if (prefs.initialBranch && ![...initial.options].some(option => option.value === prefs.initialBranch)) initial.add(new Option(prefs.initialBranch + ' (unavailable)', prefs.initialBranch));
    for (const key of fields) {
      const input = $('setting-' + key); input[typeof defaults[key] === 'boolean' ? 'checked' : 'value'] = prefs[key];
    }
    $('issue-links').replaceChildren(); prefs.issueLinks.forEach(addIssueLink); labelIssueLinks();
    $('settings-close').focus(); status('Reading repository configuration…');
    for (const id of ['identity-edit', 'identity-remove', 'remote-add']) $(id).disabled = true;
    try {
      const value = await call('configuration'); if (current !== revision) return;
      renderConfiguration(value); $('identity-edit').disabled = $('remote-add').disabled = false; if (!edits) status('Changes apply automatically.');
    } catch (error) { if (current === revision) status(error.message, true); }
  }
  $('settings').addEventListener('click', open);
  $('settings-close').addEventListener('click', close);
  $('settings-page').addEventListener('keydown', event => { if (event.key === 'Escape' && !$('config-dialog').open) { event.preventDefault(); event.stopPropagation(); close(); } });
  function configure(verb, item) {
    if (!configuration || busy) return;
    action = verb; remote = item;
    const identity = verb.startsWith('identity'), remove = verb.endsWith('remove');
    $('config-title').textContent = ({ identity: 'Edit repository identity', 'identity-remove': 'Remove local identity', 'remote-add': 'Add remote', 'remote-edit': 'Edit remote', 'remote-remove': 'Remove remote' })[verb];
    $('config-description').textContent = getWorkspace().path + '\n\n' + (remove ? identity ? 'Remove the repository-local name and email. Global or inherited values will apply. Existing commits are unchanged.' : 'Remove ' + item.name + ' and its remote-tracking references. Local branches and remote server data are unchanged.' : 'Write these values to this repository’s Git configuration only. No commits are modified and no network request is made.');
    $('config-identity').hidden = !identity || remove; $('config-remote').hidden = identity || remove;
    $('config-user-name').value = configuration.user.name; $('config-user-email').value = configuration.user.email;
    $('config-remote-name').value = item?.name || ''; $('config-remote-name').disabled = verb !== 'remote-add';
    $('config-fetch-url').value = item?.fetchUrls[0] || ''; $('config-push-url').value = item?.pushUrls[0] || '';
    for (const id of ['config-user-name', 'config-user-email']) $(id).required = identity && !remove;
    for (const id of ['config-remote-name', 'config-fetch-url']) $(id).required = !identity && !remove;
    $('config-status').textContent = ''; $('config-status').classList.remove('error'); $('config-dialog').showModal(); $('config-cancel').focus();
  }
  $('identity-edit').addEventListener('click', () => configure('identity'));
  $('identity-remove').addEventListener('click', () => configure('identity-remove'));
  $('remote-add').addEventListener('click', () => configure('remote-add'));
  $('config-cancel').addEventListener('click', () => { if (!busy) $('config-dialog').close(); });
  $('config-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  $('config-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return;
    const input = { action, snapshot: configuration.snapshot, confirmed: true };
    if (action === 'identity') Object.assign(input, { name: $('config-user-name').value, email: $('config-user-email').value });
    if (action.startsWith('remote')) Object.assign(input, { name: remote?.name || $('config-remote-name').value, fetchUrl: $('config-fetch-url').value, pushUrl: $('config-push-url').value });
    busy = true; $('config-submit').disabled = $('config-cancel').disabled = true;
    $('config-status').textContent = 'Updating repository configuration…';
    try { renderConfiguration(await call('configuration-change', input)); $('config-dialog').close(); status('Repository configuration updated.'); }
    catch (error) { $('config-status').textContent = error.message + ' Reopen settings before retrying if configuration was partially changed.'; $('config-status').classList.add('error'); }
    finally { busy = false; $('config-submit').disabled = $('config-cancel').disabled = false; }
  });
}
