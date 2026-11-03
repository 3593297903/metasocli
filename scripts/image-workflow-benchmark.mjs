import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {workflowFixture,png} from './image-workflow-fixture.mjs';
import {prepareImages} from '../dist/images/preparation.js';
import {collectImages,imageSummary} from '../dist/images/reporting.js';
import {imageStatus,runImages} from '../dist/images/run.js';
import {loadStory} from '../dist/core/project.js';
import {canonicalSha256} from '../dist/storage/canonical.js';
const packageRoot=resolve(import.meta.dirname,'..'),base=join(packageRoot,'.work',`image-workflow-benchmark-${randomUUID()}`);await mkdir(base,{recursive:true});
const baseline=resolve(process.env.METASOCLI_WORKFLOW_BASELINE??join(packageRoot,'.work/image-workflow-implementation-20261102/before'));
const old=await import(pathToFileURL(join(baseline,'dist/core/project.js')).href),oldPlanning=await import(pathToFileURL(join(baseline,'dist/images/planning.js')).href),oldRun=await import(pathToFileURL(join(baseline,'dist/images/run.js')).href);
const exec=promisify(execFile),validator=join(baseline,'skills/metasocli-reference-images/scripts/validate_handoff.py');
const rows=[];
async function timed(work){const start=performance.now(),cpu=process.cpuUsage();const value=await work();return {value,wallMs:performance.now()-start,cpuMicros:process.cpuUsage(cpu),outputBytes:Buffer.byteLength(JSON.stringify(value))};}
async function oldPrepare(f){
  for(const e of f.batch.entries){
    await exec('python',['-X','utf8','-B',validator,'request',join(f.root,e.requestPath),'--draft',join(f.root,e.draftPath)],{windowsHide:true});
    await exec('python',['-X','utf8','-B',validator,'recipe',join(f.root,e.recipePath),'--request',join(f.root,e.requestPath),'--draft',join(f.root,e.draftPath)],{windowsHide:true});
    const draft=JSON.parse(await readFile(join(f.root,e.draftPath),'utf8'));draft.source=resolve(f.root,draft.source);await old.importStory(f.root,draft);
  }
  return oldPlanning.createImagePlan(f.root,{...f.batch.scope,profile:f.profile,submissionMode:'all-ready'});
}
const bytes=png(),response=JSON.stringify({data:[{b64_json:bytes.toString('base64')}]}),delayMs=20;
for(let repetition=1;repetition<=3;repetition++){
  const a=await workflowFixture(join(base,`old-${repetition}`),27,29),b=await workflowFixture(join(base,`new-${repetition}`),27,29);
  const oldFirst=await timed(()=>oldPrepare(a)),newFirst=await timed(()=>prepareImages(b.root,{batch:b.batchPath}));
  const oldRepeat=await timed(()=>oldPrepare(a)),newRepeat=await timed(()=>prepareImages(b.root,{batch:b.batchPath}));
  const sa=await loadStory(a.root),sb=await loadStory(b.root);assert.equal(canonicalSha256({episodes:sa.episodes,assets:sa.assets}),canonicalSha256({episodes:sb.episodes,assets:sb.assets}));
  assert.equal(newFirst.value.planId,newRepeat.value.planId);
  const oldRequests=[],newRequests=[];
  const deps=(f,requests)=>({runtimeRoot:join(f.root,'runtime'),client:{async create(root,input){requests.push({input,prompt:await readFile(join(root,input.promptPath),'utf8')});await new Promise(r=>setTimeout(r,delayMs));return new Response(response);}}});
  const oldRunStart=performance.now();await oldRun.runImages(a.root,oldFirst.value.plan.planId,true,deps(a,oldRequests));const oldSimulatedRunMs=performance.now()-oldRunStart;
  const started=performance.now();await runImages(b.root,newFirst.value.planId,true,deps(b,newRequests));const simulatedRunMs=performance.now()-started;
  assert.equal(oldRequests.length,29);assert.equal(newRequests.length,29);assert.deepEqual(newRequests,oldRequests);const posts=newRequests.length;
  const exported=await timed(()=>collectImages(b.root,{preparation:newFirst.value.preparationId}));assert.equal(exported.value.complete,true);
  const full=await timed(()=>imageStatus(b.root,newFirst.value.planId)),compact=await timed(()=>imageSummary(b.root,newFirst.value.planId));
  const bestExistingReuse=await timed(()=>imageStatus(a.root,oldFirst.value.plan.planId));
  const measurement=x=>({wallMs:x.wallMs,cpuMicros:x.cpuMicros,outputBytes:x.outputBytes});
  const row={repetition,episodes:27,assets:29,oldFirst:measurement(oldFirst),newFirst:measurement(newFirst),oldRepeat:measurement(oldRepeat),newRepeat:measurement(newRepeat),bestExistingStatusReuse:measurement(bestExistingReuse),collect:measurement(exported),fullStatus:measurement(full),compactStatus:measurement(compact),oldSimulatedRunMs,simulatedRunMs,fixedFakeDelayMs:delayMs,posts,oldPosts:oldRequests.length,actualInputsEquivalent:true,preparationTimingFile:join(b.root,newFirst.value.timingsPath),collectionTimingFile:join(b.root,exported.value.timingsPath)};
  rows.push(row);await writeFile(join(base,'measurements.json'),JSON.stringify(rows,null,2));console.log(`PASS repetition ${repetition}: equivalent content, 29 fake POST, complete result`);
}
const stats=key=>{const values=rows.map(r=>r[key].wallMs).sort((a,b)=>a-b);return {medianMs:values[1],minMs:values[0],maxMs:values[2]};};
const report={base,baseline,rows,statistics:Object.fromEntries(['oldFirst','newFirst','oldRepeat','newRepeat','bestExistingStatusReuse','collect','fullStatus','compactStatus'].map(k=>[k,stats(k)])),notes:['Old repeated path explicitly revalidates all handoffs, imports, and creates an independent plan; optimal reuse of an existing plan is separately measured.','CPU figures cover the Node process, not Python child CPU; wall timings include file IO and subprocess waits.','Fixed fake response delay is not supplier timing. No claim about model thinking, remote queueing, API latency or monetary savings.']};
report.localMedianSavedMs={first:report.statistics.oldFirst.medianMs-report.statistics.newFirst.medianMs,repeated:report.statistics.oldRepeat.medianMs-report.statistics.newRepeat.medianMs};
await writeFile(join(base,'benchmark.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
