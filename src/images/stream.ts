import { createHash, randomUUID } from 'node:crypto';
import { open, mkdir, rename, statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fail } from '../core/errors.js';
import { exists, safePath } from '../storage/paths.js';
import { syncDirectory } from '../storage/io.js';

export class Semaphore {
  private active=0;private waiting:Array<()=>void>=[];
  constructor(private readonly limit:number){}
  async use<T>(work:()=>Promise<T>):Promise<T>{if(this.active>=this.limit)await new Promise<void>(r=>this.waiting.push(r));else this.active++;
    try{return await work();}finally{const next=this.waiting.shift();if(next)next();else this.active--;}}
}
export class DiskBudget {constructor(readonly limit:number,public used=0){} charge(bytes:number){if(bytes>this.limit-this.used)fail('IMAGE_STORAGE_LIMIT','Image temporary storage budget exceeded; preserve complete results.');this.used+=bytes;} }
export async function preflightSpace(root:string,required:number,limit:number){const stat=await statfs(root);if(required>limit||required>Number(stat.bavail)*Number(stat.bsize))fail('IMAGE_STORAGE_LIMIT','Insufficient conservative disk budget for this image scope.');}
export async function streamHash(file:string,limit:number){await safePath(file);const handle=await open(file,'r'),digest=createHash('sha256');let bytes=0;
  try {const before=await handle.stat({bigint:true});if(!before.isFile()||before.nlink!==1n)fail('LINK_PATH','Image record must be a regular unlinked file.');
    for(;;){const buffer=Buffer.alloc(65536),read=await handle.read(buffer);if(!read.bytesRead)break;bytes+=read.bytesRead;if(bytes>limit)fail('IMAGE_SIZE_LIMIT','Image file exceeds its bound.');digest.update(buffer.subarray(0,read.bytesRead));}
    const after=await handle.stat({bigint:true});if(before.ino!==after.ino||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs||after.size!==BigInt(bytes))fail('FILE_CHANGED','Image file changed during hashing.');
    return {sha256:digest.digest('hex'),bytes};
  }finally{await handle.close();}}
/** Each response streams immediately to its own file; parsing/download semaphores are downstream. */
export async function streamResponse(response:Response,target:string,limit:number,budget:DiskBudget,onChunk?:(bytes:number)=>void){
  const declared=response.headers.get('content-length');if(declared&&(!/^\d+$/u.test(declared)||Number(declared)>limit))fail('IMAGE_RESPONSE_LIMIT','Response exceeds the independent image byte limit.');
  if(!response.body)fail('IMAGE_EMPTY_RESPONSE','Image response has no body.');await safePath(target);await mkdir(dirname(target),{recursive:true});await safePath(target);
  if(await exists(target))fail('IMAGE_RESULT_EXISTS','Preserve the existing image response/result instead of overwriting it.');
  const partial=target+'.part-'+randomUUID(),handle=await open(partial,'wx',0o600),reader=response.body.getReader(),hash=createHash('sha256');let bytes=0;
  try{for(;;){const item=await reader.read();if(item.done)break;bytes+=item.value.length;if(bytes>limit)fail('IMAGE_RESPONSE_LIMIT','Image response grew beyond its limit.');budget.charge(item.value.length);
      await handle.writeFile(item.value);hash.update(item.value);onChunk?.(item.value.length);}
    if(declared&&!response.headers.get('content-encoding')&&Number(declared)!==bytes)fail('IMAGE_TRUNCATED','Incomplete image transfer.');
    await handle.sync();await handle.close();await safePath(target);await rename(partial,target);await syncDirectory(dirname(target));return {bytes,sha256:hash.digest('hex')};
  }finally{await handle.close();await reader.cancel().catch(()=>{});reader.releaseLock();} // Keep incomplete files as evidence; never treat them as complete.
}
