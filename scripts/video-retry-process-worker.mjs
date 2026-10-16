import { runCli } from '../dist/cli/main.js';
import { evidence } from './video-batch-process-fixture.mjs';
import { persistence } from '../dist/jobs/store.js';
const [root,planId,batchId,old,point]=process.argv.slice(2);
const failureRetry=point.startsWith('failure-'), stage=failureRetry?point.slice('failure-'.length):point;
globalThis.fetch=async()=>{throw new Error('Real network forbidden');};
const stop=async event=>{process.send({checkpoint:event});setInterval(()=>{},1000);return new Promise(()=>{});};
const client={async create(request){
  if(request.context_ir_enabled!==true)throw new Error('Inline IR missing');
  const taskId='retry-process-'+process.pid;process.send({post:taskId});
  if(stage==='http')await stop(point);
  if(stage==='concurrent')await new Promise(r=>setTimeout(r,200));
  return {taskId,evidence};
},async query(taskId){return {taskId,status:'running',rawStatus:'running',evidence};}};
const args=stage==='retry-batch-index'
  ? failureRetry
    ? ['batch','resume','--root',root,'--batch',batchId,'--max-polls','1','--poll-ms','0']
    : ['batch','retry','--root',root,'--batch',batchId,'--operation',old,'--confirm','--accept-unknown-result','--max-polls','1','--poll-ms','0']
  : ['generate','--root',root,'--plan',planId,'--segment','s1','--retry-of',old,'--confirm',...(!failureRetry?['--accept-unknown-result']:[]),'--submit-only'];
const result=await runCli(args,{client,
  persistence:{...persistence,async job(root,job){await persistence.job(root,job);if(stage==='prepared'&&job.status==='prepared')await stop(point);}},
  checkpoint:async event=>{if(event===stage)await stop(point);}});
process.send({result});process.disconnect();
