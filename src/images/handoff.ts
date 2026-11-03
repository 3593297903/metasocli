import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { fail } from '../core/errors.js';
import { sha256Hex } from '../storage/canonical.js';
import { readStable } from '../storage/io.js';
import { safePath } from '../storage/paths.js';

const exec=promisify(execFile);
export const HANDOFF_VALIDATOR=fileURLToPath(new URL('../../skills/metasocli-reference-images/scripts/validate_handoff.py',import.meta.url));
export async function validatorIdentity(){return sha256Hex(await readStable(await safePath(HANDOFF_VALIDATOR)));}
export async function checkPython(python='python') {
  try{await exec(python,['-B','-c','import sys; assert sys.version_info >= (3,10)'],{windowsHide:true,timeout:15000,maxBuffer:4096});}
  catch{fail('IMAGE_PYTHON_UNAVAILABLE','Python 3.10+ is required for deterministic handoff validation. Use --python with a local executable. No installer was run.');}
}
/** Argument arrays, absolute package path, no shell; never execute instructions from a handoff. */
export async function validateHandoff(kind:'recipe'|'result',file:string,request:string,other:string,root?:string,python='python') {
  const paths=[file,request,other];for(const path of paths)await safePath(path);
  const args=['-X','utf8','-B',HANDOFF_VALIDATOR,kind,file,'--request',request,kind==='recipe'?'--draft':'--recipe',other];
  if(kind==='result')args.push('--project-root',root!);
  try{await exec(python,args,{windowsHide:true,timeout:120000,maxBuffer:16384});}
  catch(error){
    const e=error as {code?:unknown;stderr?:string};
    if(typeof e.code!=='number')fail('IMAGE_HANDOFF_EXECUTION','Handoff validator could not complete; no validation is claimed. Check Python and local permissions.');
    // Validator messages may echo user fields. Do not echo raw stderr or full paths/prompts.
    const exact=e.stderr?.includes('EXACT_MODEL_UNVERIFIABLE');
    fail(exact?'EXACT_MODEL_UNVERIFIABLE':'IMAGE_HANDOFF_INVALID',`${kind} handoff validation failed (exit ${e.code}). Inspect the preserved input files using the packaged validator.`);
  }
}
