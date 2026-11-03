import { performance } from 'node:perf_hooks';
import { exists, projectPath } from '../storage/paths.js';
import { readJson, writeJson } from '../storage/io.js';

export interface Timing {stage:string;startedAt:string;durationMs:number}
export class WorkflowTimer {
  readonly samples:Timing[]=[];
  async measure<T>(stage:string,work:()=>Promise<T>):Promise<T>{
    const start=performance.now(),startedAt=new Date().toISOString();
    try{return await work();}finally{this.samples.push({stage,startedAt,durationMs:performance.now()-start});}
  }
  async save(root:string,path:string){
    // Diagnostic only. Corrupt/missing timing never grants authorization or invalidates a job.
    const file=await projectPath(root,path);let prior:unknown;
    try{prior=await exists(file)?await readJson(file):undefined;}catch{/* Rebuild diagnostics only. */}
    const rows=(prior as {samples?:Timing[]}|undefined)?.samples;
    await writeJson(file,{schemaVersion:1,clock:'monotonic-duration/UTC-events',samples:[...(Array.isArray(rows)?rows:[]),...this.samples].slice(-10000)});
  }
}
