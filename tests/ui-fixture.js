window.__errors=[];window.addEventListener('error',e=>__errors.push(e.message));window.addEventListener('unhandledrejection',e=>__errors.push(String(e.reason)));
window.__mode='normal';window.__requests=[];window.__dirty=false;
const hash=n=>n.toString(16).padStart(40,'0');
const topology=[[18,[17]],[17,[16,14]],[16,[15,13]],[15,[12]],[14,[12]],[13,[12]],[12,[11]],[11,[10,8]],[10,[9,7]],[9,[6,5]],[8,[4]],[7,[4]],[6,[4]],[5,[4]],[4,[3]],[3,[2]],[2,[1]],[1,[]]];
const commits=topology.map(([n,parents])=>({hash:hash(n),parents:parents.map(hash),subject:parents.length>1?'Merge feature branch '+n:'Improve graph history '+n,author:'Alex Chen',date:'2026-11-04T12:00:00Z'}));
window.orca={plugin:{request:async(name,input)=>{__requests.push({name,input});await new Promise(r=>setTimeout(r,20));if(__mode==='error'&&name==='history')throw Error('Repository unavailable');if(name==='workspaces')return {workspaces:__mode==='none'?[]:[{id:'one',name:'Graph fixture',branch:'main',path:'/example/graph'}],selectedId:'one',remoteCount:0};if(name==='history')return {workingTree:{totalFiles:window.__dirty?4:0},commits:__mode==='empty'?[]:input.offset?[{...commits.at(-1),hash:hash(0),subject:'Older root'}]:input.ref&&input.ref!=='HEAD'?commits.slice(4):commits,refs:[{hash:hash(18),kind:'branch',name:'refs/heads/main',label:'main'},{hash:hash(14),kind:'branch',name:'refs/heads/feature/graph-inline-details',label:'feature/graph-inline-details'},{hash:hash(14),kind:'remote',name:'refs/remotes/origin/feature/graph-inline-details',label:'origin/feature/graph-inline-details'}],head:hash(18),branch:'main',snapshot:'fixture',hasMore:!input.offset};if(name==='details'){if(__mode==='detail-error')throw Error('Commit unavailable');const commit=commits.find(c=>c.hash===input.hash);return {...commit,authorEmail:'alex@example.invalid',committer:'Sam Lee',committerEmail:'sam@example.invalid',message:commit.subject+"\n\nKeep ancestry visible through inline details. Fix #123 and PROJ-456.\nRepository text <img src=x onerror=alert(1)> is not HTML.",files:[{status:'M',path:'apps/core/src/graph.mjs',additions:13,deletions:12},{status:'A',path:'apps/core/src/graph.test.mjs',additions:5,deletions:0},{status:'M',path:'README.md',additions:1,deletions:1},{status:'D',path:'old/file.txt',additions:0,deletions:4}],totalFiles:4}}if(name==='working-details'){if(__mode==='detail-error')throw Error('Working tree unavailable');return {workingTree:true,head:hash(18),staged:1,unstaged:2,untracked:2,conflicts:0,totalFiles:4,files:[{status:'M',path:'src/edit.mjs',additions:13,deletions:12,staged:true,unstaged:true},{status:'A',path:'src/new.mjs',additions:5,deletions:0,untracked:true},{status:'D',path:'old.txt',additions:0,deletions:4,unstaged:true},{status:'A',path:'image.png',additions:null,deletions:null,untracked:true}]}}if(name==='diff'||name==='working-diff')return {text:"diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new <script>alert(1)</script>\n",truncated:false};}}};

window.__preferences = { layout: 'flexible', diffView: 'inline', initialBranch: '', showStashes: false, showTags: true, includeReflogs: false, firstParent: false, issueLinks: [] };
window.__configuration = { user: { name: 'Graph Tester', email: 'test@example.invalid', localName: '', localEmail: '', hasLocalName: false, hasLocalEmail: false }, remotes: [{ name: 'origin', fetchUrls: ['https://example.invalid/repository.git'], pushUrls: [] }], snapshot: 'configuration-1' };
window.__external = [];
window.orca.shell = { openExternal: async url => { window.__external.push(url); return { opened: true }; } };
{
  const original = window.orca.plugin.request;
  window.orca.plugin.request = async (name, input) => {
    if (['preferences', 'preferences-save', 'configuration', 'configuration-change', 'open-diff'].includes(name)) {
      __requests.push({ name, input });
      if (name === 'preferences') return { ...window.__preferences };
      if (name === 'preferences-save') { await new Promise(resolve => setTimeout(resolve, window.__saveDelay || 0)); if (window.__saveFail) throw Error('Storage unavailable'); window.__preferences = structuredClone(input.preferences); return structuredClone(window.__preferences); }
      if (name === 'configuration') return structuredClone(window.__configuration);
      if (name === 'configuration-change') { if (window.__configFail) throw Error('Configuration changed'); return structuredClone(window.__configuration); }
      if (window.__openFail) throw Error('Could not open the main-panel diff');
      return { opened: true, message: 'Opened read-only diff in the main panel.' };
    }
    return original(name, input);
  };
}
