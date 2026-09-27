import { z } from 'zod';
import { parse } from '../contracts/story.js';
import { fail } from '../core/errors.js';
import { canonicalSha256, sha256Hex } from '../storage/canonical.js';
import { projectPath, exists } from '../storage/paths.js';
import { readJson, readStable, writeJson, atomicWrite } from '../storage/io.js';
import { publicHttps, type Fetch } from '../metaso/transport.js';
import { inspectImage } from '../assets/image.js';
import { registerAsset } from '../assets/registry.js';
import { BodyReceipt, ImageJob, ImageReceipt, type ImageJobRecord, type ImagePlanRecord, type Profile } from './contracts.js';
import { receiptFile, readBodyReceipt, saveImageJob, readImageJob } from './store.js';
import { streamResponse, streamHash, type DiskBudget, type Semaphore } from './stream.js';
import { validateImagePlan } from './planning.js';
export type ImageCheckpoint=(point:string,job:ImageJobRecord)=>Promise<void>;
export interface ResultContext {budget:DiskBudget;decode:Semaphore;download:Semaphore;registration:Semaphore;fetcher?:Fetch;checkpoint?:ImageCheckpoint;onResponseChunk?:(operationId:string,bytes:number)=>void}
export async function saveImageResponse(root:string,job:ImageJobRecord,response:Response,profile:Profile,ctx:ResultContext){
  const responseHeadersAt=new Date().toISOString(),headers:Record<string,string>={};
  for(const name of ['content-type','content-length','retry-after','x-request-id','request-id']){const value=response.headers.get(name);if(value)headers[name]=value.slice(0,1024);}
  job.responseHeadersAt=responseHeadersAt;
  await ctx.checkpoint?.('response-before',job);
  await writeJson(await projectPath(root,receiptFile(job.operationId,'headers.json')),{operationId:job.operationId,requestHash:job.requestHash,httpStatus:response.status,headers,responseHeadersAt});
  const path=receiptFile(job.operationId,'response.bin'),body=await streamResponse(response,await projectPath(root,path),profile.maxResponseBytes,ctx.budget,n=>ctx.onResponseChunk?.(job.operationId,n));
  const base={schemaVersion:1 as const,operationId:job.operationId,requestHash:job.requestHash!,path,...body,httpStatus:response.status,headers,responseHeadersAt,responseSavedAt:new Date().toISOString()};
  await writeJson(await projectPath(root,receiptFile(job.operationId,'complete.json')),parse(BodyReceipt,{...base,hash:canonicalSha256(base)}));
  await ctx.checkpoint?.('response-saved',job);
  job.status='response_saved';job.responseSavedAt=base.responseSavedAt;await saveImageJob(root,job);
}
export async function saveResultBytes(root:string,job:ImageJobRecord,bytes:Buffer,profile:Profile,ctx:ResultContext){
  if(bytes.length>profile.maxImageBytes)fail('IMAGE_SIZE_LIMIT','Image exceeds its configured byte limit.');
  const info=inspectImage(bytes),[width,height]=job.input!.size.split('x').map(Number);
  if(info.width!==width||info.height!==height)fail('IMAGE_SIZE_MISMATCH',`Output dimensions differ from requested size for ${job.assetId}.`);
  const ext=info.mime==='image/png'?'png':info.mime==='image/jpeg'?'jpg':'webp',path=`.metasocli/drafts/assets/${job.operationId}/${job.assetId}.${ext}`;
  const result={...info,path,sha256:sha256Hex(bytes),bytes:bytes.length};
  const file=await projectPath(root,path);if(await exists(file)){if((await streamHash(file,profile.maxImageBytes)).sha256!==result.sha256)fail('IMAGE_RESULT_CONFLICT','A different staged result exists.');}
  else{ctx.budget.charge(bytes.length);await atomicWrite(file,bytes);}
  await writeJson(await projectPath(root,receiptFile(job.operationId,'result.json')),result);
  return result;
}
async function restoreResult(root:string,job:ImageJobRecord,profile:Profile){const file=await projectPath(root,receiptFile(job.operationId,'result.json'));if(!await exists(file))return undefined;
  const result=parse(ImageJob.shape.result.unwrap(),await readJson(file));
  if(!result.path.startsWith(`.metasocli/drafts/assets/${job.operationId}/${job.assetId}.`))fail('IMAGE_RESULT_CONFLICT','Result belongs to a different operation.');
  const bytes=await readStable(await projectPath(root,result.path),profile.maxImageBytes),info=inspectImage(bytes);
  if(sha256Hex(bytes)!==result.sha256||bytes.length!==result.bytes||info.width!==result.width||info.height!==result.height||info.mime!==result.mime)fail('IMAGE_RESULT_CONFLICT','Stored image bytes/metadata changed.');return result;
}
/** Parses only complete, request-bound responses. No remote creation is possible in this module. */
export async function receiveImage(root:string,job:ImageJobRecord,profile:Profile,ctx:ResultContext){
  const body=await readBodyReceipt(root,job);if(!body)fail('IMAGE_SUBMIT_UNKNOWN','No complete response; the original request must not be resent.');
  return ctx.decode.use(async()=>{
    const raw=await readStable(await projectPath(root,body.path),profile.maxResponseBytes);
    if(raw.length!==body.bytes||sha256Hex(raw)!==body.sha256)fail('IMAGE_RECEIPT_CONFLICT','Complete response bytes changed.');
    job.responseHeadersAt=body.responseHeadersAt;job.responseSavedAt=body.responseSavedAt;
    if([401,402,403,429].includes(body.httpStatus)){job.status='rejected';job.error={code:'IMAGE_CREATE_REJECTED',message:`Image provider returned HTTP ${body.httpStatus}; no automatic POST retry.`};await saveImageJob(root,job);return;}
    if(body.httpStatus<200||body.httpStatus>=300)fail('IMAGE_SUBMIT_UNKNOWN',`Image HTTP ${body.httpStatus} does not prove creation was rejected.`);
    let value:unknown;try{value=JSON.parse(raw.toString('utf8'));}catch{return fail('IMAGE_RESPONSE_CONTRACT','Complete response is not valid JSON; preserve it without resubmitting.');}
    const contract=z.object({data:z.array(z.object({url:z.string().optional(),b64_json:z.string().optional(),revised_prompt:z.string().optional()}).passthrough()).length(1),model:z.string().max(200).optional(),usage:z.unknown().optional()}).passthrough().safeParse(value);
    if(!contract.success)fail('IMAGE_RESPONSE_CONTRACT','Expected one identifiable image result; preserve the full response.');
    const parsed=contract.data,image=parsed.data[0]!;
    if(parsed.usage!==undefined&&Buffer.byteLength(JSON.stringify(parsed.usage))>16384)fail('IMAGE_RESPONSE_CONTRACT','Usage metadata exceeds 16 KiB; the complete original response is preserved.');
    if(image.revised_prompt!==undefined&&Buffer.byteLength(image.revised_prompt)>128000)fail('IMAGE_RESPONSE_CONTRACT','Revised prompt metadata exceeds 128000 bytes; the original prompt is unchanged and full response is preserved.');
    if(Boolean(image.url)===Boolean(image.b64_json))fail('IMAGE_RESPONSE_CONTRACT','Expected exactly one URL or Base64 image.');
    let result=await restoreResult(root,job,profile);
    if(image.b64_json&&!result){const b64=image.b64_json;
      if(b64.length>Math.ceil(profile.maxImageBytes/3)*4||b64.length%4||!/^[A-Za-z0-9+/]*={0,2}$/u.test(b64))fail('IMAGE_RESPONSE_CONTRACT','Invalid or oversized Base64 image.');
      const bytes=Buffer.from(b64,'base64');if(bytes.toString('base64')!==b64)fail('IMAGE_RESPONSE_CONTRACT','Base64 does not round trip.');result=await saveResultBytes(root,job,bytes,profile,ctx);
    }
    let revisedPromptPath:string|undefined;
    if(image.revised_prompt!==undefined){revisedPromptPath=receiptFile(job.operationId,'revised-prompt.txt');const file=await projectPath(root,revisedPromptPath);if(!await exists(file))ctx.budget.charge(Buffer.byteLength(image.revised_prompt));await atomicWrite(file,image.revised_prompt);}
    const receipt=parse(ImageReceipt,{operationId:job.operationId,requestHash:job.requestHash,bodyHash:body.sha256,receiptSavedAt:new Date().toISOString(),
      ...(image.url?{url:publicHttps(image.url)}:{}),...(result?{result}:{}),requestedModel:job.input!.model,...(parsed.model?{reportedModel:parsed.model}:{}),
      ...(revisedPromptPath?{revisedPromptPath}:{}),...(parsed.usage===undefined?{}:{usage:parsed.usage})});
    await writeJson(await projectPath(root,receiptFile(job.operationId,'receipt.json')),receipt);await ctx.checkpoint?.('receipt-saved',job);
    job.receiptSavedAt=receipt.receiptSavedAt;job.status=result?'downloaded':'received';if(result){job.result=result;job.downloadCompletedAt=new Date().toISOString();}
    delete job.error;await saveImageJob(root,job);
  });
}
export async function downloadImageResult(root:string,job:ImageJobRecord,profile:Profile,ctx:ResultContext){return ctx.download.use(async()=>{
  const receipt=parse(ImageReceipt,await readJson(await projectPath(root,receiptFile(job.operationId,'receipt.json'))));
  if(receipt.operationId!==job.operationId||receipt.requestHash!==job.requestHash)fail('IMAGE_RECEIPT_CONFLICT','Image receipt identity changed.');
  let result=await ctx.decode.use(()=>restoreResult(root,job,profile));
  if(!result){if(!receipt.url)fail('IMAGE_RESULT_MISSING','No recoverable local image or saved URL.');
    const path=await projectPath(root,receiptFile(job.operationId,'download.bin'));await ctx.checkpoint?.('download-before',job);
    if(!await exists(path)){
      let response:Response;try{response=await(ctx.fetcher??fetch)(publicHttps(receipt.url),{redirect:'error',signal:AbortSignal.timeout(30000)});}catch{return fail('IMAGE_DOWNLOAD_FAILED','Image download failed; recover the saved result URL, never regenerate.');}
      if(!response.ok)fail('IMAGE_DOWNLOAD_FAILED',`Image URL returned HTTP ${response.status}; restore its source without generating again.`);
      await streamResponse(response,path,profile.maxImageBytes,ctx.budget);
    }
    result=await ctx.decode.use(async()=>saveResultBytes(root,job,await readStable(path,profile.maxImageBytes),profile,ctx));
  }
  await ctx.checkpoint?.('download-saved',job);job.result=result;job.status='downloaded';job.downloadCompletedAt??=new Date().toISOString();delete job.error;await saveImageJob(root,job);
});}
export async function registerImageResult(root:string,job:ImageJobRecord,plan:ImagePlanRecord,ctx:ResultContext){return ctx.registration.use(async()=>{
  if(!job.result)fail('IMAGE_RESULT_MISSING','The returned image must be saved before registration.');
  const item=plan.items.find(i=>i.assetId===job.assetId)!;
  await ctx.checkpoint?.('register-before',job);
  await registerAsset(root,job.assetId,{file:await projectPath(root,job.result.path),provenance:'imagegen',expectedSha256:job.result.sha256},undefined,async(story,asset)=>{
    await validateImagePlan(root,plan,story,item);
    const current=await readImageJob(root,job.operationId);if(current.inputHash!==job.inputHash||current.fingerprint!==job.fingerprint)fail('IMAGE_JOB_CONFLICT','Image registration owner changed.');
    for(const dep of job.input?.references??[]){const media=story.assets.find(a=>a.recipe.assetId===dep.assetId)?.media;
      if(!media||media.sha256!==dep.sha256||(await streamHash(await projectPath(root,media.path),plan.profile.maxImageBytes)).sha256!==dep.sha256)fail('IMAGE_DEPENDENCY_CHANGED',`Returned image has obsolete dependency ${dep.assetId}.`);}
    if(asset.media?.sha256===job.result!.sha256)return 'preserve';
    if((asset.media?.sha256??null)!==item.targetHash)fail('IMAGE_TARGET_CHANGED','User-selected target changed; preserve the generated result without replacing the new selection.');
  });
  await ctx.checkpoint?.('register-saved',job);job.status='registered';job.registeredAt??=new Date().toISOString();delete job.error;await saveImageJob(root,job);
  const jobPath=`.metasocli/image-jobs/${job.operationId}.json`,receiptPath=receiptFile(job.operationId,'receipt.json');
  const receipt=await exists(await projectPath(root,receiptPath))?parse(ImageReceipt,await readJson(await projectPath(root,receiptPath))):undefined;
  await writeJson(await projectPath(root,receiptFile(job.operationId,'execution.json')),{schemaVersion:1,operationId:job.operationId,assetId:job.assetId,provider:'yiciyuang',
    requestedModel:job.input!.model,reportedModel:receipt?.reportedModel??null,requestedSize:job.input!.size,width:job.result.width,height:job.result.height,
    planId:job.planId,planHash:job.planHash,requestHash:job.requestHash,inputHash:job.inputHash,jobPath,jobSha256:sha256Hex(await readStable(await projectPath(root,jobPath))),
    receiptPath:receipt?receiptPath:null,receiptSha256:receipt?sha256Hex(await readStable(await projectPath(root,receiptPath))):null,recoveredManually:job.recoveredManually??false});
});}
