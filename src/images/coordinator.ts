import { join } from 'node:path';
import { z } from 'zod';
import { parse, Hash, Id } from '../contracts/story.js';
import { fail } from '../core/errors.js';
import { loadStory } from '../core/project.js';
import { exists, safePath, pathIdentity, samePath } from '../storage/paths.js';
import { readJson, writeJson } from '../storage/io.js';
import { canonicalSha256 } from '../storage/canonical.js';
import { serialized, waitLease, acquireLease } from '../storage/locking.js';
import { runtimeDirectory } from '../jobs/coordinator.js';
import { ImageStatus, resolvedImage, type ImageJobRecord, type Profile } from './contracts.js';
import { readImageJob, readBodyReceipt } from './store.js';

const Slot=z.object({root:z.string(),projectId:z.uuid(),planId:z.uuid(),operationId:z.uuid(),assetId:Id,fingerprint:Hash,status:ImageStatus,requestHash:Hash.optional()}).strict();
const Ledger=z.object({schemaVersion:z.literal(1),owner:z.literal('metasocli-images'),hash:Hash,slots:z.array(Slot)}).strict();
type LedgerRecord=z.infer<typeof Ledger>;
export const imageRuntime=(profile:Profile,runtime?:string)=>join(runtimeDirectory(runtime),'images',profile.quotaGroup);
export const imageSlot=(root:string,job:ImageJobRecord):z.infer<typeof Slot>=>({root,projectId:job.projectId,planId:job.planId,operationId:job.operationId,assetId:job.assetId,fingerprint:job.fingerprint,status:job.status,...(job.requestHash?{requestHash:job.requestHash}:{})});
export async function withImageLedger<T>(profile:Profile,runtime:string|undefined,work:(ledger:LedgerRecord,save:()=>Promise<void>)=>Promise<T>):Promise<T>{
  const folder=await safePath(imageRuntime(profile,runtime));return serialized('images:'+pathIdentity(folder),async()=>{const lease=await waitLease(join(folder,'ledger.lock'));
    try{const file=join(folder,'ledger.json'),marker=join(folder,'owner.json');let ledger:LedgerRecord;
      if(await exists(file)){ledger=parse(Ledger,await readJson(file));const{hash,...base}=ledger;if(hash!==canonicalSha256(base))fail('IMAGE_LEDGER_TAMPERED','Image runtime ledger hash changed.');}
      else{if(await exists(marker))fail('IMAGE_LEDGER_MISSING','Image runtime ledger is missing; preserve unresolved records.');ledger={schemaVersion:1,owner:'metasocli-images',hash:'0'.repeat(64),slots:[]};}
      const save=async()=>{await lease.assertOwned();const{hash:_,...base}=ledger;ledger.hash=canonicalSha256(base);await writeJson(file,parse(Ledger,ledger));await writeJson(marker,{owner:'metasocli-images',schemaVersion:1});};
      return await work(ledger,save);
    }finally{await lease.release();}});
}
export async function updateImageSlot(root:string,job:ImageJobRecord,profile:Profile,runtime?:string){await withImageLedger(profile,runtime,async(ledger,save)=>{
  const old=ledger.slots.find(s=>s.operationId===job.operationId);
  if(old&&(!samePath(old.root,root)||old.projectId!==job.projectId||old.fingerprint!==job.fingerprint||(old.requestHash&&job.requestHash&&old.requestHash!==job.requestHash)))fail('IMAGE_LEDGER_CONFLICT','Image operation identity conflicts with its ledger.');
  if(old)Object.assign(old,imageSlot(old.root,job));else ledger.slots.push(imageSlot(root,job));await save();});}
export async function reconcileImageLedger(profile:Profile,runtime?:string){return withImageLedger(profile,runtime,async(ledger,save)=>{
  for(const slot of ledger.slots){await safePath(slot.root);if(!await exists(slot.root)){if(resolvedImage(slot.status))continue;fail('IMAGE_PROJECT_MISSING','Unresolved image project is missing; restore it without dropping requests.');}
    if((await loadStory(slot.root)).projectId!==slot.projectId)fail('IMAGE_LEDGER_CONFLICT','Registered image project identity changed.');
    const job=await readImageJob(slot.root,slot.operationId);if(job.fingerprint!==slot.fingerprint||job.projectId!==slot.projectId)fail('IMAGE_LEDGER_CONFLICT','Image ledger input changed.');
    Object.assign(slot,imageSlot(slot.root,job));
    if(job.status==='submitting'){const body=await readBodyReceipt(slot.root,job);slot.status=body?'response_saved':'submit_unknown';}
  }await save();return ledger;
});}
export function assertKnownCapacity(profile:Profile,requests:number){const limits=profile.providerLimits;if(!limits)return;
  if([limits.concurrent,limits.rpm,limits.batch].some(n=>n!==undefined&&n<requests))fail('IMAGE_PROVIDER_LIMIT','Known provider limit is smaller than the frozen all-ready request scope; no POST was sent.');}
export async function acquireImageScheduler(profile:Profile,runtime?:string){return acquireLease(await safePath(join(imageRuntime(profile,runtime),'scheduler.lock')));}
