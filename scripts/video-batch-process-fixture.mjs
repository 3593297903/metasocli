import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initializeStory,importStory } from '../dist/core/project.js';
import { createBatchPlan } from '../dist/jobs/batch-store.js';
import { sha256Hex } from '../dist/storage/canonical.js';
export const evidence={sha256:sha256Hex('{}'),response:{}};
export async function makeBatch(base,name,count=1){
  const root=join(base,name),source=join(base,name+'.txt');
  const lines=Array.from({length:count},(_,i)=>'完整段落 '+i+'。\n');await writeFile(source,lines.join(''));await initializeStory(root,name);
  let start=0;const segments=lines.map((line,i)=>{const s={id:'s'+(i+1),start,end:start+line.length,duration:6.963};start+=line.length;return s;});
  await importStory(root,{episodeId:'ep-1',kind:'video-prompts',source,segments});
  const batch=await createBatchPlan(root,{episodes:['ep-1']});return {root,batchId:batch.plan.batchId,planId:batch.plan.items[0].planId};
}
export function fakeMp4(){
  const box=(name,body)=>{const h=Buffer.alloc(8);h.writeUInt32BE(body.length+8);h.write(name,4);return Buffer.concat([h,body]);};
  const mvhd=Buffer.alloc(100);mvhd.writeUInt32BE(1000,12);mvhd.writeUInt32BE(7000,16);
  const tkhd=Buffer.alloc(84);tkhd.writeUInt32BE(768*65536,76);tkhd.writeUInt32BE(1366*65536,80);
  const hdlr=Buffer.alloc(24);hdlr.write('vide',8);
  return Buffer.concat([box('ftyp',Buffer.from('isom\0\0\0\0isom')),box('moov',Buffer.concat([box('mvhd',mvhd),box('trak',Buffer.concat([box('tkhd',tkhd),box('mdia',box('hdlr',hdlr))]))])),box('mdat',Buffer.alloc(64,1))]);
}
