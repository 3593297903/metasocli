import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fail } from '../core/errors.js';
import { loadImageApiKey } from '../images/credentials.js';
import { TaskId } from '../metaso/client.js';
import { boundedBody, publicHttps, type Fetch } from '../metaso/transport.js';
import { sha256Hex } from '../storage/canonical.js';
import { extension, field, resolution, type Model, type Request } from './request.js';
import type { Entry } from './store.js';

const origin='https://api.yiciyuang.com';
const endpoint=origin+'/v1/videos';
const reply=z.object({id:TaskId.optional(),task_id:TaskId.optional(),model:z.string().optional(),status:z.string().optional(),
  video_url:z.string().optional(),metadata:z.object({url:z.string().optional()}).nullish(),
  error:z.union([z.string(),z.object({code:z.union([z.string(),z.number()]).optional(),message:z.string().optional()})]).nullish()});
export class ApiError extends Error {
  constructor(readonly status:number,readonly retryMs:number,readonly detail='',readonly location?:ErrorLocation,readonly invalidLocation=false){
    super('Seedance HTTP '+status+(detail?' — '+detail.slice(0,350):''));
  }
  withLocation(label:string){
    const suffix=' · '+label;
    return 'Seedance HTTP '+this.status+(this.detail?' — '+this.detail.slice(0,Math.max(0,350-suffix.length)):'')+suffix;
  }
}
const Location=z.object({param:z.string().max(100).optional(),pointer:z.string().max(100).optional(),field:z.string().max(100).optional(),
  filename:z.string().max(100).optional(),
  index:z.number().int().optional(),index_base:z.union([z.literal(0),z.literal(1)]).optional()});
