import { openAsBlob } from 'node:fs';
import { fail } from '../core/errors.js';
import { projectPath } from '../storage/paths.js';
import { readStable } from '../storage/io.js';
import { sha256Hex } from '../storage/canonical.js';
import type { Fetch } from '../metaso/transport.js';
import { IMAGE_ORIGIN, type EffectiveInput, type Profile } from './contracts.js';
import { streamHash } from './stream.js';

export interface ImageClient { prepare?():Promise<void>;create(root:string,input:EffectiveInput,profile:Profile):Promise<Response> }
export class YicImageClient implements ImageClient {
  constructor(private readonly key:string,private readonly fetcher:Fetch=fetch) {
    if(!/^[\x21-\x7e]{1,4096}$/u.test(key))fail('IMAGE_KEY_INVALID','Image API key must be a token without whitespace.');
  }
  async create(root:string,input:EffectiveInput,profile:Profile):Promise<Response> {
    if(input.origin!==IMAGE_ORIGIN||profile.origin!==IMAGE_ORIGIN||input.model!=='gpt-image-2.5')fail('IMAGE_ORIGIN','Image credential is restricted to its approved API origin/model.');
    const prompt=(await readStable(await projectPath(root,input.promptPath),128000)).toString('utf8');
    if(sha256Hex(prompt)!==input.promptHash)fail('IMAGE_INPUT_CHANGED','Image prompt snapshot changed.');
    const fields={model:input.model,prompt,quality:input.quality,size:input.size,n:1,response_format:input.response_format};
    let body:BodyInit,headers:Record<string,string>={Authorization:`Bearer ${this.key}`};
    if(!input.references.length){body=JSON.stringify(fields);headers['Content-Type']='application/json';}
    else {
      const form=new FormData();for(const [key,value]of Object.entries(fields))form.append(key,String(value));
      for(const reference of input.references){const file=await projectPath(root,reference.path);
        if((await streamHash(file,profile.maxImageBytes)).sha256!==reference.sha256)fail('IMAGE_INPUT_CHANGED','Image reference snapshot changed.');
        form.append(input.references.length===1?'image':'images',await openAsBlob(file,{type:reference.mime}),reference.assetId+({ 'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp'}[reference.mime]));
      }
      body=form; // Native FormData supplies the boundary; file-backed Blobs avoid N large buffers.
    }
    try {return await this.fetcher(IMAGE_ORIGIN+input.route,{method:'POST',headers,body,redirect:'error',signal:AbortSignal.timeout(profile.generationTimeoutMs)});}
    catch {return fail('IMAGE_TRANSPORT_UNKNOWN','Image request did not yield a complete response. Preserve the original operation; do not resend.');}
  }
}
