import { readdir } from 'node:fs/promises';
import { z } from 'zod';
import { parse } from '../contracts/story.js';
import { fail } from '../core/errors.js';
import { exists, projectPath } from '../storage/paths.js';
import { readJson, writeJson } from '../storage/io.js';
import { canonicalSha256 } from '../storage/canonical.js';
import { BodyReceipt, ImageJob, ImagePlan, ImageRun, type ImageJobRecord, type ImagePlanRecord, type ImageRunRecord } from './contracts.js';
export const imagePath = (root:string, directory:string, id:string) => projectPath(root, `.metasocli/${directory}/${parse(z.uuid(),id)}.json`);
export const receiptFile = (id:string, name:string) => `.metasocli/image-receipts/${parse(z.uuid(),id)}/${name}`;
export async function readImagePlan(root:string,id:string):Promise<ImagePlanRecord> {
  const p=parse(ImagePlan,await readJson(await imagePath(root,'image-plans',id))),{planHash,...base}=p;
  if(p.planId!==id||canonicalSha256(base)!==planHash) fail('IMAGE_PLAN_TAMPERED','Image plan identity/hash mismatch.');
  return p;
}
export async function saveImageJob(root:string,job:ImageJobRecord) { await writeJson(await imagePath(root,'image-jobs',job.operationId),parse(ImageJob,job)); }
export async function readImageJob(root:string,id:string,plans?:Map<string,ImagePlanRecord>) {
  const job=parse(ImageJob,await readJson(await imagePath(root,'image-jobs',id))),plan=plans?.get(job.planId)??await readImagePlan(root,job.planId);
  plans?.set(job.planId,plan);
  if(job.operationId!==id||job.projectId!==plan.projectId||job.planHash!==plan.planHash||!plan.items.some(i=>i.assetId===job.assetId&&i.fingerprint===job.fingerprint)) fail('IMAGE_JOB_CONFLICT','Image job does not belong to its frozen plan.');
  if(job.input && (canonicalSha256(job.input)!==job.requestHash||canonicalSha256({fingerprint:job.fingerprint,input:job.input})!==job.inputHash)) fail('IMAGE_JOB_CONFLICT','Image effective input hash changed.');
  return job;
}
export async function listImageJobs(root:string) {
  const directory=await projectPath(root,'.metasocli/image-jobs'); if(!await exists(directory)) return [];
  const jobs=[],plans=new Map<string,ImagePlanRecord>(); for(const file of await readdir(directory)) if(file.endsWith('.json')) jobs.push(await readImageJob(root,file.slice(0,-5),plans));
  return jobs.sort((a,b)=>a.preparedAt.localeCompare(b.preparedAt)||a.attempt-b.attempt);
}
export async function saveImageRun(root:string,run:ImageRunRecord) {
  run.updatedAt=new Date().toISOString(); const {hash:_,...base}=run; run.hash=canonicalSha256(base);
  await writeJson(await imagePath(root,'image-runs',run.planId),parse(ImageRun,run));
}
export async function readImageRun(root:string,plan:ImagePlanRecord) {
  const file=await imagePath(root,'image-runs',plan.planId);if(!await exists(file))return undefined;
  const run=parse(ImageRun,await readJson(file)),{hash,...base}=run;
  if(hash!==canonicalSha256(base)||run.planId!==plan.planId||run.planHash!==plan.planHash||run.authorization.planHash!==plan.planHash
    ||run.authorization.provider!==plan.profile.provider||run.authorization.quotaGroup!==plan.profile.quotaGroup||run.authorization.maxRequests!==plan.items.filter(i=>i.action==='generate').length
    ||run.items.length!==plan.items.length||run.items.some((i,n)=>i.assetId!==plan.items[n]!.assetId)) fail('IMAGE_RUN_TAMPERED','Image run authorization/scope changed.');
  return run;
}
export async function readBodyReceipt(root:string,job:ImageJobRecord) {
  const path=await projectPath(root,receiptFile(job.operationId,'complete.json'));if(!await exists(path))return undefined;
  const body=parse(BodyReceipt,await readJson(path)),{hash,...base}=body;
  if(body.operationId!==job.operationId||body.requestHash!==job.requestHash||hash!==canonicalSha256(base)||body.path!==receiptFile(job.operationId,'response.bin')) fail('IMAGE_RECEIPT_CONFLICT','Response completeness record does not match its request.');
  return body;
}
