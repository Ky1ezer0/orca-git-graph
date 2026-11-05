(async () => {
const $ = s => document.querySelector(s), all = s => [...document.querySelectorAll(s)], sleep = () => new Promise(r => setTimeout(r, 100)), checks = [];
function check(ok, name) { if (!ok) throw Error(name); checks.push(name); }
window.__mode = 'normal'; window.__dirty = true; $('#refresh').click(); await sleep();
let row = $('.working-tree');
check(row === $('.commit') && all('.commit').length === 19, 'uncommitted changes appear above actual history');
check(row.querySelector('.subject').textContent === 'Uncommitted Changes (4)', 'working row shows changed file count');
check(row.querySelector('circle').getAttribute('stroke') === 'var(--muted)' && row.querySelector('circle').getAttribute('fill').includes('background'), 'uncommitted node is hollow and neutral');
check(row.querySelector('.commit-hash').textContent === '' && row.querySelector('.commit-date').textContent === '', 'working row does not fabricate commit IDs or dates');
const closed = row.querySelector('.graph').innerHTML; row.click(); await sleep();
check(row.nextElementSibling === $('.expansion') && !$('#details').hidden, 'working changes expand inline');
check($('.commit-metadata').hidden && $('#message').textContent.includes('1 staged') && $('#message').textContent.includes('2 untracked'), 'working metadata shows stages rather than commit author');
check($('#comparison').textContent.includes('Net changes against HEAD'), 'comparison basis is explicit');
check($('.file[data-path="src/edit.mjs"] .file-counts').textContent === '+13|-12', 'exact plus and minus counts render for edited files');
check($('.file[data-path="src/new.mjs"] .file-counts').textContent === '+5|-0', 'untracked additions show exact counts');
check($('.file[data-path="image.png"] .file-counts').textContent === 'Binary', 'binary files do not pretend to have numeric counts');
check($('.file[data-path="src/edit.mjs"] .file-stage').textContent === 'Staged + Unstaged', 'mixed staged and unstaged changes are labeled');
check($('.file[data-path="src/edit.mjs"]').getAttribute('aria-label').includes('13 lines added, 12 lines deleted'), 'counts are accessible');
$('.file[data-path="src/edit.mjs"]').click(); await sleep();
check(__requests.at(-1).name === 'working-diff' && !$('#diff').hidden, 'working file opens read-only working diff endpoint');
$('#list-view').click(); check(!$('.file-folder') && $('.file-counts').textContent === '+13|-12', 'flat list retains counts');
$('#tree-view').click(); check($('.file-folder') && $('.file[aria-pressed="true"]').dataset.path === 'src/edit.mjs', 'tree toggle preserves working diff selection');
$('#close').click(); check(row.querySelector('.graph').innerHTML === closed, 'closing details restores smooth graph geometry');
all('.commit')[1].click(); await sleep();
check(!$('.commit-metadata').hidden && $('#commit-id').textContent.length === 40, 'commit metadata returns after working view');
check($('.file[data-path="apps/core/src/graph.mjs"] .file-counts').textContent === '+13|-12', 'committed files show line counts too');
$('#more').click(); await sleep(); check(all('.working-tree').length === 1 && all('.commit').length === 20, 'pagination does not duplicate working row');
$('#ref').value = 'refs/heads/feature/graph-inline-details'; $('#ref').dispatchEvent(new Event('change')); await sleep();
check($('.working-tree') && !$('.working-tree .graph path') && all('.commit').length === 15, 'filtered history does not attach working changes to another branch');
window.__mode = 'empty'; $('#refresh').click(); await sleep();
check(all('.commit').length === 1 && $('.working-tree') && $('#empty').hidden, 'unborn repository can show changes without commits');
window.__mode = 'detail-error'; $('.working-tree').click(); await sleep(); check($('#detail-status').classList.contains('error'), 'working detail failures remain inline');
window.__dirty = false; window.__mode = 'normal'; $('#refresh').click(); await sleep();
check(!$('.working-tree') && all('.commit').length === 18, 'clean worktree removes synthetic row');
check(__errors.length === 0, 'no browser errors across working changes flow');
window.__dirty = true; $('#refresh').click(); await sleep();
return checks;
})()