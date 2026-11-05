// Run with PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node tests/ui-check.mjs
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const server=createServer(async(req,res)=>{try{const path=new URL(req.url,'http://localhost').pathname; const data=await readFile(root+path);res.setHeader('Content-Type',path.endsWith('.mjs')?'text/javascript':path.endsWith('.css')?'text/css':'text/html');res.end(data);}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true});
try {
const page=await browser.newPage({viewport:{width:1440,height:900}});
await page.addInitScript({content:await readFile(root+'/tests/ui-fixture.js','utf8')});
await page.addInitScript(()=>{window.__version=0;window.__operation='';const original=window.orca.plugin.request;window.orca.plugin.request=async(name,input,options)=>{if(options?.timeoutMs>120000)throw Error('timeoutMs exceeds Orca limit');JSON.stringify(input,(_key,value)=>{if(value===undefined)throw Error('input: Invalid input');return value;});if(name==='action'){window.__requests.push({name,input});if(window.__fail)throw Error('Resolve conflicts');window.__version++;return {message:'Action done'};}const result=await original(name,input);if(name==='history'){result.snapshot='fixture'+window.__version;result.workingSnapshot=String(window.__dirty)+window.__version;result.operation=window.__operation;}return result;};});
await page.goto('http://127.0.0.1:'+server.address().port+'/src/panel.html');
await page.waitForSelector('.commit');
const grouped = page.locator('.ref.grouped');
assert.equal(await grouped.count(),1);
assert.equal(await grouped.locator('.ref-name').textContent(),'feature/graph-inline-details');
assert.equal(await grouped.locator('.ref-remote').textContent(),'origin');
assert.equal(await grouped.getAttribute('title'),'feature/graph-inline-details\norigin/feature/graph-inline-details');
assert.match(await grouped.locator('xpath=ancestor::button').getAttribute('aria-label'),/origin\/feature\/graph-inline-details/);
assert.equal(await page.locator('#ref option[value="refs/heads/feature/graph-inline-details"]').count(),1);
assert.equal(await page.locator('#ref option[value="refs/remotes/origin/feature/graph-inline-details"]').count(),1);
await page.locator('#search').fill('origin/feature/graph-inline-details');
assert.equal(await page.locator('.search-match').count(),1);
await page.locator('#search').fill('');

assert.doesNotMatch(await page.locator('#status').textContent(),/Auto-refresh/);
console.log('existing working tests:',(await page.evaluate(await readFile(root+'/tests/working-check.js','utf8'))).length);
await page.locator('#search').fill('Merge');assert.equal(await page.locator('.search-match').count(),5);
const first=await page.locator('.search-current').getAttribute('data-hash');await page.locator('#search').press('Enter');assert.notEqual(await page.locator('.search-current').getAttribute('data-hash'),first);await page.locator('#search').press('Shift+Enter');assert.equal(await page.locator('.search-current').getAttribute('data-hash'),first);
await page.locator('#search').fill('not-a-match');assert.equal(await page.locator('#search-count').textContent(),'0/0');await page.locator('#search').press('Escape');
assert.equal(await page.locator('.search-match').count(),0);
await page.locator('.commit:not(.working-tree)').first().click({button:'right'});assert.equal(await page.locator('#context-menu button').count(),11);
await page.screenshot({path:join(tmpdir(),'graph-menu-desktop.png')});
await page.getByRole('menuitem',{name:'Create Branch…',exact:true}).click();await page.locator('#action-name').fill('feature/test');await page.locator('#action-submit').click();await page.waitForFunction(()=>document.querySelector('#status').textContent==='Action done');
let action=await page.evaluate(()=>__requests.filter(r=>r.name==='action').at(-1).input);assert.equal(action.name,'feature/test');assert.equal(action.confirmed,true);assert.equal(action.expectedBranch,'main');
await page.locator('#pull').click();
assert.equal(await page.locator('#action-dialog').isVisible(),false);
await page.waitForFunction(()=>__requests.filter(r=>r.name==='action').length===2 && !document.querySelector('#pull').disabled);
assert.deepEqual(await page.evaluate(()=>__requests.filter(r=>r.name==='action').at(-1).input),{action:'fetch',workspaceId:'one'});
await page.locator('.commit:not(.working-tree)').first().focus();await page.keyboard.press('Shift+F10');assert.equal(await page.locator('#context-menu').isVisible(),true);await page.keyboard.press('ArrowDown');assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Create Branch…');await page.keyboard.press('Escape');assert.equal(await page.locator('#context-menu').isVisible(),false);
await page.evaluate(()=>{window.__dirty=false;window.__version++;window.dispatchEvent(new Event('focus'));});await page.waitForFunction(()=>!document.querySelector('.working-tree'));
await page.locator('.commit').first().click();await page.waitForSelector('#detail-content:not([hidden])');const selected=await page.locator('#commit-id').textContent();
await page.evaluate(()=>{window.__version++;window.dispatchEvent(new Event('focus'));});await page.waitForTimeout(120);assert.equal(await page.locator('#commit-id').textContent(),selected);assert.equal(await page.locator('#details').isVisible(),true);
const n=await page.evaluate(()=>__requests.filter(r=>r.name==='history').length);await page.waitForTimeout(5200);assert.ok(await page.evaluate(()=>__requests.filter(r=>r.name==='history').length)>n);
await page.evaluate(()=>{window.__operation='rebase';window.__version++;window.dispatchEvent(new Event('focus'));});await page.waitForSelector('#operation-bar:not([hidden])');assert.equal(await page.locator('#pull').isDisabled(),false);
await page.locator('#operation-abort').click();assert.match(await page.locator('#action-title').textContent(),/Abort rebase/);await page.locator('#action-cancel').click();
await page.setViewportSize({width:390,height:844});await page.evaluate(()=>{document.documentElement.className='light';document.documentElement.style.setProperty('--orca-background','#fff');document.documentElement.style.setProperty('--orca-foreground','#222');document.documentElement.style.setProperty('--orca-muted','#f5f5f5');});
await page.locator('.commit').first().click({button:'right'});const bounds=await page.locator('#context-menu').boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=390);assert.ok(bounds.y>=0&&bounds.y+bounds.height<=844);
assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:join(tmpdir(),'graph-menu-narrow.png')});
assert.deepEqual(await page.evaluate(()=>__errors),[]);console.log('search, menus, confirmation, cancel, pull, keyboard, focus refresh, timer refresh, selection, recovery and narrow bounds passed');
// Exercise every menu route, not just the shared confirmation form.
await page.keyboard.press('Escape');
await page.evaluate(()=>{window.__operation='';window.__version++;window.dispatchEvent(new Event('focus'));});
await page.waitForFunction(()=>document.querySelector('#operation-bar').hidden && !document.querySelector('#pull').disabled);
for (const [label,action] of [['Add Tag…','tag'],['Checkout…','checkout'],['Cherry Pick…','cherry-pick'],['Revert…','revert'],['Drop…','drop'],['Merge into current branch…','merge'],['Rebase current branch on this Commit…','rebase'],['Reset current branch to this Commit…','reset']]) {
  await page.locator('.commit:not(.working-tree)').first().click({button:'right'});
  await page.getByRole('menuitem',{name:label,exact:true}).click();
  if(action==='tag') await page.locator('#action-name').fill('ui-tag');
  if(action==='reset') await page.locator('#action-mode').selectOption('hard');
  const before=await page.evaluate(()=>__requests.filter(r=>r.name==='action').length);
  await page.locator('#action-submit').click();
  await page.waitForFunction(n=>__requests.filter(r=>r.name==='action').length===n+1 && !document.querySelector('#pull').disabled,before);
  const sent=await page.evaluate(()=>__requests.filter(r=>r.name==='action').at(-1).input);
  assert.equal(sent.action,action); assert.equal(sent.confirmed,true);assert.equal(sent.workspaceId,'one');
  if(action==='reset')assert.equal(sent.mode,'hard');
  if(action==='tag')assert.equal(sent.name,'ui-tag');
}
await page.context().grantPermissions(['clipboard-read','clipboard-write']);
for(const [label,field] of [['Copy Commit Hash to Clipboard','hash'],['Copy Commit Subject to Clipboard','subject']]) {
  const row=page.locator('.commit:not(.working-tree)').first();
  const expected=field==='hash'?await row.getAttribute('data-hash'):await row.locator('.subject').textContent();
  await row.click({button:'right'});await page.getByRole('menuitem',{name:label,exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#status').textContent==='Copied to clipboard.');
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),expected);
}
await page.locator('.commit:not(.working-tree)').nth(1).click({button:'right'});await page.getByRole('menuitem',{name:'Cherry Pick…',exact:true}).click();
assert.equal(await page.locator('#action-parent-label').isVisible(),true);await page.locator('#action-parent').selectOption('2');await page.locator('#action-submit').click();await page.waitForFunction(()=>!document.querySelector('#pull').disabled);
assert.equal(await page.evaluate(()=>__requests.filter(r=>r.name==='action').at(-1).input.mainline),2);
await page.evaluate(()=>window.__fail=true);await page.locator('#pull').click();await page.waitForFunction(()=>document.querySelector('#status').textContent==='Resolve conflicts');assert.equal(await page.locator('#status').evaluate(el=>el.classList.contains('error')),true);assert.equal(await page.locator('#pull').isEnabled(),true);await page.evaluate(()=>window.__fail=false);
for(const query of ['Alex Chen','feature/graph-inline-details','0000000000000000000000000000000000000012']){await page.locator('#search').fill(query);assert.ok(await page.locator('.search-match').count()>0);}
await page.locator('#search').fill('Merge');const cur=await page.locator('.search-current').getAttribute('data-hash');await page.locator('#search-next').click();assert.notEqual(await page.locator('.search-current').getAttribute('data-hash'),cur);await page.locator('#search-prev').click();assert.equal(await page.locator('.search-current').getAttribute('data-hash'),cur);await page.locator('#search').fill('');
await page.keyboard.press('Control+f');assert.equal(await page.locator('#search').evaluate(el=>el===document.activeElement),true);
await page.locator('.commit:not(.working-tree)').first().click({button:'right'});await page.getByRole('menuitem',{name:'Checkout…',exact:true}).click();const count=await page.evaluate(()=>__requests.filter(r=>r.name==='history').length);await page.waitForTimeout(5200);assert.equal(await page.evaluate(()=>__requests.filter(r=>r.name==='history').length),count);await page.locator('#action-cancel').click();
assert.deepEqual(await page.evaluate(()=>__errors),[]);console.log('all menu dispatches, clipboard, mainline, error recovery, search fields/buttons/shortcut and dialog polling pause passed');
// Sidebar layout stays readable without scrolling the entire history sideways.
await page.evaluate(()=>{window.__dirty=true;window.__version++;document.documentElement.className='dark';for(const [key,value] of Object.entries({'--orca-background':'#0e1018','--orca-foreground':'#d4d4d4','--orca-muted':'#191b22','--orca-border':'#30323b','--orca-accent':'#30333d'}))document.documentElement.style.setProperty(key,value);});
await page.locator('#refresh').click();await page.waitForSelector('.working-tree');
await page.locator('.working-tree').click();await page.waitForSelector('#detail-content:not([hidden])');
await page.locator('.file[data-path="src/edit.mjs"]').click();await page.waitForSelector('#diff:not([hidden])');
const diffText=await page.locator('#diff').textContent();
for(const width of [320,453,760,1000,390]) {
  await page.setViewportSize({width,height:900});
  const narrow=width<=760;
  await page.waitForFunction(height=>document.querySelector('.commit .graph').getAttribute('height')===String(height),narrow?64:36);
  assert.equal(await page.locator('.columns').isVisible(),!narrow);
  assert.equal((await page.locator('.commit').first().boundingBox()).height,narrow?64:36);
  assert.equal(await page.locator('#details').isVisible(),true);
  assert.equal(await page.locator('#diff').textContent(),diffText);
  assert.equal(await page.locator('.file[aria-pressed="true"]').getAttribute('data-path'),'src/edit.mjs');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  if(narrow) {
    assert.equal(await page.locator('#history').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
    assert.equal(await page.locator('#details').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
    assert.equal(await page.locator('.graph-continuation').isVisible(),false);
    const tools=await page.locator('.detail-tools').boundingBox(),info=await page.locator('.commit-info').boundingBox(),files=await page.locator('.changed-files').boundingBox();
    assert.ok(tools.y+tools.height<=info.y+1,'details controls precede metadata');
    assert.ok(files.y>=info.y+info.height-1,'changed files stack below metadata');
    assert.equal(await page.locator('.commit:not(.working-tree) .commit-meta').first().isVisible(),true);
  }
  if(width===453||width===1000)await page.screenshot({path:join(tmpdir(),'graph-sidebar-details-'+width+'.png')});
}
await page.locator('#close').click();
await page.locator('#search').fill('Merge');assert.equal(await page.locator('#search-next').isVisible(),true);await page.locator('#search').fill('');
await page.locator('.commit').first().focus();await page.keyboard.press('ArrowDown');
assert.equal(await page.evaluate(()=>document.activeElement.classList.contains('commit')),true);
await page.keyboard.press('Shift+F10');assert.equal(await page.locator('#context-menu').isVisible(),true);
await page.locator('#history').dispatchEvent('scroll');assert.equal(await page.locator('#context-menu').isVisible(),true,'queued unchanged scroll must not dismiss a new menu');
await page.locator('#history').evaluate(el=>el.scrollTop+=100);await page.waitForSelector('#context-menu',{state:'hidden'});
await page.setViewportSize({width:453,height:885});await page.locator('#history').evaluate(el=>el.scrollTop=0);
await page.screenshot({path:join(tmpdir(),'graph-sidebar-list.png')});
assert.deepEqual(await page.evaluate(()=>__errors),[]);console.log('sidebar widths 320/390/453/760, wide layout, stacked details, preserved diff, keyboard and menu-scroll regression passed');
// Compact removes unused badge space without changing the responsive arrangement.
async function checkRowPadding(mode) {
  for (const width of [320,453,760,1000]) {
    await page.setViewportSize({width,height:900});
    const narrow=width<=760,padding=mode==='compact'?0:4,height=mode==='compact'?(narrow?38:24):(narrow?64:36);
    await page.waitForFunction(height=>document.querySelector('.commit .graph').getAttribute('height')===String(height),height);
    assert.equal(await page.locator('.columns').isVisible(),!narrow,mode+' preserves the responsive arrangement');
    const rows=await page.locator('.commit').evaluateAll(elements=>elements.map(el=>{
      const row=el.getBoundingClientRect(),graph=el.querySelector('.graph').getBoundingClientRect(),summary=el.querySelector('.summary').getBoundingClientRect(),style=getComputedStyle(el);
      return {hasRefs:!!el.querySelector('.refs'),height:row.height,top:row.top,bottom:row.bottom,graphTop:graph.top,graphBottom:graph.bottom,paddingTop:style.paddingTop,paddingBottom:style.paddingBottom,summaryFits:summary.top>=row.top&&summary.bottom<=row.bottom};
    }));
    assert.ok(rows.some(row=>row.hasRefs)&&rows.some(row=>!row.hasRefs),'covers rows with and without badges');
    for(const row of rows) {
      assert.equal(row.height,height+(mode==='compact'&&narrow&&row.hasRefs?16:0));assert.equal(row.paddingTop,padding+'px');assert.equal(row.paddingBottom,padding+'px');
      assert.ok(Math.abs(row.graphTop-row.top)<1&&Math.abs(row.graphBottom-row.bottom)<1,'graph spans full padded row');
      assert.ok(row.summaryFits,'subject, refs and metadata fit without clipping');
    }
    const groupedBounds = await page.locator('.ref.grouped').evaluate(el => {
      const badge = el.getBoundingClientRect(), name = el.querySelector('.ref-name').getBoundingClientRect(), remote = el.querySelector('.ref-remote').getBoundingClientRect();
      return name.width > 20 && remote.width > 20 && remote.right <= badge.right && name.top >= badge.top && name.bottom <= badge.bottom;
    });
    assert.ok(groupedBounds, 'grouped branch and origin remain visible within the badge');
    if(narrow)assert.equal(await page.locator('#history').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
    if(width===453||width===1000)await page.screenshot({path:join(tmpdir(),'graph-padding-'+mode+'-'+width+'.png')});
  }
}
// Repository settings and cache-backed main-panel diff dispatch.
await page.locator('#settings').click();await page.waitForSelector('#identity-edit:enabled');
assert.equal(await page.locator('#history').isVisible(),false);
await page.locator('#setting-layout').selectOption('compact');
await page.locator('#setting-diffView').selectOption('main');
await page.locator('#setting-initialBranch').selectOption('HEAD');
await page.locator('#setting-showStashes').check();await page.locator('#setting-showTags').uncheck();
await page.locator('#setting-includeReflogs').check();await page.locator('#setting-firstParent').check();
assert.equal(await page.locator('#settings-save').count(),0);
assert.equal(await page.getByRole('heading',{name:'Pull Request Creation',exact:true}).count(),0);
await page.locator('#issue-link-add').click();
await page.locator('.issue-prefix').first().fill('#');
await page.locator('.issue-url').first().fill('javascript:alert({issue})');
await page.waitForFunction(()=>document.querySelector('#settings-status').textContent.includes('HTTPS'));
assert.equal(await page.locator('#setting-name').count(),0);
await page.locator('#setting-firstParent').uncheck();
await page.waitForFunction(()=>!__preferences.firstParent);
await page.locator('#setting-firstParent').check();
await page.waitForFunction(()=>__preferences.firstParent);
assert.deepEqual(await page.evaluate(()=>__preferences.issueLinks),[],'invalid issue rules are not saved, unrelated settings still apply');
await page.locator('#settings-close').click();assert.equal(await page.locator('#settings-page').isVisible(),true,'invalid rule remains visible for correction');
await page.locator('.issue-url').first().fill('https://example.invalid/issues/{issue}');
await page.waitForFunction(()=>__preferences.issueLinks.length===1);
await page.locator('#issue-link-add').click();
await page.locator('.issue-prefix').nth(1).fill('PROJ-');
await page.locator('.issue-url').nth(1).fill('https://tracker.invalid/browse/PROJ-{issue}');
await page.waitForFunction(()=>__preferences.issueLinks.length===2&&document.querySelector('#settings-status').textContent==='Changes saved automatically.');
const savedPreferences=await page.evaluate(()=>__preferences);
assert.equal(savedPreferences.layout,'compact');assert.equal(savedPreferences.diffView,'main');assert.equal(savedPreferences.showStashes,true);
assert.equal(savedPreferences.includeReflogs,true);assert.equal(savedPreferences.firstParent,true);assert.equal(savedPreferences.showTags,false);
assert.equal(await page.evaluate(()=>__requests.filter(r=>r.name==='history').at(-1).input.ref),'HEAD');
for(const width of [320,453,1000]) {
  await page.setViewportSize({width,height:900});
  assert.equal(await page.locator('#settings-page').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
  await page.locator('.settings-scroll').evaluate(el => { el.scrollTop = 0; });
  if(width===453||width===1000)await page.screenshot({path:join(tmpdir(),'graph-settings-general-'+width+'.png')});
  await page.locator('#issue-link-add').scrollIntoViewIfNeeded();
  assert.equal(await page.locator('#settings-page').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
  if(width===453||width===1000)await page.screenshot({path:join(tmpdir(),'graph-issue-links-'+width+'.png')});
}
await page.locator('#identity-edit').click();await page.locator('#config-user-name').fill('UI tester');await page.locator('#config-user-email').fill('ui@example.invalid');
const changesBefore=await page.evaluate(()=>__requests.filter(r=>r.name==='configuration-change').length);
await page.locator('#config-cancel').click();assert.equal(await page.evaluate(()=>__requests.filter(r=>r.name==='configuration-change').length),changesBefore);
await page.locator('#identity-edit').click();await page.locator('#config-user-name').fill('UI tester');await page.locator('#config-user-email').fill('ui@example.invalid');await page.locator('#config-submit').click();await page.waitForSelector('#config-dialog',{state:'hidden'});
let configSent=await page.evaluate(()=>__requests.filter(r=>r.name==='configuration-change').at(-1).input);assert.equal(configSent.action,'identity');assert.equal(configSent.confirmed,true);assert.equal(configSent.name,'UI tester');
await page.locator('#remote-add').click();await page.locator('#config-remote-name').fill('upstream');await page.locator('#config-fetch-url').fill('https://example.invalid/upstream.git');await page.locator('#config-submit').click();await page.waitForSelector('#config-dialog',{state:'hidden'});
configSent=await page.evaluate(()=>__requests.filter(r=>r.name==='configuration-change').at(-1).input);assert.equal(configSent.action,'remote-add');assert.equal(configSent.name,'upstream');
await page.getByRole('button',{name:'Edit remote origin',exact:true}).click();await page.locator('#config-fetch-url').fill('https://example.invalid/updated.git');await page.locator('#config-submit').click();await page.waitForSelector('#config-dialog',{state:'hidden'});
assert.equal(await page.evaluate(()=>__requests.filter(r=>r.name==='configuration-change').at(-1).input.action),'remote-edit');
await page.getByRole('button',{name:'Remove remote origin',exact:true}).click();assert.match(await page.locator('#config-description').textContent(),/remote-tracking references/);await page.locator('#config-submit').click();await page.waitForSelector('#config-dialog',{state:'hidden'});
assert.equal(await page.evaluate(()=>__requests.filter(r=>r.name==='configuration-change').at(-1).input.action),'remote-remove');
await page.evaluate(()=>window.__configFail=true);await page.locator('#identity-edit').click();await page.locator('#config-submit').click();await page.waitForFunction(()=>document.querySelector('#config-status').textContent.includes('Configuration changed'));await page.locator('#config-cancel').click();await page.evaluate(()=>window.__configFail=false);
await page.setViewportSize({width:453,height:885});await page.locator('#remote-add').scrollIntoViewIfNeeded();await page.screenshot({path:join(tmpdir(),'graph-settings-remotes.png')});
await page.locator('#settings-close').click();await page.setViewportSize({width:1000,height:900});
await checkRowPadding('compact');
await page.locator('.working-tree').click();await page.waitForSelector('#detail-content:not([hidden])');await page.locator('.file[data-path="src/edit.mjs"]').click();
await page.waitForFunction(()=>document.querySelector('#diff-status').textContent.includes('Opened read-only diff'));
assert.equal(await page.locator('#diff').isVisible(),false);
assert.deepEqual(await page.evaluate(()=>__requests.filter(r=>r.name==='open-diff').at(-1).input),{workspaceId:'one',hash:'working-tree',file:'src/edit.mjs'});
const opened=await page.evaluate(()=>__requests.filter(r=>r.name==='open-diff').length);
await page.evaluate(()=>{window.__version++;window.dispatchEvent(new Event('focus'));});await page.waitForTimeout(200);
assert.equal(await page.evaluate(()=>__requests.filter(r=>r.name==='open-diff').length),opened,'auto-refresh never opens or focuses diff tabs');
await page.evaluate(()=>window.__openFail=true);await page.locator('.file[data-path="src/edit.mjs"]').click();await page.waitForFunction(()=>document.querySelector('#diff-status').textContent.includes('Could not open'));assert.equal(await page.locator('#diff-status').evaluate(el=>el.classList.contains('error')),true);await page.evaluate(()=>window.__openFail=false);
await page.locator('.commit:not(.working-tree)').first().click();await page.waitForSelector('#detail-content:not([hidden])');await page.locator('.file').first().click();await page.waitForFunction(()=>document.querySelector('#diff-status').textContent.includes('Opened read-only diff'));
assert.equal(await page.evaluate(()=>__requests.filter(r=>r.name==='open-diff').at(-1).input.hash),await page.locator('.commit[aria-pressed="true"]').getAttribute('data-hash'));
await page.locator('#message').getByRole('link',{name:'#123',exact:true}).click();assert.equal(await page.evaluate(()=>__external.at(-1)),'https://example.invalid/issues/123');
await page.locator('#message').getByRole('link',{name:'PROJ-456',exact:true}).click();assert.equal(await page.evaluate(()=>__external.at(-1)),'https://tracker.invalid/browse/PROJ-456');
assert.equal(await page.locator('#message img').count(),0);
await page.locator('.commit:not(.working-tree)').first().click({button:'right'});assert.equal(await page.getByRole('menuitem',{name:/Open pull request/}).count(),0);await page.keyboard.press('Escape');
await page.locator('#settings').click();await page.waitForSelector('#identity-edit:enabled');assert.equal(await page.locator('#setting-layout').inputValue(),'compact');
assert.equal(await page.locator('.issue-link').count(),2,'rules persist across settings reopen');
await page.evaluate(()=>window.__saveDelay=180);
await page.locator('#setting-layout').selectOption('flexible');
await page.locator('#setting-layout').selectOption('compact');
await page.locator('#setting-layout').selectOption('flexible');
await page.locator('#settings-close').click();await page.waitForSelector('#settings-page',{state:'hidden'});
assert.equal(await page.evaluate(()=>__preferences.layout),'flexible');
assert.equal(await page.evaluate(()=>'name' in __preferences),false);
assert.equal(await page.locator('#workspace option:checked').textContent(),'graph · main');
assert.equal(await page.locator('.columns').isVisible(),true);
await page.evaluate(()=>window.__saveDelay=0);
await page.locator('#settings').click();await page.waitForSelector('#identity-edit:enabled');
await page.locator('.issue-prefix').nth(1).fill('#');await page.waitForFunction(()=>document.querySelector('#settings-status').textContent.includes('different prefix'));
assert.equal(await page.evaluate(()=>__preferences.issueLinks[1].prefix),'PROJ-');
await page.locator('.issue-prefix').nth(1).fill('PROJ-');await page.waitForFunction(()=>document.querySelector('#settings-status').textContent==='Changes saved automatically.');
await page.getByRole('button',{name:'Remove issue link 1',exact:true}).click();await page.waitForFunction(()=>__preferences.issueLinks.length===1);
assert.equal(await page.evaluate(()=>__preferences.issueLinks[0].prefix),'PROJ-');
await page.getByRole('button',{name:'Remove issue link 1',exact:true}).click();await page.waitForFunction(()=>__preferences.issueLinks.length===0);
await page.locator('#issue-link-add').click();await page.getByRole('button',{name:'Remove issue link 1',exact:true}).click();
await page.evaluate(()=>window.__saveFail=true);
await page.locator('#setting-showTags').check();await page.waitForFunction(()=>document.querySelector('#settings-status').textContent.includes('Storage unavailable'));
assert.equal(await page.evaluate(()=>__preferences.showTags),false);
await page.locator('#settings-close').click();await page.waitForFunction(()=>document.querySelector('#settings-status').textContent.includes('Storage unavailable'));
assert.equal(await page.locator('#settings-page').isVisible(),true,'failed autosave does not silently discard edits');
await page.evaluate(()=>window.__saveFail=false);await page.locator('#settings-close').click();await page.waitForSelector('#settings-page',{state:'hidden'});
assert.equal(await page.evaluate(()=>__preferences.showTags),true);
assert.equal(await page.locator('#message a').count(),0,'removing rules updates existing commit details');
await checkRowPadding('flexible');
assert.deepEqual(await page.evaluate(()=>__errors),[]);console.log('immediate settings, queued autosaves, failure recovery, multiple issue links, PR removal, layouts, configuration and diff dispatch passed');
// Read-only custom editor uses the real session contract and never interprets repository HTML.
const diffPage=await browser.newPage({viewport:{width:1000,height:720}});
const diffErrors=[];diffPage.on('pageerror',error=>diffErrors.push(error.message));
await diffPage.addInitScript(()=>{
  window.orca={document:{session:async({decode})=>{
    const snapshot={version:1,repository:'/fixture/repo',file:'src/example.mjs',revision:'a'.repeat(40),capturedAt:'2026-11-05T06:00:00Z',text:'diff --git a/src/example.mjs b/src/example.mjs\n--- a/src/example.mjs\n+++ b/src/example.mjs\n@@ -10,2 +10,2 @@\n-old\n+new <img src=x onerror=alert(1)>\n context\n',truncated:false};
    return {value:decode({kind:'text',text:JSON.stringify(snapshot)}),onReplace:fn=>{window.__replaceDiff=fn;},dispose:()=>{}};
  }}};
});
await diffPage.goto('http://127.0.0.1:'+server.address().port+'/src/diff.html');await diffPage.waitForSelector('.patch-line.add');
assert.equal(await diffPage.locator('#title').textContent(),'src/example.mjs');assert.equal(await diffPage.locator('#patch img').count(),0);
assert.equal(await diffPage.locator('.patch-line.remove .patch-number').first().textContent(),'10');assert.equal(await diffPage.locator('.patch-line.add .patch-number').nth(1).textContent(),'10');
assert.match(await diffPage.locator('#metadata').textContent(),/first parent/);
await diffPage.screenshot({path:join(tmpdir(),'graph-main-diff.png')});
await diffPage.evaluate(()=>__replaceDiff({version:1,repository:'/fixture/repo',file:'binary.png',revision:'working-tree',capturedAt:new Date().toISOString(),text:'Binary files differ',truncated:true,note:'Binary content is not previewed.'}));
assert.match(await diffPage.locator('#diff-notice').textContent(),/truncated/);assert.match(await diffPage.locator('#metadata').textContent(),/Working tree/);
await diffPage.evaluate(()=>__replaceDiff({version:99}));assert.match(await diffPage.locator('#diff-notice').textContent(),/not a valid/);assert.equal(await diffPage.locator('.patch-line').count(),0);
assert.deepEqual(diffErrors,[]);await diffPage.close();console.log('custom diff editor line numbers, updates, binary/truncation, malformed documents and injection safety passed');
} finally {await browser.close();server.close();}
