import { join } from 'node:path';
import { z } from 'zod';
import { parse } from '../contracts/story.js';
import { runtimeDirectory } from '../jobs/coordinator.js';
import { readJson,writeJson } from '../storage/io.js';
import { exists,safePath,samePath } from '../storage/paths.js';
import { liveProjectLease, waitLease } from '../storage/locking.js';
import { seedOperation } from './store.js';

const Slots=z.array(z.object({operation:z.uuid(),root:z.string()}).strict());
type Slot = z.infer<typeof Slots>[number];
async function stillHeld(slot:Slot) {
  try {
    const job=await seedOperation(slot.root,slot.operation);
    if(!job)return false;
    if(job.status==='prepared'||job.status==='submitting')
      return !!await liveProjectLease(slot.root,'.metasocli/seedance/locks/'+job.requestHash+'.lock');
    return (job.status==='queued'||job.status==='running') && !job.lastError;
  }catch{return false;} // The story can move; this only releases a local reservation.
}
/** One local installation pool across stories and resolutions, independent of the remote task record. */
export async function capacity(root:string,runtime:string|undefined,operation:string,limit:number,action:'claim'|'restore'|'release'){
  const dir=join(runtimeDirectory(runtime),'seedance'),file=await safePath(join(dir,'slots.json'));
  const lock=await waitLease(await safePath(join(dir,'slots.lock')));
  try{
    let slots=await exists(file)?parse(Slots,await readJson(file)):[];
    const mine=slots.findIndex(s=>samePath(s.root,root)&&s.operation===operation);
    if(action!=='release'){
      if(mine>=0)return true;
      if(action==='claim'&&slots.length>=limit){
        const held=await Promise.all(slots.map(stillHeld));
        const remaining=slots.filter((_,i)=>held[i]);
        if(remaining.length!==slots.length)await writeJson(file,remaining);
        slots=remaining;
        if(slots.length>=limit)return false;
      }
      slots.push({operation,root});
    }else{
      if(mine<0)return true;
      slots.splice(mine,1);
    }
    await lock.assertOwned();await writeJson(file,slots);return true;
  }finally{await lock.release();}
}
