import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
export function barrier<T=void>() { let resolve!:(value:T)=>void; const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve}; }
export async function isolationEvidence(name:string,cases:unknown[]) {
  const folder=resolve(process.env.METASO_ISOLATION_EVIDENCE_DIR??'.work/project-isolation-implementation-20261102/evidence');
  await mkdir(folder,{recursive:true});await writeFile(join(folder,name+'.json'),JSON.stringify({syntheticOnly:true,cases},null,2));
}
