// Actual built CLI, offline process termination and deterministic snapshot barriers.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { initializeStory, importStory, loadStory } from '../dist/core/project.js';
import { sha256Hex } from '../dist/storage/canonical.js';
import { acquireLease } from '../dist/storage/locking.js';

globalThis.fetch=async()=>{throw Error('Offline test');};
const parent=resolve(process.env.METASO_TEST_EVIDENCE_DIR??'.work');await mkdir(parent,{recursive:true});
const base=await mkdtemp(join(parent,'prompt-process-')),children=new Set(),cases=[];
async function hashes(root){
  const entries=await readdir(root,{recursive:true,withFileTypes:true});return Object.fromEntries(await Promise.all(entries.filter(e=>e.isFile()&&!e.name.endsWith('.lock')).map(async e=>{
    const path=join(e.parentPath,e.name);return [relative(root,path),sha256Hex(await readFile(path))];
  })));
}
async function fixture(name){
  const root=join(base,name),source=join(base,name+'-source.txt'),text='第一段完整原文。第二段原文。';
  await writeFile(source,text);await initializeStory(root,name);
  await importStory(root,{episodeId:'ep-1',kind:'video-prompts',source,segments:[{id:'s1',start:0,end:8,duration:6.963},{id:'s2',start:8,end:text.length,duration:7}]});
  const file=join(base,name+'-new.txt');await writeFile(file,'😀全新完整正文。\r\n');return {root,file,before:await loadStory(root)};
}
let sequence=0;
function worker(f,point='none',extra=[]){
  const audit=join(base,'audit-'+(++sequence)+'.jsonl');
  const child=fork(resolve('dist/cli/main.js'),['prompts','replace','--root',f.root,'--episode',f.episodeId??'ep-1','--segment',f.segmentId??'s1','--file',f.file,...extra],{
    windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,METASO_API_KEY:'',METASOCLI_IMAGE_API_KEY:'',METASO_RUNTIME_DIR:join(base,'forbidden-runtime'),
      PROMPT_TEST_AUDIT:audit,PROMPT_TEST_STOP:point,NODE_OPTIONS:[process.env.NODE_OPTIONS,'--import='+pathToFileURL(resolve('scripts/prompt-replacement-test-guard.mjs')).href].filter(Boolean).join(' ')}});
  children.add(child);let stdout='',stderr='',message;child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('message',m=>message=m);
  const ended=new Promise((ok,bad)=>{child.once('error',bad);child.once('exit',(code,signal)=>{children.delete(child);ok({code,signal});});});
  const timeout=setTimeout(()=>child.kill('SIGKILL'),45000);ended.finally(()=>clearTimeout(timeout));
  return {child,audit,ended,async hit(){while(!message){if(!children.has(child))throw Error('No checkpoint: '+stderr+stdout);await new Promise(r=>setTimeout(r,10));}assert.equal(message.point,point);},
    async result(){const exit=await ended;assert.equal(exit.signal,null,stderr);const data=JSON.parse(stdout);return {...exit,data};}};
}
async function audit(w){
  const events=(await readFile(w.audit,'utf8')).trim().split('\n').map(l=>JSON.parse(l));assert.equal(events.filter(e=>e.command).length,1);
  assert.ok(events.every(e=>e.command||e.checkpoint),JSON.stringify(events));return events;
}
try{
  for(const point of ['input-before','input-after','source-before','source-after','record-after','manifest-before','manifest-after','stdout-before']){
    const f=await fixture(point),oldFiles=await hashes(f.root),stopped=worker(f,point);await stopped.hit();stopped.child.kill('SIGKILL');await stopped.ended;
    const current=await loadStory(f.root),committed=['manifest-after','stdout-before'].includes(point);
    assert.equal(current.revision,f.before.revision+(committed?1:0));if(!committed)assert.deepEqual(current,f.before);
    const recovery=worker(f,'none',['--expected-prompt-hash',f.before.episodes[0].segments[0].promptHash]),result=await recovery.result();assert.equal(result.code,0,JSON.stringify(result));assert.equal(result.data.state,committed?'unchanged':'replaced');
    const after=await loadStory(f.root);assert.equal(after.revision,f.before.revision+1);assert.equal(after.episodes[0].segments[0].prompt,'😀全新完整正文。\n');
    const frozen=await hashes(f.root),repeat=worker(f),replayed=await repeat.result();assert.equal(replayed.data.state,'unchanged');assert.deepEqual(await hashes(f.root),frozen);
    for(const [path,hash] of Object.entries(oldFiles))if(path!=='metasocli.yaml')assert.equal(frozen[path],hash);
    cases.push({point,killed:await stopped.ended,revisionAtKill:current.revision,recovery:result,replay:replayed,events:[await audit(stopped),await audit(recovery),await audit(repeat)]});console.log('PASS',point,result.data.state,'revision',after.revision);
  }
  for(const same of [false,true]){
    const f=await fixture(same?'same-result':'conflict'),other=join(base,'other-'+same+'.txt');await writeFile(other,same?await readFile(f.file):'完全不同的新稿。');
    const hash=f.before.episodes[0].segments[0].promptHash,a=worker(f,'snapshot',['--expected-prompt-hash',hash]),b=worker({...f,file:other},'snapshot',['--expected-prompt-hash',hash]);
    await Promise.all([a.hit(),b.hit()]);a.child.send('continue');b.child.send('continue');const results=await Promise.all([a.result(),b.result()]);
    assert.equal(results.filter(r=>r.data.state==='replaced').length,1);assert.equal(results.filter(r=>r.data.state==='unchanged').length,same?1:0);
    if(!same)assert.equal(results.find(r=>r.code===1).data.error.code,'PROMPT_REPLACEMENT_STALE');
    assert.equal((await loadStory(f.root)).revision,f.before.revision+1);cases.push({point:same?'two-identical':'two-conflicting',results,events:[await audit(a),await audit(b)]});console.log('PASS two processes',same?'identical':'conflicting');
  }
  {
    const f=await fixture('different-segments'),other=join(base,'second-new.txt');await writeFile(other,'第二段新稿。');
    // Both capture before either writes; no explicit hash needed for unrelated offsets.
    const a=worker(f,'snapshot'),b=worker({...f,segmentId:'s2',file:other},'snapshot');
    await Promise.all([a.hit(),b.hit()]);a.child.send('continue');b.child.send('continue');
    const results=await Promise.all([a.result(),b.result()]);assert.ok(results.every(r=>r.code===0));const story=await loadStory(f.root);assert.equal(story.revision,f.before.revision+2);assert.equal(story.episodes[0].segments[1].prompt,'第二段新稿。');
    cases.push({point:'different-segments',results,events:[await audit(a),await audit(b)]});console.log('PASS different segments retain both changes');
  }
  for(const corrupt of [false,true]){
    const f=await fixture(corrupt?'corrupt-lock':'busy-lock'),path=join(f.root,'.metasocli/project.lock');
    const lease=corrupt?undefined:await acquireLease(path);if(corrupt)await writeFile(path,'broken owner');
    const original=await readFile(path),w=worker(f),result=await w.result();assert.equal(result.code,1);assert.equal(result.data.error.code,corrupt?'LOCK_UNKNOWN':'LOCK_BUSY');assert.deepEqual(await readFile(path),original);assert.deepEqual(await loadStory(f.root),f.before);
    await lease?.release();cases.push({point:corrupt?'corrupt-lock':'busy-lock',result,events:await audit(w)});console.log('PASS preserved',corrupt?'corrupt':'active','lock');
  }
  await writeFile(join(base,'results.json'),JSON.stringify(cases,null,2));console.log('PASS prompt process evidence',join(base,'results.json'));
}finally{for(const child of children)child.kill('SIGKILL');}
