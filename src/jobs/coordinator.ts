import { z } from 'zod';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Hash, parse } from '../contracts/story.js';
import { JobSchema, Receipt, type Job } from '../contracts/job.js';
import { loadStory } from '../core/project.js';
import { fail } from '../core/errors.js';
import { exists, pathIdentity, safePath, samePath, projectPath } from '../storage/paths.js';
import { readJson, writeJson } from '../storage/io.js';
import { canonicalSha256 } from '../storage/canonical.js';
import { liveProjectLease, serialized, waitLease, assertLegacySchedulerIdle } from '../storage/locking.js';
import { listJobs } from './store.js';
import { listVideoRetries } from './video-retry.js';
import { BatchPlan, BatchRun } from '../contracts/batch.js';
import { CapacityDecision, dispatchShares } from './capacity-policy.js';
import { liveSubmissionLease } from './submission-owner.js';
import { liveLease } from '../storage/locking.js';
import { open } from 'node:fs/promises';

const Slot = z.object({ root: z.string(), projectId: z.uuid(), operationId: z.uuid(), requestHash: Hash, inputHash: Hash,
  taskId: z.string().optional(), status: z.enum([...JobSchema.shape.status.options, 'reserved']), updatedAt: z.iso.datetime(), capacity: CapacityDecision.optional() }).strict();
const Ticket = z.object({ id:z.uuid(), root:z.string(), projectId:z.uuid(), binding:Hash, token:z.uuid(),
  lease:z.string(), capacity:z.number().int().min(1).max(4), remaining:z.number().int().nonnegative(), eligible:z.boolean(),entering:z.array(z.uuid()).optional(),kind:z.enum(['batch','single']).optional() }).strict();
const Ledger = z.object({ schemaVersion: z.union([z.literal(1),z.literal(2)]), owner: z.literal('metasocli'), hash: Hash,
  projects: z.array(z.object({ root: z.string(), projectId: z.uuid(), retiredAt: z.iso.datetime().optional(), coverage:z.literal(2).optional() }).strict()), slots: z.array(Slot), tickets:z.array(Ticket).optional() }).strict();
