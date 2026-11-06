// Offline process test. The worker executes the public CLI with an injected client.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runCli } from '../dist/cli/main.js';
import { initializeStory, importStory } from '../dist/core/project.js';
import { listJobs } from '../dist/jobs/store.js';
import { fakeMp4, evidence } from './video-batch-process-fixture.mjs';

globalThis.fetch=async()=>{throw Error('Remote network disabled');};
const self=fileURLToPath(import.meta.url);
if(process.argv[2]==='worker'){
  const [, , , root, target]=process.argv;
  async function stop(point,id){
    if(target!==point)return;
    process.send({point,id});setInterval(()=>{},1000);await new Promise(()=>{});
  }
  const deps={runtimeRoot:join(root,'isolated-runtime'),workflowCheckpoint:stop,
    checkpoint:(point,job)=>stop(point,job.operationId),
    client:{async create(request){
      assert.equal(request.context_ir_enabled,true);
      const taskId=randomUUID();
      await appendFile(join(root,'fake-posts.jsonl'),JSON.stringify({taskId,at:Date.now()})+'\n');
      await stop('http',taskId);
      return {taskId,evidence};
    },async query(taskId){return {taskId,status:'generated',rawStatus:'succeeded',duration:7,url:'https://example.test/fake.mp4',evidence};}},
    fetcher:async()=>new Response(fakeMp4())};
  try{
    const local=await runCli(['video','execute','--root',root,'--episodes','ep-1'],deps);
    assert.ok([0,2].includes(local.exitCode) && local.data.batchId,JSON.stringify(local));
    const result=await runCli(['video','execute','--root',root,'--batch',local.data.batchId,'--confirm','--poll-ms','0'],deps);
    process.send({result});
  }catch(error){process.send({error:String(error)});process.exitCode=1;}
  process.disconnect();
}else{
  const base=await mkdtemp(join(process.env.METASO_TEST_EVIDENCE_DIR??tmpdir(),'video-execute-process-'));
  const cases=[],children=new Set();
  async function story(name){
    const root=join(base,name),file=join(base,name+'.txt'),text='第一段完整原文。';
    await writeFile(file,text);await initializeStory(root,name);
    await importStory(root,{episodeId:'ep-1',kind:'video-prompts',source:file,segments:[{id:'s1',start:0,end:text.length,duration:6.963}]});
    return root;
  }
  function worker(root,point='none'){
    const child=fork(self,['worker',root,point],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,METASO_API_KEY:'',METASOCLI_IMAGE_API_KEY:''}});
    children.add(child);
    let stderr='';child.stderr.on('data',b=>stderr+=b);
    const messages=[];child.on('message',m=>messages.push(m));
    const ended=new Promise((ok,bad)=>{child.once('error',bad);child.once('exit',code=>{children.delete(child);ok(code);});});
    const timer=setTimeout(()=>{child.kill('SIGKILL');},60000);ended.finally(()=>clearTimeout(timer));
    async function checkpoint(){
      while(!messages.some(m=>m.point===point)){
        if(!children.has(child))throw Error('Worker ended before '+point+': '+stderr+JSON.stringify(messages));
        await new Promise(r=>setTimeout(r,15));
      }
      const message=messages.find(m=>m.point===point);child.kill('SIGKILL');await ended;return message;
    }
    async function result(){assert.equal(await ended,0,stderr+JSON.stringify(messages));return messages.find(m=>m.result)?.result;}
    return {checkpoint,result};
  }
  async function posts(root){try{return (await readFile(join(root,'fake-posts.jsonl'),'utf8')).trim().split('\n').map(l=>JSON.parse(l));}catch(e){if(e.code==='ENOENT')return [];throw e;}}
  try{
    for(const point of ['video-plan-saved','video-binding-saved','video-authorization-saved','intent','http','receipt','download-after-rename','video-delivery-saved']){
      const root=await story(point),hit=await worker(root,point).checkpoint();
      const batchIds=await readdir(join(root,'.metasocli/batches'));assert.equal(batchIds.length,1);
      const prior=(await listJobs(root))[0],before=(await posts(root)).length;
      const result=await worker(root).result(),after=(await listJobs(root))[0],sent=await posts(root);
      assert.equal(result.data.batchId,batchIds[0]);assert.equal((await readdir(join(root,'.metasocli/batches'))).length,1);
      if(['intent','http'].includes(point)){assert.equal(result.exitCode,2);assert.equal(after.status,'submit_unknown');assert.equal(sent.length,before);}
      else{assert.equal(result.exitCode,0,JSON.stringify(result));assert.equal(result.data.state,'complete');assert.equal(sent.length,1);assert.equal(after.taskId,sent[0].taskId);}
      if(prior)assert.equal(prior.operationId,after.operationId);
      if(prior?.taskId)assert.equal(prior.taskId,after.taskId);
      cases.push({point,hit:hit.id,batchId:batchIds[0],operationId:after.operationId,taskId:after.taskId,status:after.status,beforePosts:before,afterPosts:sent.length});
      console.log('PASS',point,result.data.state,'POST',before,'->',sent.length);
    }
    const root=await story('two-processes'),pair=await Promise.all([worker(root).result(),worker(root).result()]);
    assert.ok(pair.every(r=>r.exitCode===0),JSON.stringify(pair));assert.equal(pair[0].data.batchId,pair[1].data.batchId);
    assert.equal(pair[0].data.segments[0].operationId,pair[1].data.segments[0].operationId);
    assert.equal((await readdir(join(root,'.metasocli/batches'))).length,1);assert.equal((await posts(root)).length,1);
    cases.push({point:'two-processes',batchId:pair[0].data.batchId,operationId:pair[0].data.segments[0].operationId,afterPosts:1});
    await writeFile(join(base,'results.json'),JSON.stringify(cases,null,2));console.log('PASS two processes, one batch / operation / POST',join(base,'results.json'));
  }finally{for(const child of children)child.kill('SIGKILL');}
}
