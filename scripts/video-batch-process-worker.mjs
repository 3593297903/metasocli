import { readFile } from 'node:fs/promises';
import { runBatch } from '../dist/jobs/batch.js';
import { runCli } from '../dist/cli/main.js';
import { fakeMp4, evidence } from './video-batch-process-fixture.mjs';
const [root,batchId,mode,planId,segmentId] = process.argv.slice(2);
if (process.platform === 'win32' && process.permission) {
  try { await readFile('E:\\libcli\\package.json'); throw new Error('Old source unexpectedly readable'); }
  catch(error) { if(error.code !== 'ERR_ACCESS_DENIED') throw error; }
}
globalThis.fetch = async()=>{throw new Error('Real network forbidden');};
const stop=async(point)=>{ process.send({checkpoint:point});setInterval(()=>{},1000);return new Promise(()=>{}); };
let count=0;
const client={
  async create(request){
    if(request.context_ir_enabled!==true)throw new Error('Inline IR missing');
    const taskId='process-'+process.pid+'-'+ ++count;process.send({post:taskId});
    if(mode==='http')return stop('http');
    if(mode==='gate')await new Promise(resolve=>process.once('message',resolve));
    return {taskId,evidence};
  },
  async query(taskId){
    if(mode==='query-gate')await stop('query-gate');
    if(['gate','running','batch-running'].includes(mode))return {taskId,status:'running',rawStatus:'running',evidence};
    return {taskId,status:'generated',rawStatus:'succeeded',duration:7,url:'https://example.com/fake.mp4',evidence};
  }
};
const deps={client,fetcher:async()=>new Response(fakeMp4()),checkpoint:async(point)=>{if(point===mode)await stop(point);}};
try{
  const result=['gate','running'].includes(mode)
    ? await runCli(['generate','--root',root,'--plan',planId,'--segment',segmentId,'--confirm','--submit-only'],deps)
    : await runBatch(root,batchId,true,deps,{maxPolls:1,pollIntervalMs:0,schedulerWaitMs:mode==='no-wait'?0:10000});
  process.send({result});
}catch(error){process.send({error:{code:error.code,message:error.message}});}
process.disconnect();