export type LedgerState = z.infer<typeof Ledger>;
export type SlotRecord = z.infer<typeof Slot>;
export const terminal = (status: string) => ['generated', 'downloaded', 'failed', 'cancelled'].includes(status);
export const occupied = (ledger: LedgerState) => ledger.slots.filter(s => s.capacity ? s.capacity.state==='held' : !terminal(s.status) && (s.status !== 'prepared' || !!s.taskId));
export const projectOccupied = (root: string, ledger: LedgerState) => occupied(ledger).filter(s => samePath(s.root, root));
export function capacitySnapshot(root: string, ledger: LedgerState) {
  const sharedOccupied = occupied(ledger).length, currentProjectOccupied = projectOccupied(root, ledger).length;
  return { sharedLimit: 4, sharedOccupied, currentProjectOccupied, otherProjectsOccupied: sharedOccupied - currentProjectOccupied,
    available: Math.max(0, 4 - sharedOccupied), source: 'persisted-ledger' as const, liveCheckPerformed: false,
    decisions:ledger.slots.filter(s=>samePath(s.root,root)).map(s=>({operationId:s.operationId,taskId:s.taskId??null,businessStatus:s.status,capacity:s.capacity??null})) };
}
export const capacityAvailable = (root: string, ledger: LedgerState, capacity = 4, heldId?: string, ticketId?:string) => {
  const held = occupied(ledger).filter(s => s.operationId !== heldId);
  if (!(held.length < 4 && held.filter(s => samePath(s.root, root)).length < capacity)) return false;
  const tickets=ledger.tickets??[];
  const shares=dispatchShares(held.map(s=>pathIdentity(s.root)),tickets.map(t=>({...t,root:pathIdentity(t.root)})));
  const index=tickets.findIndex(t=>t.id===ticketId);
  // Consume ready shares in ticket order. Lower-priority preparation may run, but
  // cannot overtake the earlier run's next legal POST when several slots free together.
  return ticketId ? (shares[index]??0)>0 && !tickets.slice(0,index).some((t,i)=>t.kind!=='single'&&(shares[i]!>0||!!t.entering?.length)) : tickets.every((_,i)=>shares[i]===0);
};
export const unsafeSlots = (ledger: LedgerState) => occupied(ledger).filter(s => ['submit_unknown', 'query_unknown'].includes(s.status));
export interface BatchDispatchBinding {batchId:string;planId?:string;segmentId?:string;requestHash?:string;inputHash?:string}
/** Explicit batch acknowledgements are bound to the immutable authorized scope. They never release occupied slots. */
async function acceptedByBatch(root:string,binding:BatchDispatchBinding) {
  const id=parse(z.uuid(),binding.batchId),folder='.metasocli/batches/'+id+'/';
  const plan=parse(BatchPlan,await readJson(await projectPath(root,folder+'plan.json'))),run=parse(BatchRun,await readJson(await projectPath(root,folder+'run.json')));
  const {batchHash,...planBase}=plan,{hash,...runBase}=run;
  if(canonicalSha256(planBase)!==batchHash||canonicalSha256(runBase)!==hash||run.batchId!==id||plan.batchId!==id||run.batchHash!==batchHash||run.authorization.batchHash!==batchHash||plan.projectId!==(await loadStory(root)).projectId)fail('BATCH_ACK_CONFLICT','Batch acknowledgement identity or hash changed.');
  if(binding.planId!==undefined&&!plan.items.some(i=>i.planId===binding.planId&&i.segmentId===binding.segmentId&&i.requestHash===binding.requestHash&&i.inputHash===binding.inputHash))fail('BATCH_ACK_SCOPE','Acknowledgement does not cover this immutable request.');
  return run.authorization.acceptedUnknown??[];
}
/** Only this story's unknowns veto dispatch. All projects' possible requests still occupy shared capacity. */
export async function blockingSlots(root: string, ledger: LedgerState, runtime?: string,binding?:BatchDispatchBinding) {
  // Dispatch scope is an authorization check, independent of unknown capacity.
  // Ordinary capacity-only polling still avoids all historical retry-file reads.
  const dispatchAccepted=binding?.planId!==undefined?await acceptedByBatch(root,binding):undefined;
  if(!unsafeSlots(ledger).some(s=>samePath(s.root,root)))return [];
  const acknowledged = new Set((await listVideoRetries(root, runtimeDirectory(runtime))).map(a => a.oldOperationId));
  const accepted=dispatchAccepted??(binding?await acceptedByBatch(root,binding):[]);
  return unsafeSlots(ledger).filter(s=>samePath(s.root,root)).filter(s=>{
    if(s.status!=='submit_unknown'||s.taskId)return true;
    if(samePath(s.root,root)&&acknowledged.has(s.operationId))return false;
    return !accepted.some(a=>samePath(a.root,s.root)&&a.projectId===s.projectId&&a.operationId===s.operationId&&a.requestHash===s.requestHash&&a.inputHash===s.inputHash);
  });
}
export function runtimeDirectory(injected?: string) { return resolve(injected ?? process.env.METASO_RUNTIME_DIR ?? join(homedir(), '.metasocli-runtime')); }
async function readLedger(runtime: string): Promise<LedgerState> {
  const file = await safePath(join(runtime, 'video-ledger.json')), marker = await safePath(join(runtime, 'owner.json'));
  if (!await exists(file)) {
    if (await exists(marker)) fail('COORDINATOR_MISSING', 'Shared reservations are missing; preserve runtime and reconcile before creating.');
    return { schemaVersion: 2, owner: 'metasocli', hash: '0'.repeat(64), projects: [], slots: [], tickets:[] };
  }
  const ledger = parse(Ledger, await readJson(file)), { hash, ...base } = ledger;
  if (canonicalSha256(base) !== hash) fail('COORDINATOR_TAMPERED', 'Shared reservation hash mismatch.');
  const owner=await readJson(marker) as {owner?:string;schemaVersion?:number};
  if(owner.owner!=='metasocli'||owner.schemaVersion!==1)fail('COORDINATOR_OWNER','Shared installation owner marker conflicts.');
  if(ledger.schemaVersion===1 && (ledger.tickets || ledger.slots.some(s=>s.capacity) || ledger.projects.some(p=>p.coverage)))fail('COORDINATOR_TAMPERED','Legacy ledger contains new-format fields.');
  if(ledger.schemaVersion===2 && (!ledger.tickets || ledger.slots.some(s=>!s.capacity)))fail('COORDINATOR_TAMPERED','R3 capacity coverage is incomplete.');
  validateIdentities(ledger);
  return ledger;
}
/** Read-only inspection for status; no registration, synchronization or capacity release. */
export async function inspectRuntime(runtime?: string) { return readLedger(runtimeDirectory(runtime)); }
async function saveLedger(runtime: string, ledger: LedgerState) {
  const { hash: _, ...base } = ledger; ledger.hash = canonicalSha256(base);
  await writeJson(await safePath(join(runtime, 'video-ledger.json')), ledger);
  const marker=await safePath(join(runtime,'owner.json'));
  if(!await exists(marker))await writeJson(marker, { owner: 'metasocli', schemaVersion: 1 });
}
export function initialCapacity(slot: Pick<SlotRecord,'status'|'taskId'|'operationId'>): z.infer<typeof CapacityDecision> {
  const held=!terminal(slot.status) && (slot.status!=='prepared'||!!slot.taskId);
  return {policy:'R3',state:held?'held':'released',version:0,issued:0,applied:0,reason:terminal(slot.status)?'provider_terminal':'reserved',
    terminal:terminal(slot.status),evidence:canonicalSha256([slot.operationId,slot.status,slot.taskId??null]),decidedAt:new Date().toISOString()};
}
export function slotFor(root: string, job: Job): SlotRecord {
  return { root: resolve(root), projectId: job.projectId, operationId: job.operationId, requestHash: job.requestHash, inputHash: job.inputHash,
    ...(job.taskId ? { taskId: job.taskId } : {}), status: job.status, updatedAt: job.updatedAt, capacity:initialCapacity(job) };
}
/** Migrate equivalent v1 spellings only after hash verification. Never discard a reservation. */
function normalizeRoots(ledger: LedgerState) {
  const projects = new Map<string, LedgerState['projects'][number]>(), rootsById = new Map<string, string>();
  for (const project of ledger.projects) {
    // Keep the access spelling: Node's permission allow-list can be case-sensitive
    // even on Windows. Only identity keys/comparisons are case-folded.
    project.root = resolve(project.root);
    const identity = pathIdentity(project.root), previous = projects.get(identity), previousRoot = rootsById.get(project.projectId);
    if ((previous && previous.projectId !== project.projectId) || (previousRoot && previousRoot !== identity)) {
      fail('COORDINATOR_CONFLICT', 'Registered project and root identities differ. Restore the original project path before recovery.');
    }
    if (!previous) projects.set(identity, project);
    rootsById.set(project.projectId, identity);
  }
  ledger.projects = [...projects.values()];
  const operations = new Set<string>();
  for (const slot of ledger.slots) {
    const project = projects.get(pathIdentity(slot.root));
    if (project?.projectId !== slot.projectId || operations.has(slot.operationId)) {
      fail('COORDINATOR_CONFLICT', 'Reservation has a conflicting project or operation identity.');
    }
    slot.root = project.root;
    operations.add(slot.operationId);
  }
}
function validateIdentities(ledger: LedgerState) {
  normalizeRoots(structuredClone(ledger));
  const ids = ledger.slots.flatMap(s => s.taskId ? [s.taskId] : []);
  if (ids.length !== new Set(ids).size) fail('TASK_LINK_CONFLICT', 'Remote task is registered more than once across projects.');
  const tickets=ledger.tickets??[];
  if(new Set(tickets.map(t=>t.id)).size!==tickets.length || tickets.some(t=>!ledger.projects.some(p=>p.projectId===t.projectId&&samePath(p.root,t.root))))fail('COORDINATOR_CONFLICT','Dispatch ticket identity differs from its registered project.');
}
export function mergeJob(ledger:LedgerState,root:string,job:Job) {
  const slot=ledger.slots.find(s=>s.operationId===job.operationId);
  if(slot){
    if(!samePath(slot.root,root)||slot.projectId!==job.projectId||slot.requestHash!==job.requestHash||slot.inputHash!==job.inputHash
      ||slot.taskId&&job.taskId&&slot.taskId!==job.taskId)fail('COORDINATOR_CONFLICT','Reservation and task identity differ.');
    if(terminal(slot.status)&&!terminal(job.status))return slot;
    Object.assign(slot,{...slotFor(root,job),...(slot.taskId?{taskId:slot.taskId}:{}),capacity:slot.capacity??initialCapacity(slot),
      ...(job.status==='prepared'&&slot.status!=='prepared'?{status:slot.status}:{})});
    return slot;
  }
  const next=slotFor(root,job);ledger.slots.push(next);return next;
}
/** A bounded receipt repair, not permission to revive every released queued Job. */
export function receiptRecoveryNeeded(slot:SlotRecord,taskId=slot.taskId){
  const cap=slot.capacity;
  return !!taskId && !!cap && !cap.terminal &&
    (cap.state==='held' && !slot.taskId || cap.state==='released' &&
      (['create_ended_without_id','submitter_exited_without_id'].includes(cap.reason) ||
        !slot.taskId && ['source_unavailable','reserved'].includes(cap.reason)));
}
/** Caller owns the shared transaction. Index a newly proven ID and its capacity together. */
export async function mergeRecoveredJob(ledger:LedgerState,root:string,job:Job,knownReceipt?:z.infer<typeof Receipt>){
  const previous=ledger.slots.find(s=>s.operationId===job.operationId);
  if(!previous || !receiptRecoveryNeeded(previous,job.taskId))return mergeJob(ledger,root,job);
  if(!samePath(previous.root,root)||previous.projectId!==job.projectId||previous.requestHash!==job.requestHash||previous.inputHash!==job.inputHash)
    fail('COORDINATOR_CONFLICT','Recovered receipt belongs to another reservation.');
  const file=await projectPath(root,'.metasocli/receipts/'+job.operationId+'.json');
  const receipt=knownReceipt??(await exists(file)?parse(Receipt,await readJson(file)):undefined);
  if(!receipt)return previous; // A bare Job.taskId is not a newly verified acceptance.
  if(receipt.operationId!==job.operationId||receipt.requestHash!==job.requestHash||receipt.taskId!==job.taskId||previous.taskId&&previous.taskId!==receipt.taskId)
    fail('RECEIPT_CONFLICT','Recovered receipt and reservation identities differ.');
  const slot=mergeJob(ledger,root,job),cap=slot.capacity!;
  cap.state=terminal(job.status)?'released':'held';cap.reason=terminal(job.status)?'provider_terminal':'remote_active_recovered';
  cap.terminal=terminal(job.status);cap.evidence=canonicalSha256(receipt);cap.sourceKey=canonicalSha256({job,receipt});
  cap.version++;cap.decidedAt=new Date().toISOString();
  cap[cap.state==='released'?'lastRelease':'lastRestore']={version:cap.version,reason:cap.reason,evidence:cap.evidence,decidedAt:cap.decidedAt};
  return slot;
}
async function sync(ledger: LedgerState, root: string) {
  normalizeRoots(ledger);
  const story = await loadStory(root), registered = ledger.projects.find(p => samePath(p.root, root));
  if (registered && registered.projectId !== story.projectId) fail('COORDINATOR_CONFLICT', 'Registered project identity changed.');
  if (ledger.projects.some(p => p.projectId === story.projectId && !samePath(p.root, root))) {
    fail('COORDINATOR_CONFLICT', 'This project identity is registered at another root. Restore the original project path before recovery.');
  }
  if (!registered) ledger.projects.push({ root, projectId: story.projectId });
  for (const project of ledger.projects.filter(p => samePath(p.root, root))) {
    const slots = ledger.slots.filter(s => samePath(s.root, project.root));
    delete project.retiredAt; // A restored root must pass the original identity and job checks again.
    if ((await loadStory(project.root)).projectId !== project.projectId) fail('COORDINATOR_CONFLICT', 'Registered story no longer has its original identity.');
    const jobs = await listJobs(project.root);
    for (const slot of slots) {
      if (!jobs.some(j => j.operationId === slot.operationId) && !terminal(slot.status)) { slot.status = 'submit_unknown'; }
    }
    for (const job of jobs) {
      const i = ledger.slots.findIndex(s => s.operationId === job.operationId);
      if (i >= 0) {
        const slot = ledger.slots[i]!;
        if (!samePath(slot.root, project.root) || slot.projectId !== job.projectId || slot.requestHash !== job.requestHash || slot.inputHash !== job.inputHash
          || (slot.taskId && job.taskId && slot.taskId !== job.taskId)) fail('COORDINATOR_CONFLICT', 'Reservation and task identity differ.');
        // A queued prepared job is not a reservation. An existing reservation must
        // survive a crash between the ledger save and submitting intent.
        if (terminal(slot.status) && !terminal(job.status)) continue;
        await mergeRecoveredJob(ledger,project.root,job);
      } else if (job.status !== 'prepared') ledger.slots.push(slotFor(project.root, job));
    }
  }
  const ids = ledger.slots.flatMap(s => s.taskId ? [s.taskId] : []);
  if (ids.length !== new Set(ids).size) fail('TASK_LINK_CONFLICT', 'Remote task is registered more than once across projects.');
  ledger.projects.find(p=>samePath(p.root,root))!.coverage=2;
}
/** Lock order: shared ledger -> short project write. Never acquire this while holding a project lock. */
export async function capacityTransaction<T>(runtime:string,work:(ledger:LedgerState,save:()=>Promise<void>)=>Promise<T>):Promise<T>{
  runtime=await safePath(runtime);
  return serialized('ledger:' + pathIdentity(runtime), async () => {
    const lease = await waitLease(join(runtime, 'coordinator.lock'));
    try {
      const ledger = await readLedger(runtime); let saved=ledger.hash;
      if(ledger.schemaVersion===1){
        // Cold upgrade only. Do not rewrite or steal live/unknown legacy leases.
        await assertLegacySchedulerIdle(join(runtime,'batch.lock'));
        for(const project of ledger.projects)if(await liveProjectLease(project.root,'.metasocli/batch-scheduler.lock'))fail('COORDINATOR_UPGRADE_BUSY','Stop old execution processes before the R3 cold upgrade.');
        for(const slot of ledger.slots)if(await liveSubmissionLease(slot.root,slot.operationId))fail('COORDINATOR_UPGRADE_BUSY','A submitter is still active during cold upgrade.');
        const backup=await safePath(join(runtime,'video-ledger.v1-'+ledger.hash+'.json'));
        if(!await exists(backup)){
          const file=await open(backup,'wx',0o600);
          try{await file.writeFile(JSON.stringify(ledger,null,2)+'\n');await file.sync();}finally{await file.close();}
        }else if(canonicalSha256(await readJson(backup))!==canonicalSha256(ledger))fail('COORDINATOR_BACKUP','Migration backup differs; preserve both records.');
        ledger.schemaVersion=2;ledger.tickets=[];
        for(const slot of ledger.slots)slot.capacity=initialCapacity(slot);
      }
      normalizeRoots(ledger); // Persist equivalent legacy Windows spellings without a full story scan.
      const save = async () => {
        const {hash,...base}=ledger;const next=canonicalSha256(base);
        if(next===saved)return;
        await lease.assertOwned();validateIdentities(ledger);parse(Ledger,ledger);await saveLedger(runtime, ledger);saved=ledger.hash;
      };
      const result=await work(ledger,save);await save();return result;
    } finally { await lease.release(); }
  });
}
/** Explicit full synchronization only. Capacity polling never calls this path. */
export async function withCoordinator<T>(root:string,runtime:string,work:(ledger:LedgerState,save:()=>Promise<void>)=>Promise<T>):Promise<T>{
  root=await safePath(root);
  return capacityTransaction(runtime,async(ledger,save)=>{await sync(ledger,root);await save();return work(ledger,save);});
}
export async function ensureRegistered(root:string,runtime:string){
  const ledger=await inspectRuntime(runtime);
  if(ledger.schemaVersion===2 && ledger.projects.some(p=>samePath(p.root,root)&&p.coverage===2))return;
  await reconcileRuntime(root,runtime);
}
export async function refreshTickets(ledger:LedgerState){
  for(const ticket of ledger.tickets??[]){
    if(ticket.eligible && (await liveLease(await projectPath(ticket.root,ticket.lease)))?.token!==ticket.token){ticket.eligible=false;ticket.remaining=0;}
  }
  // Only active runs belong in the global hot set. Durable batch/intent files retain historical evidence.
  ledger.tickets=(ledger.tickets??[]).filter(t=>t.eligible&&(t.remaining>0||!!t.entering?.length));
}
export async function setDispatchTicket(runtime:string,ticket:z.infer<typeof Ticket>){
  await capacityTransaction(runtime,async ledger=>{
    await refreshTickets(ledger);
    if((await liveLease(await projectPath(ticket.root,ticket.lease)))?.token!==ticket.token)fail('LOCK_LOST','Dispatch owner is no longer active.');
    const old=ledger.tickets!.find(t=>t.id===ticket.id);
    if(old && (old.token!==ticket.token||old.binding!==ticket.binding||old.projectId!==ticket.projectId||!samePath(old.root,ticket.root)))fail('COORDINATOR_CONFLICT','Dispatch ticket binding changed.');
    if(old)Object.assign(old,Ticket.parse(ticket));else if(ticket.remaining>0&&ticket.eligible)ledger.tickets!.push(Ticket.parse(ticket));
  });
}
export async function dispatchEntered(runtime:string,id:string,operationId:string){
  await capacityTransaction(runtime,async ledger=>{
    const ticket=ledger.tickets?.find(t=>t.id===id);
    if(!ticket)return; // A stopped scheduler may have already yielded its priority; the durable reservation remains.
    ticket.entering=(ticket.entering??[]).filter(op=>op!==operationId);
    if(!ticket.remaining&&!ticket.entering.length)ticket.eligible=false;
  });
}
export async function closeDispatchTicket(runtime:string,id:string){
  await capacityTransaction(runtime,async ledger=>{ledger.tickets=(ledger.tickets??[]).filter(t=>t.id!==id);});
}
export async function reconcileRuntime(root: string, runtime?: string) {
  return withCoordinator(root, runtimeDirectory(runtime), async ledger => ledger);
}
export async function requireScheduler(root: string, runtime: string, token?: string) {
  await assertLegacySchedulerIdle(join(runtime, 'batch.lock'));
  const scheduler = await liveProjectLease(root, '.metasocli/batch-scheduler.lock');
  if (scheduler && scheduler.token !== token) fail('SCHEDULER_BUSY', 'A batch owns this story scheduler; resume its existing tasks or wait for this story.');
  if (token && scheduler?.token !== token) fail('LOCK_LOST', 'Batch scheduler ownership was lost.');
}
export async function acquireScheduler(root: string, runtime: string, waitMs = 30000) {
  await loadStory(root);
  await assertLegacySchedulerIdle(join(runtime, 'batch.lock'));
  const lease = await waitLease(await projectPath(root, '.metasocli/batch-scheduler.lock'), waitMs);
  try { await assertLegacySchedulerIdle(join(runtime, 'batch.lock')); return lease; }
  catch (error) { await lease.release(); throw error; }
}
