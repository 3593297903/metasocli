// Offline tests only: inject the existing CLI dependency seam, forbid real sockets,
// credentials and production runtime reads. Never imported by the shipped CLI.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fakeMp4, evidence } from './video-batch-process-fixture.mjs';
const append=fs.appendFileSync.bind(fs),audit=process.env.VIDEO_RUN_AUDIT;
function event(value){if(audit)append(audit,JSON.stringify(value)+'\n');}
event({command:process.argv.slice(2)});
globalThis.fetch=async()=>{throw Error('Offline: fetch forbidden');};
net.Socket.prototype.connect=function(){throw Error('Offline: sockets forbidden');};
const local=process.env.VIDEO_RUN_LOCAL==='1',runtime=process.env.METASO_RUNTIME_DIR;
function inspect(path){
  const value=String(path).replaceAll('\\','/'),moduleSource=/\/(?:dist|node_modules)\/.*\.(?:m?js|cjs)$/.test(value);
  if(!moduleSource && (/credentials/i.test(value)||value.includes('.metasocli-runtime')||(local&&runtime&&value.toLowerCase().startsWith(resolve(runtime).replaceAll('\\','/').toLowerCase())))){
    event({forbiddenRead:value});throw Error('Unexpected runtime/credential read');
  }
}
for(const name of ['open','readFile']){const original=fsp[name].bind(fsp);fsp[name]=async(path,...args)=>{inspect(path);return original(path,...args);};}
for(const name of ['openSync','readFileSync']){const original=fs[name].bind(fs);fs[name]=(path,...args)=>{inspect(path);return original(path,...args);};}
syncBuiltinESMExports();
process.env=new Proxy(process.env,{get(target,key){if(['METASO_API_KEY','METASOCLI_IMAGE_API_KEY'].includes(key))throw Error('Unexpected Key environment read');return Reflect.get(target,key);}});
const stop=()=>{throw Error('Unexpected local network adapter invocation');};
globalThis.__videoRunTestDeps={runtimeRoot:runtime,client:{
  async prepare(){if(local)stop();},
  async create(request){if(local)stop();event({post:true,request});return {taskId:randomUUID(),evidence};},
  async query(taskId){if(local)stop();event({query:taskId});return {taskId,status:'generated',rawStatus:'succeeded',duration:7,url:'https://example.test/fake.mp4',evidence};}},
  fetcher:async()=>{if(local)stop();event({download:true});return new Response(fakeMp4());}};
registerHooks({load(url,context,next){const result=next(url,context);if(!url.endsWith('/dist/cli/main.js'))return result;
  const anchor='const result = await runCli(args);';if(!String(result.source).includes(anchor))throw Error('CLI dependency seam changed');
  return {...result,source:String(result.source).replace(anchor,'const result = await runCli(args, globalThis.__videoRunTestDeps);')};
}});
