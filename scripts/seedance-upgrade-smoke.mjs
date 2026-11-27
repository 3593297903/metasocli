import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadStory, saveStory, importStory } from '../dist/core/project.js';
import { batchAttempt, initial, save, seedOperation, seedPath } from '../dist/seedance/store.js';
import { digest, model } from './seedance-smoke-http.mjs';
import { legacyOrder } from './seedance-upgrade-fixture.mjs';

const line='甲：“请打开参考图1。”';
const prompt='镜头参照 @图1。\n'+line+'\n';
const ref=(path,bytes)=>({role:'reference_image',path,mime:'image/png',sha256:digest(bytes)});
const retry=({plan,job})=>['--batch',plan.batchId,'--retry-of',job.operationId,'--accept-unknown-result','--confirm'];
export async function upgradeScenarios(h){
  const {fixture,probe,context,count,seed,select,run,operation,delivered,single,command,imageBytes}=h;
  const first=ref('assets/ref1.png',imageBytes);
  const row={id:'s1',prompt,seedance:{assets:[first]}};
  const choose=async(root,id='s1')=>seed(...await select(root,id),'--confirm');
  async function old(root,drop=true){
    context().drop=drop;
    try{return await legacyOrder(root,model('480p'),drop);}finally{context().drop=false;}
  }
  async function setup(name,drop=true){
    const root=await fixture(name,[row,{id:'s2'}]);
    return {root,original:await old(root,drop)};
  }
  async function processRun(root,args){
    const env={...process.env,METASO_TEST_LOOPBACK:h.origin,METASO_TEST_SCENARIO:context().name};
    const cmd=['--import',new URL('./seedance-test-preload.mjs',import.meta.url).href,
      fileURLToPath(new URL('../dist/cli/main.js',import.meta.url)),'video','run','--root',root,
      '--runtime-dir',context().runtime,'--poll-ms','0','--capacity-wait-ms','0',...args];
    let result;
    try{result=await promisify(execFile)(process.execPath,cmd,{env,windowsHide:true,timeout:65000});}
    catch(err){if(err.code!==2)throw err;result=err;}
    const data=JSON.parse(result.stdout);context().results.push({process:'spawn',args,data});return data;
  }
  await probe('upgrade-original-select-retry-repeat-restart',async()=>{
    const {root,original}=await setup('UpgradeMain'),actions=[];
    async function step(action,fn,posts){
      const before=count(),result=await fn(),delta=count()-before;
      actions.push({action,delta});assert.equal(delta,posts,action);return result;
    }
    const prev=single(await step('resume original',()=>operation(root,original.job.operationId),0));
    const selected=single(await step('ordinary reselect',async()=>run(root,await choose(root)),0));
    for(const item of [prev,selected]){
      assert.equal(item.operationId,original.job.operationId);assert.equal(item.operationBatchId,original.plan.batchId);
      assert.equal(item.status,'submit_unknown');assert.equal(item.historicalSentPrompt,context().orders[0].params.prompt);
    }
    const child=delivered(await step('authorize one retry',()=>run(root,retry(original)),1));
    assert.equal(child.retryOf,original.job.operationId);assert.notEqual(child.requestHash,original.job.requestHash);
    const parent=await seedOperation(root,original.job.operationId);
    assert.equal(parent.successorId,child.operationId);assert.equal(parent.status,'submit_unknown');
    for(const [action,fn] of [['repeat',()=>run(root,retry(original))],['new process',()=>processRun(root,retry(original))],
      ['ordinary reselect after delivery',async()=>run(root,await choose(root))]]){
      assert.equal(delivered(await step(action,fn,0)).operationId,child.operationId);
    }
    assert.deepEqual(context().orders.map(o=>o.params.prompt),[prompt.replace('参考图1','@图1'),prompt]);
    assert.deepEqual(context().orders.map(o=>o.parts[0].sha256),[first.sha256,first.sha256]);
    context().extra={actions,parentOperation:parent.operationId,parentBatch:parent.planId,parentHash:parent.requestHash,
      childOperation:child.operationId,childBatch:child.operationBatchId,childHash:child.requestHash,
      parentStatus:parent.status,childStatus:child.status,received:context().orders.map(o=>o.params.prompt),output:child.output.absolutePath};
  });
  await probe('upgrade-two-processes-one-retry',async()=>{
    const {root,original}=await setup('Concurrent');
    const results=await Promise.all([processRun(root,retry(original)),processRun(root,retry(original))]);
    const children=results.map(delivered);assert.equal(children[0].operationId,children[1].operationId);
    assert.equal(count(),2);context().extra={parent:original.job.operationId,child:children[0].operationId,retryPosts:1};
  });
  await probe('upgrade-known-id-and-completed-output',async()=>{
    const {root,original}=await setup('Known',false);context().status='queued';
    const a=single(await run(root,[...await choose(root),'--max-polls','1']));assert.equal(a.taskId,original.job.taskId);
    context().status='completed';
    for(let i=0;i<2;i++){const got=delivered(await run(root,await choose(root)));assert.equal(got.taskId,a.taskId);
      assert.equal(got.historicalSentPrompt,context().orders[0].params.prompt);}
    assert.equal(count(),1);
  });
  await probe('upgrade-unknown-and-independent-segment',async()=>{
    const {root,original}=await setup('IndependentOld');
    const result=await run(root,seed('--episodes','ep-1','--confirm'));
    assert.equal(result.segments[0].operationId,original.job.operationId);assert.ok(result.segments[1].output);
    assert.equal(count(),2);assert.equal(context().orders[1].params.prompt,'Caption s2.\n');
  });
  await probe('upgrade-existing-prepared-stale-successor',async()=>{
    const {root,original}=await setup('Unsent');
    const stale={...initial(original.plan,original.item),retryOf:original.job.operationId,attempt:2};
    await batchAttempt(root,original.plan,original.item,original.job);
    await save(root,stale,true);original.job.successorId=stale.operationId;await save(root,original.job);
    const ordinary=single(await run(root,await choose(root)));
    assert.equal(ordinary.operationId,original.job.operationId);assert.equal(ordinary.status,'submit_unknown');assert.equal(count(),1);
    const replaced=delivered(await run(root,retry(original)));assert.equal(replaced.retryOf,original.job.operationId);
    assert.equal((await seedOperation(root,stale.operationId)).lastError.code,'RETRY_SUPERSEDED');
    assert.equal(count(),2);context().extra={superseded:stale.operationId,child:replaced.operationId};
  });
  async function reserve(name){
    const {root,original}=await setup(name);context().status='queued';
    const blocker=single(await run(root,[...await choose(root,'s2'),'--max-polls','1']));
    assert.ok(blocker.taskId);
    const pending=single(await run(root,retry(original)));
    assert.equal(pending.issue.code,'WAITING_CAPACITY');assert.equal(count(),2);
    const child=await seedOperation(root,pending.operationId);assert.equal(child.status,'prepared');
    context().status='completed';delivered(await operation(root,blocker.operationId));return {root,original,child};
  }
  for(const phase of ['grant-only','child-without-index','attach-before-send'])await probe('upgrade-'+phase,async()=>{
    const {root,original,child}=await reserve(phase);
    // Recreate durable boundaries between the operation, index and binding writes in the temporary story.
    for(const rel of ['jobs/'+child.requestHash,'bindings/'+child.planId+'/'+child.requestHash,
      ...(phase==='child-without-index'?[]:['operations/'+child.operationId])]){
      await fs.unlink(await seedPath(root,rel+'.json'));
    }
    const before=count();
    if(phase==='attach-before-send'){
      await command(root,['attach-task'],['--operation',original.job.operationId,'--task',context().orders[0].id,'--confirm-task-link']);
      const got=delivered(await run(root,await choose(root)));assert.equal(got.operationId,original.job.operationId);
      assert.equal((await seedOperation(root,child.operationId)).lastError.code,'RETRY_SUPERSEDED');
      await processRun(root,retry(original));assert.equal(count(),before);
    }else{
      const got=delivered(await processRun(root,retry(original)));assert.equal(got.operationId,child.operationId);
      delivered(await processRun(root,retry(original)));assert.equal(count(),before+1);
    }
    context().extra={reserved:child.operationId,blockerPosts:1,postRestart:count()-before};
  });
  await probe('upgrade-post-receipt-lost',async()=>{
    const {root,original}=await setup('LostRetry');context().drop=true;
    const lost=single(await run(root,retry(original)));assert.equal(lost.status,'submit_unknown');assert.equal(count(),2);
    const child=await seedOperation(root,lost.operationId);
    child.status='submitting';delete child.lastError;await save(root,child); // Last durable state at process termination.
    context().drop=false;
    for(const args of [retry(original),await choose(root)]){
      const got=single(await processRun(root,args));assert.equal(got.operationId,lost.operationId);assert.equal(got.status,'submit_unknown');
    }
    assert.equal(count(),2);
  });
  await probe('upgrade-independent-histories',async()=>{
    const root=await fixture('Separate',[row]);const current=delivered(await run(root,await choose(root)));
    const original=await old(root);
    const collision=single(await run(root,await choose(root)));assert.equal(collision.issue.code,'SEED_HISTORY_CONFLICT');
    for(const id of [current.operationId,original.job.operationId]){
      assert.ok(collision.issue.message.includes(id));assert.equal(single(await operation(root,id)).operationId,id);
    }
    assert.equal(count(),2);
  });
  await probe('upgrade-both-attempts-have-receipts',async()=>{
    const {root,original}=await setup('BothSent');
    const child=delivered(await run(root,retry(original)));
    await command(root,['attach-task'],['--operation',original.job.operationId,'--task',context().orders[0].id,'--confirm-task-link']);
    const collision=single(await run(root,await choose(root)));assert.equal(collision.issue.code,'SEED_HISTORY_CONFLICT');
    for(const id of [original.job.operationId,child.operationId])assert.equal(delivered(await operation(root,id)).operationId,id);
    assert.equal(count(),2);
  });
  await probe('upgrade-credential-mismatch',async()=>{
    const {root,original}=await setup('Credential');const envName='METASOCLI_YICIYUANG_VIDEO_API_KEY',key=process.env[envName];
    process.env[envName]='different-offline-key';
    try{assert.equal(single(await run(root,retry(original))).issue.code,'CREDENTIAL_CHANGED');}
    finally{process.env[envName]=key;}
    assert.equal(count(),1);assert.equal((await seedOperation(root,original.job.operationId)).successorId,undefined);
  });
  await probe('upgrade-known-task-credential-mismatch',async()=>{
    const {root,original}=await setup('KnownCredential',false),envName='METASOCLI_YICIYUANG_VIDEO_API_KEY',key=process.env[envName];
    process.env[envName]='different-offline-key';
    try{
      const result=single(await run(root,await choose(root)));assert.equal(result.issue.code,'CREDENTIAL_CHANGED');
      assert.equal(result.operationId,original.job.operationId);assert.equal(context().requests.length,1);
    }finally{process.env[envName]=key;}
  });
  for(const change of ['text','bytes','order','model'])await probe('upgrade-changed-'+change,async()=>{
    const secondPath='assets/ref2.png',secondBytes=Buffer.concat([imageBytes,Buffer.from([1])]);
    const assets=[first,ref(secondPath,secondBytes)],text=prompt+'背景 @图2。\n';
    const root=await fixture('Changed-'+change,[{id:'s1',prompt:text,seedance:{assets}}]);
    await fs.writeFile(join(root,secondPath),secondBytes);const original=await old(root);
    if(change==='text'){
      const edited=text.replace('打开','关上'),source=join(root,'edited.txt');await fs.writeFile(source,edited);
      await importStory(root,{source,episodeId:'ep-1',kind:'video-prompts',segments:[
        {id:'s1',start:0,end:edited.length,prompt:edited,duration:5,seedance:{assets}}]},true);
    }else if(change==='bytes')await fs.writeFile(join(root,first.path),secondBytes);
    else if(change==='order'){
      const story=await loadStory(root);story.episodes[0].segments[0].seedance.assets.reverse();await saveStory(root,story);
    }
    const result=await run(root,[...retry(original),...(change==='model'?['--model',model('720p')]:[])]);
    assert.match(JSON.stringify(result),change==='model'?/VIDEO_SCOPE_CHANGED/:change==='bytes'?/ASSET_CHANGED/:/PLAN_STALE/);
    assert.equal(count(),1);
    if(change==='bytes'){
      const story=await loadStory(root);const replacement=Buffer.concat([imageBytes,Buffer.from([2])]);
      await fs.writeFile(join(root,first.path),replacement);story.episodes[0].segments[0].seedance.assets[0].sha256=digest(replacement);await saveStory(root,story);
      assert.match(JSON.stringify(await run(root,retry(original))),/PLAN_STALE/);assert.equal(count(),1);
    }
    context().drop=true;
    await run(root,['--model',model(change==='model'?'720p':'480p'),...await select(root,'s1'),'--confirm']);
    assert.equal(count(),2);context().extra={oldAuthorizationPosts:0,newSelectionPosts:1};
  });
}

