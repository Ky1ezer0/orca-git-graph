import { openCachedDiff } from './diff-cache.mjs';
import { readConfiguration, changeConfiguration, readPreferences, savePreferences } from './repository-settings.mjs';
import { runAction, operationState } from './actions.mjs';
import { readHistory, readDetails, readDiff, readWorkingDetails, readWorkingDiff } from './git.mjs';

export default function activate(orca) {
  async function list() {
    const result = await orca.host.call('workspace.list');
    const workspaces = result.workspaces.filter(item => item.hostId == null || item.hostId === 'local');
    return { workspaces, truncated: result.truncated, remoteCount: result.workspaces.length - workspaces.length };
  }
  async function selected(input) {
    if (!input || typeof input !== 'object' || typeof input.workspaceId !== 'string') throw new Error('Choose a local Git workspace.');
    const { workspaces } = await list();
    const workspace = workspaces.find(item => item.id === input.workspaceId);
    if (!workspace) throw new Error('This local workspace is no longer available. Refresh the workspace list.');
    return workspace.path;
  }
  function handle(name, callback) {
    orca.panels.handle(name, async (input, { signal }) => {
      const output = await callback(input, signal);
      if (Buffer.byteLength(JSON.stringify(output), 'utf8') > 900000) throw new Error('This result is too large for Orca. Try a narrower history filter.');
      return output;
    });
  }
  handle('workspaces', async () => {
    const [result, context] = await Promise.all([list(), orca.host.call('workspace.readContext')]);
    const matches = result.workspaces.filter(w => w.name === context?.displayName && w.branch === context?.branch);
    return { ...result, selectedId: matches.length === 1 ? matches[0].id : null };
  });
  handle('history', async (input, signal) => {
    const path = await selected(input);
    const preferences = await readPreferences(orca, path);
    return { ...await readHistory(path, { ...input, ...preferences, signal }), operation: await operationState(path) };
  });
  handle('preferences', async input => readPreferences(orca, await selected(input)));
  handle('preferences-save', async input => savePreferences(orca, await selected(input), input.preferences));
  handle('configuration', async input => readConfiguration(await selected(input)));
  handle('configuration-change', async input => changeConfiguration(await selected(input), input));
  handle('open-diff', async (input, signal) => openCachedDiff(await selected(input), input, signal));
  handle('action', async input => runAction(await selected(input), input));
  handle('details', async (input, signal) => readDetails(await selected(input), input.hash, signal));
  handle('diff', async (input, signal) => readDiff(await selected(input), input.hash, input.file, signal));
  handle('working-details', async (input, signal) => readWorkingDetails(await selected(input), signal));
  handle('working-diff', async (input, signal) => readWorkingDiff(await selected(input), input.file, signal));
}
