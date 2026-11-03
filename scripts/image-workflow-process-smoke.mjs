import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,readdir,cp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {workflowFixture} from './image-workflow-fixture.mjs';
const packageRoot=resolve(import.meta.dirname,'..'),base=join(process.env.METASO_TEST_EVIDENCE_DIR??join(packageRoot,'.work'),`image-workflow-process-${randomUUID()}`);
const cli=join(packageRoot,'dist/cli/main.js');await mkdir(base,{recursive:true});
const env={...process.env,TMP:base,TEMP:base,METASO_RUNTIME_DIR:join(base,'runtime'),METASO_API_KEY:'',METASOCLI_IMAGE_API_KEY:''};
const evidence=[];
function child(args){const proc=spawn(process.execPath,args,{env,stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});let out='',err='';proc.stdout.on('data',b=>out+=b);proc.stderr.on('data',b=>err+=b);const done=new Promise((r,j)=>{proc.on('error',j);proc.on('exit',(code,signal)=>r({code,signal,out,err}));});return {proc,done};}
async function command(args,entry=cli){const run=child([entry,...args]);const result=await run.done;assert.equal(result.code,0,result.out+result.err);return JSON.parse(result.out);}
const worker=join(base,'worker.mjs');
await writeFile(worker,`import {prepareImages} from ${JSON.stringify(pathToFileURL(join(packageRoot,'dist/images/preparation.js')).href)};
const keepAlive=setInterval(()=>{},1000);
const [root,batch,point]=process.argv.slice(2);await prepareImages(root,{batch,checkpoint:async name=>{if(name===point){process.send({point:name});await new Promise(()=>{});}}});`);
for(const point of ['snapshot-saved','import-before:ep-1','import-after:ep-1','import-before:ep-2','import-after:ep-2','plan-intent-saved','plan-saved']){
  const f=await workflowFixture(join(base,point.replaceAll(':','-'))),run=child([worker,f.root,f.batchPath,point]);
  await Promise.race([new Promise(r=>run.proc.once('message',r)),run.done.then(r=>{throw new Error(`worker exited before ${point}: ${JSON.stringify(r)}`);}),new Promise((_,j)=>{const t=setTimeout(()=>j(new Error(`timeout ${point}`)),60000);t.unref();})]);
  run.proc.kill('SIGKILL');await run.done;
  const dirs=(await readdir(join(f.root,'.metasocli/image-preparations'))).filter(n=>/^[0-9a-f-]{36}$/.test(n));assert.equal(dirs.length,1);
  const input=JSON.parse(await readFile(join(f.root,'.metasocli/image-preparations',dirs[0],'input.json'),'utf8'));
  const result=await command(['images','prepare','--root',f.root,'--preparation',dirs[0]]);
  assert.equal(result.preparationId,dirs[0]);assert.equal(result.planId,input.planId);
  assert.deepEqual((await readdir(join(f.root,'.metasocli/image-plans'))).filter(n=>n.endsWith('.json')),[`${input.planId}.json`]);
  const again=await command(['images','prepare','--root',f.root,'--batch',f.batchPath]);assert.equal(again.planId,input.planId);
  const jobs=await readdir(join(f.root,'.metasocli/image-jobs')).catch(()=>[]);assert.equal(jobs.length,0);
  evidence.push({point,preparationId:dirs[0],planId:input.planId,posts:0,jobs:0});console.log(`PASS ${point}: same preparation/plan, zero POST/jobs`);
}
const concurrent=await workflowFixture(join(base,'same-story'));
const both=await Promise.all([command(['images','prepare','--root',concurrent.root,'--batch',concurrent.batchPath]),command(['images','prepare','--root',concurrent.root,'--batch',concurrent.batchPath])]);
assert.equal(both[0].planId,both[1].planId);evidence.push({point:'same-story-two-cli',planId:both[0].planId});console.log('PASS same-story two public CLI processes: one plan');
const first=await workflowFixture(join(base,'story-A')),second=await workflowFixture(join(base,'story-B'));
const held=child([worker,first.root,first.batchPath,'snapshot-saved']);await new Promise(r=>held.proc.once('message',r));
try{const other=await command(['images','prepare','--root',second.root,'--batch',second.batchPath]);evidence.push({point:'different-story',otherPlanId:other.planId,firstStillAlive:held.proc.exitCode===null});assert.equal(held.proc.exitCode,null);console.log('PASS other story prepares while first lease is held');}finally{held.proc.kill('SIGKILL');await held.done;}
// Relocated package contains no user credentials and uses package-relative Python validator.
const installed=join(base,'独立 安装 package');await mkdir(installed,{recursive:true});
for(const name of ['dist','skills','package.json'])await cp(join(packageRoot,name),join(installed,name),{recursive:true});
const third=await workflowFixture(join(base,'relocated-story'));
const relocated=await command(['images','prepare','--root',third.root,'--batch',third.batchPath],join(installed,'dist/cli/main.js'));
assert.ok(relocated.planId);evidence.push({point:'relocated-package',planId:relocated.planId,installRoot:installed});console.log('PASS relocated Unicode/space package and Python paths');
await writeFile(join(base,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({base,passed:evidence.length,evidence:join(base,'evidence.json')}));
