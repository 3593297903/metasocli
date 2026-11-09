import { z } from 'zod';
import { join } from 'node:path';
import { Hash, parse } from '../contracts/story.js';
import { JobSchema, Receipt, type Job } from '../contracts/job.js';
import { canonicalSha256 } from '../storage/canonical.js';
import { exists, projectPath, samePath } from '../storage/paths.js';
import { readJson, writeJson } from '../storage/io.js';
import { withProjectWrite } from '../storage/locking.js';
import { fail, isCode, publicError } from '../core/errors.js';
import { CapacityReason, releases } from './capacity-policy.js';
import { capacityTransaction, ensureRegistered, initialCapacity, inspectRuntime, mergeJob, occupied, runtimeDirectory, terminal, type SlotRecord,mergeRecoveredJob,receiptRecoveryNeeded } from './coordinator.js';
import { liveSubmissionLease } from './submission-owner.js';

const Event = z.object({projectId:z.uuid(),operationId:z.uuid(),requestHash:Hash,inputHash:Hash,
  sequence:z.number().int().positive(),reason:CapacityReason,evidence:Hash,taskId:z.string().optional(),status:JobSchema.shape.status}).strict();
type Event = z.infer<typeof Event>;
const Envelope=z.object({event:Event,hash:Hash}).strict();
async function readEvent(file:string){
  const envelope=parse(Envelope,await readJson(file));
  if(canonicalSha256(envelope.event)!==envelope.hash)fail('CAPACITY_EVIDENCE_TAMPERED','Capacity observation hash differs.');
  return envelope.event;
}
const eventPath=(root:string,id:string)=>projectPath(root,'.metasocli/receipts/'+parse(z.uuid(),id)+'-capacity.json');
const listeners=new Map<string,Set<()=>void>>();
function notify(runtime:string){for(const listener of listeners.get(runtimeDirectory(runtime))??[])listener();}
export function capacitySignal(runtime:string){
  const key=runtimeDirectory(runtime);let version=0;const waiters=new Set<()=>void>();
  const change=()=>{version++;for(const wake of waiters)wake();waiters.clear();};
  const group=listeners.get(key)??new Set();group.add(change);listeners.set(key,group);
  return {get version(){return version;},wait(since:number){return since!==version?Promise.resolve():new Promise<void>(r=>waiters.add(r));},
    close(){group.delete(change);for(const wake of waiters)wake();waiters.clear();if(!group.size)listeners.delete(key);}};
}
function sameIdentity(slot:SlotRecord,event:Pick<Event,'projectId'|'operationId'|'requestHash'|'inputHash'>){
  return slot.operationId===event.operationId&&slot.projectId===event.projectId&&slot.requestHash===event.requestHash&&slot.inputHash===event.inputHash;
}
/** Reserve a durable observation order before I/O. This watermark is a real write, even if capacity is unchanged. */
export async function beginCapacityObservation(root:string,job:Job,runtime=runtimeDirectory()){
  await ensureRegistered(root,runtime);
  return capacityTransaction(runtime,async ledger=>{
    const slot=mergeJob(ledger,root,job);slot.capacity??=initialCapacity(slot);
    return ++slot.capacity.issued;
  });
}
export async function applyCapacityEvent(root:string,event:Event,runtime=runtimeDirectory()){
  let changed=false;
  await capacityTransaction(runtime,async ledger=>{
    const slot=ledger.slots.find(s=>s.operationId===event.operationId);
    if(!slot || !samePath(slot.root,root)||!sameIdentity(slot,event))fail('COORDINATOR_CONFLICT','Capacity evidence identity changed.');
    const cap=slot.capacity!;
    if(slot.taskId&&event.taskId&&slot.taskId!==event.taskId)fail('RECEIPT_CONFLICT','Capacity event changed the original task ID.');
    if(cap.terminal)return;
    const terminalEvidence=event.reason==='provider_terminal'&&!cap.terminal;
    if(!terminalEvidence && (event.sequence<=cap.applied || event.sequence!==cap.issued))return;
    if(slot.taskId && !event.taskId && ['create_ended_without_id','submitter_exited_without_id'].includes(event.reason)){
      // A receipt recovered after this no-ID observation disproves its premise.
      // Consume the old watermark without undoing the accepted-ID capacity fact.
      cap.applied=Math.max(cap.applied,event.sequence);changed=true;return;
    }
    if(event.taskId)slot.taskId=event.taskId;
    cap.applied=Math.max(cap.applied,event.sequence); // Terminal evidence is absorbing, even if another observation started meanwhile.
    if(!cap.terminal){
      cap.state=releases(event.reason)?'released':'held';cap.reason=event.reason;cap.evidence=event.evidence;
      cap.terminal=event.reason==='provider_terminal';cap.decidedAt=new Date().toISOString();cap.version++;
      cap[cap.state==='released'?'lastRelease':'lastRestore']={version:cap.version,reason:cap.reason,evidence:cap.evidence,decidedAt:cap.decidedAt};
      if(!terminal(slot.status))slot.status=event.status;
    }
    changed=true;
  });
  if(changed)notify(runtime);
}
/** Evidence first, then capacity. A crash leaves an issued watermark that startup audits can repair. */
export async function recordCapacityEvent(root:string,job:Job,sequence:number,reason:CapacityReason,evidence:unknown,runtime=runtimeDirectory(),checkpoint?:(point:string,job:Job)=>Promise<void>){
  const event=Event.parse({projectId:job.projectId,operationId:job.operationId,requestHash:job.requestHash,inputHash:job.inputHash,
    sequence,reason,evidence:canonicalSha256(evidence),...(job.taskId?{taskId:job.taskId}:{}),status:job.status});
  const retained=await withProjectWrite(root,async()=>{
    const file=await eventPath(root,job.operationId);
    if(await exists(file)){
      const old=await readEvent(file);
      if(!sameIdentity({...job,root} as SlotRecord,old))fail('COORDINATOR_CONFLICT','Capacity journal identity differs.');
      if(old.taskId&&event.taskId&&old.taskId!==event.taskId)fail('RECEIPT_CONFLICT','Capacity journal changed the original task ID.');
      if(old.reason==='provider_terminal' || old.sequence>=sequence&&reason!=='provider_terminal')return old;
    }
    await writeJson(file,{event,hash:canonicalSha256(event)});
    return event;
  });
  await checkpoint?.('capacity-evidence-saved',job);
  // Apply exactly the durable choice, after releasing the non-reentrant project lock.
  await applyCapacityEvent(root,retained,runtime);
  await checkpoint?.(releases(retained.reason)?'capacity-released':'capacity-restored',job);
}
export async function publishCapacity(root:string,job:Job,reason:CapacityReason,evidence:unknown,runtime=runtimeDirectory(),checkpoint?:(point:string,job:Job)=>Promise<void>){
  if(reason==='provider_terminal' && (await inspectRuntime(runtime)).slots.some(s=>s.operationId===job.operationId&&sameIdentity(s,job)&&s.capacity?.terminal)){
    await capacityTransaction(runtime,async ledger=>{mergeJob(ledger,root,job);});return;
  }
  const sequence=await beginCapacityObservation(root,job,runtime);
  await recordCapacityEvent(root,job,sequence,reason,evidence,runtime,checkpoint);
}

