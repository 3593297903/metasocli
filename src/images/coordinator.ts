import { join } from 'node:path';
import { z } from 'zod';
import { parse, Hash, Id } from '../contracts/story.js';
import { fail } from '../core/errors.js';
import { loadStory } from '../core/project.js';
import { exists, safePath, projectPath, pathIdentity, samePath } from '../storage/paths.js';
import { readJson, writeJson } from '../storage/io.js';
import { canonicalSha256 } from '../storage/canonical.js';
import { serialized, waitLease, acquireLease, liveLease, assertLegacySchedulerIdle } from '../storage/locking.js';
import { runtimeDirectory } from '../jobs/coordinator.js';
import { ImageProfile, ImageStatus, resolvedImage, type ImageJobRecord, type Profile } from './contracts.js';
import { readImageJob, readBodyReceipt } from './store.js';

const Slot=z.object({root:z.string(),projectId:z.uuid(),planId:z.uuid(),operationId:z.uuid(),assetId:Id,fingerprint:Hash,status:ImageStatus,requestHash:Hash.optional(),
  requestStartedAt:z.iso.datetime().optional(),limits:ImageProfile.shape.providerLimits}).strict();
const Ledger=z.object({schemaVersion:z.literal(1),owner:z.literal('metasocli-images'),hash:Hash,slots:z.array(Slot)}).strict();
type LedgerRecord=z.infer<typeof Ledger>;
export const imageRuntime=(profile:Profile,runtime?:string)=>join(runtimeDirectory(runtime),'images',profile.quotaGroup);
export const imageSlot=(root:string,job:ImageJobRecord):z.infer<typeof Slot>=>({root,projectId:job.projectId,planId:job.planId,operationId:job.operationId,assetId:job.assetId,fingerprint:job.fingerprint,status:job.status,...(job.requestHash?{requestHash:job.requestHash}:{}),...(job.requestStartedAt?{requestStartedAt:job.requestStartedAt}:{})});
function validateLedger(ledger:LedgerRecord){
  const ids=new Set<string>(),roots=new Map<string,string>(),projects=new Map<string,string>();
  for(const s of ledger.slots){const root=pathIdentity(s.root);
    if(ids.has(s.operationId)||(roots.has(root)&&roots.get(root)!==s.projectId)||(projects.has(s.projectId)&&projects.get(s.projectId)!==root))fail('IMAGE_LEDGER_CONFLICT','Image ledger has duplicate operations or conflicting project/root identities.');
    ids.add(s.operationId);roots.set(root,s.projectId);projects.set(s.projectId,root);
  }
}
export function assertImageProject(ledger:LedgerRecord,root:string,projectId:string){
  if(ledger.slots.some(s=>(samePath(s.root,root)&&s.projectId!==projectId)||(s.projectId===projectId&&!samePath(s.root,root))))fail('IMAGE_LEDGER_CONFLICT','Image project/root identity changed.');
}
export async function withImageLedger<T>(profile:Profile,runtime:string|undefined,work:(ledger:LedgerRecord,save:()=>Promise<void>)=>Promise<T>):Promise<T>{
  const folder=await safePath(imageRuntime(profile,runtime));return serialized('images:'+pathIdentity(folder),async()=>{const lease=await waitLease(join(folder,'ledger.lock'));
    try{const file=join(folder,'ledger.json'),marker=join(folder,'owner.json');let ledger:LedgerRecord;
      if(await exists(file)){ledger=parse(Ledger,await readJson(file));const{hash,...base}=ledger;if(hash!==canonicalSha256(base))fail('IMAGE_LEDGER_TAMPERED','Image runtime ledger hash changed.');}
      else{if(await exists(marker))fail('IMAGE_LEDGER_MISSING','Image runtime ledger is missing; preserve unresolved records.');ledger={schemaVersion:1,owner:'metasocli-images',hash:'0'.repeat(64),slots:[]};}
      validateLedger(ledger);
      const save=async()=>{await lease.assertOwned();validateLedger(ledger);const{hash:_,...base}=ledger;ledger.hash=canonicalSha256(base);await writeJson(file,parse(Ledger,ledger));await writeJson(marker,{owner:'metasocli-images',schemaVersion:1});};
      return await work(ledger,save);
    }finally{await lease.release();}});
}
export async function updateImageSlot(root:string,job:ImageJobRecord,profile:Profile,runtime?:string){await withImageLedger(profile,runtime,async(ledger,save)=>{
  if((await loadStory(root)).projectId!==job.projectId)fail('IMAGE_LEDGER_CONFLICT','Image job project identity changed.');
  assertImageProject(ledger,root,job.projectId);
  const old=ledger.slots.find(s=>s.operationId===job.operationId);
  if(old&&(!samePath(old.root,root)||old.projectId!==job.projectId||old.fingerprint!==job.fingerprint||(old.requestHash&&job.requestHash&&old.requestHash!==job.requestHash)))fail('IMAGE_LEDGER_CONFLICT','Image operation identity conflicts with its ledger.');
  if(old)Object.assign(old,imageSlot(old.root,job));else ledger.slots.push({...imageSlot(root,job),...(profile.providerLimits?{limits:profile.providerLimits}:{})});await save();});}