type ErrorLocation=z.infer<typeof Location>;
const uploadName=(i:number,mime:keyof typeof extension)=>'ref-'+(i+1)+'.'+extension[mime];
const roleNames={reference_audio:'参考音频',reference_video:'参考视频',reference_image:'参考图',first_frame:'首帧图片',last_frame:'尾帧图片'} as const;
type Role=keyof typeof roleNames;
const roles=Object.keys(roleNames) as Role[];
function rejectedAsset(error:ApiError,entry:Entry,multipart:boolean) {
  if(error.status!==422 || !entry.request)return error.message;
  const assets=entry.request.assets, hits=new Set<number>(), categories=new Set<Role>();
  let ambiguous=error.invalidLocation;
  const locate=(role:Role,ordinal:number)=>{
    categories.add(role);
    const match=assets.map((a,i)=>a.role===role?i:-1).filter(i=>i>=0)[ordinal-1];
    if(match===undefined)ambiguous=true;else hits.add(match);
  };
  const filePosition=(name:string)=>{
    const i=Number(/^ref-([1-9]\d*)\./u.exec(name)?.[1])-1,asset=assets[i];
    if(!multipart || !asset || name!==uploadName(i,asset.mime)){ambiguous=true;return;}
    hits.add(i);categories.add(asset.role);
  };
  for(const m of error.detail.matchAll(/(?<![\w.-])ref-\d+\.[a-z0-9]+(?![\w.-])/giu))filePosition(m[0]);
  if(error.location?.filename!==undefined)filePosition(error.location.filename);
  for(const role of roles){
    const name=roleNames[role],rawField=field[role];
    if(error.detail.includes(name)||error.detail.includes(rawField)||
      (role.startsWith('reference_') && error.detail.toLowerCase().includes(role.replace('_',' '))))categories.add(role);
    for(const m of error.detail.matchAll(new RegExp('第\\s*(\\d+)\\s*(?:条|张|段|份|个)\\s*'+name,'gu')))locate(role,Number(m[1]));
  }
  const loc=error.location;
  for(const pointer of [loc?.param,loc?.pointer]){
    if(!pointer)continue;
    const parts=/^\/(referenceAudios|referenceImages|referenceVideos)\/(0|[1-9]\d*)$/u.exec(pointer);
    const role=roles.find(r=>field[r]===(parts?.[1]??pointer));
    if(role)categories.add(role);
    if(parts && role && !multipart)locate(role,Number(parts[2])+1); // JSON Pointer indices start at zero.
    else ambiguous=true;
  }
  if(loc?.field!==undefined){
    const role=roles.find(r=>field[r]===loc.field);
    if(role){categories.add(role);if(loc.index!==undefined && loc.index_base!==undefined)locate(role,loc.index-loc.index_base+1);else ambiguous=true;}
    else ambiguous=true;
  }
  if(loc && (loc.index!==undefined || loc.index_base!==undefined) && !loc.field)ambiguous=true;
  if(categories.size!==1)return error.message;
  const role=[...categories][0]!,group=roleNames[role],segment=entry.episodeId+'/'+entry.segmentId;
  if(ambiguous || hits.size!==1)return error.withLocation(segment+' · '+group);
  const i=[...hits][0]!,asset=assets[i]!,n=assets.slice(0,i+1).filter(a=>a.role===role).length;
  const unit=role==='reference_audio'?'条':role==='reference_video'?'段':'张';
  const basename=asset.path.split('/').pop()??'';
  const label=entry.bindings?.[i]?.assetId??(/^[\p{L}\p{N} _().-]{1,100}$/u.test(basename)&&!/^sk-/iu.test(basename)?basename:undefined);
  return error.withLocation(segment+' · 第 '+n+' '+unit+group+(label?' · '+label:''));
}
function diagnostic(data:unknown,key:string) {
  const result=z.union([z.string(),z.object({code:z.union([z.string(),z.number()]).optional(),message:z.string().optional()})]).safeParse(data);
  if(!result.success)return '';
  const value=result.data;
  const text=typeof value==='string'?value:[value.code,value.message].filter(x=>x!==undefined).join(' ');
  return text.replaceAll(key,'[redacted]').replace(/(?:https?:\/\/|Bearer\s+|sk-)[^\s]+/giu,'[redacted]')
    .replace(/[\u0000-\u001f\u007f]/gu,' ');
}
export function encodeRequest(r:Request,files:Blob[]) {
  const fields={model:r.model,prompt:r.prompt,duration:r.duration,ratio:r.ratio,resolution:resolution(r.model)};
  if(r.assets.every(a=>a.url)){
    const json:Record<string,unknown>={...fields};
    for(const a of r.assets){
      const name=field[a.role];
      if(a.role==='first_frame'||a.role==='last_frame')json[name]=a.url;
      else {const values=(json[name]??=[]) as string[];values.push(a.url!);}
    }
    return {body:JSON.stringify(json),type:'application/json'};
  }
  const boundary='metasocli-'+randomUUID(), parts:(string|Blob)[]=[];
  for(const [key,value] of Object.entries(fields))
    parts.push('--'+boundary+'\r\nContent-Disposition: form-data; name="'+key+'"\r\n\r\n',String(value),'\r\n');
  r.assets.forEach((a,i)=>parts.push('--'+boundary+'\r\nContent-Disposition: form-data; name="'+field[a.role]+'"; filename="'+uploadName(i,a.mime)+'"\r\nContent-Type: '+a.mime+'\r\n\r\n',files[i]!,'\r\n'));
  parts.push('--'+boundary+'--\r\n');
  return {body:new Blob(parts),type:'multipart/form-data; boundary='+boundary};
}
export class SeedClient {
  readonly credentialRef:string;
  constructor(private readonly key:string){this.credentialRef=sha256Hex('yiciyuang-video:'+key);}
  rejection(error:ApiError,item:Entry,multipart:boolean){return rejectedAsset(error,item,multipart).replaceAll(this.key,'[redacted]');}
  static async configured(){
    const key=process.env.METASOCLI_YICIYUANG_VIDEO_API_KEY || await loadImageApiKey();
    if(!/^[\x21-\x7e]+$/u.test(key))fail('CREDENTIAL_INVALID','Invalid Seedance video credential.');
    return new SeedClient(key);
  }
  private async call(url:string,init:RequestInit){
    const response=await fetch(url,{...init,headers:{...init.headers,Authorization:'Bearer '+this.key},redirect:'error',
      signal:AbortSignal.timeout(init.method==='POST'?300000:30000)});
    if(!response.ok){
      const retry=response.headers.get('retry-after');
      const ms=retry && /^\d+$/u.test(retry)?Number(retry)*1000:Math.max(0,Date.parse(retry??'')-Date.now())||0;
      let detail='',location:ErrorLocation|undefined,invalidLocation=false;
      try {
        const raw=(await boundedBody(response,16*1024)).toString('utf8').trim();
        let body;
        try{body=JSON.parse(raw);}catch{if(response.headers.get('content-type')?.startsWith('text/plain'))body=raw;}
        const error=body?.error??body;
        detail=diagnostic(error,this.key);
        if(error && typeof error==='object'){
          const position=Location.safeParse(error);
          if(position.success)location=position.data;else invalidLocation=true;
        }
      }catch{await response.body?.cancel().catch(()=>{});}
      throw new ApiError(response.status,Math.min(ms,3600000),detail,location,invalidLocation);
    }
    const data=reply.safeParse(JSON.parse((await boundedBody(response,1024*1024)).toString('utf8')));
    if(!data.success)fail('SEED_CONTRACT','Invalid video response.');
    return data.data;
  }
  async create(model:Model, payload:ReturnType<typeof encodeRequest>){
    const data=await this.call(endpoint,{method:'POST',body:payload.body,headers:{'Content-Type':payload.type}});
    const id=data.id??data.task_id;
    if(!id||(data.id&&data.task_id&&data.id!==data.task_id)||(data.model&&data.model!==model))
      fail('SEED_CONTRACT','Missing or contradictory create receipt.');
    return id;
  }
  async query(id:string,model:Model,requireIdentity=false){
    const data=await this.call(endpoint+'/'+encodeURIComponent(id),{method:'GET'});
    if((requireIdentity&&!data.id&&!data.task_id)||[data.id,data.task_id].some(value=>value!==undefined&&value!==id)||(data.model&&data.model!==model)||!data.status)
      fail('SEED_CONTRACT','Query response does not match the original task.');
    const link=data.video_url??data.metadata?.url;
    return {status:data.status,url:link?publicHttps(link):undefined,reason:diagnostic(data.error,this.key).slice(0,350)};
  }
  content(id:string){return endpoint+'/'+encodeURIComponent(id)+'/content';}
  download:Fetch=(url,init)=>{
    const headers=new Headers(init?.headers);
    if(new URL(url).origin===origin)headers.set('Authorization','Bearer '+this.key);
    return fetch(url,{...init,headers,redirect:'manual'});
  };
}