/** Small-record audit only: no Story, plan, listJobs, prompt or media reads; no remote probes. */
export async function auditCapacitySlot(snapshot:SlotRecord,runtime:string){
  const cap=snapshot.capacity??initialCapacity(snapshot);
  if(cap.terminal)return;
  let job:Job|undefined,receipt:z.infer<typeof Receipt>|undefined,event:Event|undefined,reason:CapacityReason|undefined;
  let sourceKey:string;
  try{
    // A live or unidentifiable submission owner is protected before interpreting missing files.
    if(await liveSubmissionLease(snapshot.root,snapshot.operationId))return;
    const file=await eventPath(snapshot.root,snapshot.operationId);
    if(await exists(file)){
      event=await readEvent(file);
      if(!sameIdentity(snapshot,event))fail('COORDINATOR_CONFLICT','Capacity journal differs from its slot.');
      if(snapshot.taskId&&event.taskId&&snapshot.taskId!==event.taskId)fail('RECEIPT_CONFLICT','Capacity journal task ID differs from its slot.');
      if(event.sequence>cap.applied || event.reason==='provider_terminal'){await applyCapacityEvent(snapshot.root,event,runtime);return;}
    }
    job=parse(JobSchema,await readJson(await projectPath(snapshot.root,'.metasocli/jobs/'+snapshot.operationId+'.json')));
    if(!sameIdentity(snapshot,job))fail('JOB_CONFLICT','Capacity source identity changed.');
    if(snapshot.taskId&&job.taskId&&snapshot.taskId!==job.taskId)fail('RECEIPT_CONFLICT','Capacity source changed the original task ID.');
    const receiptFile=await projectPath(snapshot.root,'.metasocli/receipts/'+snapshot.operationId+'.json');
    if(await exists(receiptFile)){
      receipt=parse(Receipt,await readJson(receiptFile));
      if(receipt.operationId!==job.operationId||receipt.requestHash!==job.requestHash||job.taskId&&receipt.taskId!==job.taskId||snapshot.taskId&&receipt.taskId!==snapshot.taskId)fail('RECEIPT_CONFLICT','Capacity receipt identity changed.');
      job.taskId=receipt.taskId;
      if(['prepared','submitting','submit_unknown'].includes(job.status))job.status='queued';
    }
    sourceKey=canonicalSha256({job,receipt:receipt??null});
    if(!job.taskId)reason=job.status==='submit_unknown'?'create_ended_without_id':'submitter_exited_without_id';
    else if(terminal(job.status))reason='provider_terminal';
    else if(receipt && (!snapshot.taskId || receiptRecoveryNeeded(snapshot,receipt.taskId)))reason='remote_active_recovered';
    else if(cap.applied===0 && job.lastError && !['POLL_LIMIT'].includes(job.lastError.code)){
      if(['QUERY_CONTRACT','QUERY_FAILED','QUERY_UNKNOWN','QUERY_DEFERRED','PROVIDER_UNREACHABLE','PROVIDER_HTTP'].includes(job.lastError.code))reason='query_unavailable';
    }
  }catch(error){
    // Unknown ownership is never a licence to delete a lock or release a live submitter.
    if(['LOCK_UNKNOWN','LOCK_BUSY','LOCK_LOST'].some(code=>isCode(error,code)))return;
    // Untrusted source fields must not become this slot's business status or ID.
    job=undefined;receipt=undefined;
    reason='source_unavailable';sourceKey=canonicalSha256({root:snapshot.root,operationId:snapshot.operationId,error:publicError(error).code});
  }
  let changed=false;
  await capacityTransaction(runtime,async ledger=>{
    const slot=ledger.slots.find(s=>s.operationId===snapshot.operationId);
    if(!slot || !samePath(slot.root,snapshot.root)||!sameIdentity(slot,snapshot))fail('COORDINATOR_CONFLICT','Audited slot identity changed.');
    const current=slot.capacity!;
    if(slot.taskId!==snapshot.taskId || current.version!==cap.version || current.issued!==cap.issued || current.applied!==cap.applied || current.terminal)return;
    const repairing=receipt && job && reason!=='source_unavailable' && receiptRecoveryNeeded(slot,receipt.taskId);
    if(current.sourceKey===sourceKey && !repairing)return;
    if(await liveSubmissionLease(slot.root,slot.operationId))return;
    if(receipt && job && repairing){
      await mergeRecoveredJob(ledger,snapshot.root,job,receipt);changed=true;return;
    }
    // Remember unchanged old errors across later remote recovery; don't turn them into fresh failures.
    current.sourceKey=sourceKey;
    if(job?.taskId && (!slot.taskId||slot.taskId===job.taskId))slot.taskId=job.taskId;
    if(reason){
      current.state=releases(reason)?'released':'held';current.reason=reason;current.evidence=sourceKey;
      current.version++;current.decidedAt=new Date().toISOString();current.terminal=reason==='provider_terminal';
      current[current.state==='released'?'lastRelease':'lastRestore']={version:current.version,reason,evidence:sourceKey,decidedAt:current.decidedAt};
      if(job)slot.status=!job.taskId&&['submitting','submit_unknown'].includes(job.status)?'submit_unknown':job.status==='prepared'&&slot.status==='reserved'?'reserved':job.status;
    }
    changed=true;
  });
  if(changed)notify(runtime);
}
/** The caller may consume free capacity immediately. Workers apply ready items independently. */
export function startCapacityAudit(runtime:string){
  let failure:unknown,stopped=false;
  const done=(async()=>{
    const ledger=await inspectRuntime(runtime);
    const candidates=ledger.slots.filter(s=>!s.capacity?.terminal && (occupied({ ...ledger,slots:[s] }).length || receiptRecoveryNeeded(s) || (s.capacity?.issued??0)>(s.capacity?.applied??0)));
    let cursor=0;
    await Promise.all(Array.from({length:Math.min(4,candidates.length)},async()=>{
      while(!stopped){const slot=candidates[cursor++];if(!slot)return;await auditCapacitySlot(slot,runtime);}
    }));
  })().catch(error=>{failure=error;});
  return {done,check(){if(failure)throw failure;},async close(){stopped=true;await done;if(failure)throw failure;}};
}