export async function rejectionScenarios(h){
  const {fixture,probe,context,count,seed,run,single,media,work,imageBytes}=h;
  const assets=[ref('assets/人物.png',imageBytes)],bytes=[imageBytes];
  for(const [name,freq] of [['环境.wav',220],['旁白.wav',440]]){
    const file=join(work,name);
    media(['-f','lavfi','-i','sine=frequency='+freq+':sample_rate=16000','-t','0.2','-c:a','pcm_s16le',file]);
    const content=await fs.readFile(file);bytes.push(content);
    assets.push({role:'reference_audio',path:'assets/'+name,mime:'audio/wav',sha256:digest(content)});
  }
  const cases=[
    ['category',{message:'参考音频不受支持'},false,'category'],
    ['filename',{message:'Unsupported ref-3.wav'},false,'exact'],
    ['structured-filename',{filename:'ref-3.wav'},false,'exact'],
    ['ordinal',{message:'第2条参考音频不受支持'},false,'exact'],
    ['pointer',{message:'Unsupported audio',pointer:'/referenceAudios/1'},true,'exact'],
    ['explicit-base',{field:'referenceAudios',index:2,index_base:1},true,'exact'],
    ['ambiguous-base',{message:'参考音频',field:'referenceAudios',index:1},true,'category'],
    ['out-of-range',{message:'参考音频',pointer:'/referenceAudios/8'},true,'category'],
    ['contradictory',{message:'ref-3.wav 和第1条参考音频'},false,'category'],
    ['late-conflict',{message:'ref-3.wav '+'x'.repeat(400)+' 第1条参考音频'},false,'category'],
    ['malformed-index',{message:'ref-3.wav',field:'referenceAudios',index:'1'},false,'category'],
    ['no-body',null,false,'none']
  ];
  for(const [name,error,json,expected] of cases)await probe('422-'+name,async()=>{
    const files=assets.map((a,i)=>json?{...a,url:'https://assets.example.test/ref'+i}:a);
    const root=await fixture('Reject-'+name,[{id:'s1',prompt:'镜头 @图1。',seedance:{assets:files}}]);
    for(const [i,a] of files.entries())await fs.writeFile(join(root,a.path),bytes[i]);
    context().rejection=error===null?null:{code:'INVALID_MEDIA',...error};
    const args=seed('--episodes','ep-1','--confirm');
    const result=single(await run(root,args)),diag=result.issue.message;
    assert.equal(result.status,'failed');assert.match(diag,/HTTP 422/);
    if(error)assert.match(diag,/INVALID_MEDIA/);
    if(expected==='exact')assert.match(diag,/ep-1\/s1 · 第 2 条参考音频 · 旁白\.wav/);
    else{assert.doesNotMatch(diag,/旁白\.wav|环境\.wav/);if(expected==='category')assert.match(diag,/ep-1\/s1 · 参考音频$/);}
    const order=context().orders[0];
    if(json)assert.deepEqual(order.params.referenceAudios,files.slice(1).map(a=>a.url));
    else assert.deepEqual(order.parts.map(p=>[p.name,p.sha256]),files.map((a,i)=>['ref-'+(i+1)+(i?'.wav':'.png'),a.sha256]));
    await run(root,args);assert.equal(count(),1);
    context().extra={diagnostic:diag,autoResubmissions:0};
  });
}