export async function reconcileImageLedger(root:string,profile:Profile,runtime?:string){return withImageLedger(profile,runtime,async(ledger,save)=>{
  const projectId=(await loadStory(root)).projectId;assertImageProject(ledger,root,projectId);
  for(const slot of ledger.slots.filter(s=>samePath(s.root,root)&&s.projectId===projectId)){
    const job=await readImageJob(root,slot.operationId);if(job.fingerprint!==slot.fingerprint||job.projectId!==slot.projectId||job.planId!==slot.planId||job.assetId!==slot.assetId||(slot.requestHash&&job.requestHash!==slot.requestHash))fail('IMAGE_LEDGER_CONFLICT','Image ledger input changed.');
    if(resolvedImage(slot.status)&&!resolvedImage(job.status))continue;
    Object.assign(slot,imageSlot(slot.root,job));
    if(job.status==='submitting'&&!await liveLease(await projectPath(root,`.metasocli/image-receipts/${job.operationId}/receiver.lock`))){const body=await readBodyReceipt(root,job);slot.status=body?'response_saved':'submit_unknown';}
  }await save();return ledger;
});}
export function assertKnownCapacity(profile:Profile,requests:number){const limits=profile.providerLimits;if(!limits)return;
  if(limits.batch!==undefined&&limits.batch<requests)fail('IMAGE_PROVIDER_LIMIT','Known batch scope limit is smaller than this frozen request scope; no POST was sent.');}
export function imageCapacityWait(ledger:LedgerRecord,profile:Profile,now=Date.now()):'concurrent'|'rpm'|undefined{
  const possible=(s:z.infer<typeof Slot>)=>['submitting','submit_unknown','response_saved'].includes(s.status);
  const limits=[profile.providerLimits,...ledger.slots.filter(s=>!resolvedImage(s.status)||(s.requestStartedAt&&now-Date.parse(s.requestStartedAt)<60000)).map(s=>s.limits)].filter(l=>l!==undefined);
  const concurrent=Math.min(...limits.flatMap(l=>l.concurrent===undefined?[]:[l.concurrent]));
  const rpm=Math.min(...limits.flatMap(l=>l.rpm===undefined?[]:[l.rpm]));
  if(ledger.slots.filter(possible).length>=concurrent)return 'concurrent';
  if(ledger.slots.filter(s=>s.requestStartedAt?now-Date.parse(s.requestStartedAt)<60000:possible(s)).length>=rpm)return 'rpm';
  return undefined;
}
export async function acquireImageScheduler(root:string,profile:Profile,runtime?:string){
  await loadStory(root);const legacy=await safePath(join(imageRuntime(profile,runtime),'scheduler.lock'));
  await assertLegacySchedulerIdle(legacy);
  const lease=await acquireLease(await projectPath(root,'.metasocli/image-scheduler.lock'));
  try{await assertLegacySchedulerIdle(legacy);return lease;}catch(error){await lease.release();throw error;}
}
