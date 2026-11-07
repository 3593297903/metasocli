// Test preload only. Observe the actual built CLI without production fault switches.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import { resolve } from 'node:path';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
const append = fs.appendFileSync.bind(fs);
const audit = process.env.PROMPT_TEST_AUDIT;
function event(value) { if (audit) append(audit, JSON.stringify(value)+'\n'); }
globalThis.__promptTestEvent = event;
event({command:process.argv.slice(2)});
globalThis.fetch = async()=>{event({network:true});throw Error('Offline prompt test forbids network');};
net.Socket.prototype.connect = function(){event({network:true});throw Error('Offline prompt test forbids sockets');};
function inspect(path) {
  const value=String(path).replaceAll('\\','/');
  const story=resolve(process.argv[process.argv.indexOf('--root')+1]??'.').replaceAll('\\','/');
  // Reading the CLI's assets/credentials module source is not reading story media or a Key.
  const moduleSource=/\/(?:dist|node_modules)\/.*\.(?:m?js|cjs)$/.test(value);
  const kind=value.toLowerCase().startsWith(story.toLowerCase()+'/assets/')?'mediaRead': !moduleSource && /credentials|runtime|ledger/i.test(value)?'protectedRead':undefined;
  if(kind){event({[kind]:true,path:value});throw Error('Forbidden read during prompt replacement');}
}
for(const name of ['open','readFile']){const original=fsp[name].bind(fsp);fsp[name]=async(path,...args)=>{inspect(path);return original(path,...args);};}
for(const name of ['openSync','readFileSync','createReadStream']){const original=fs[name].bind(fs);fs[name]=(path,...args)=>{inspect(path);return original(path,...args);};}
syncBuiltinESMExports();
const stopped = new Set();
globalThis.__promptTestStop = async point => {
  if(process.env.PROMPT_TEST_STOP!==point || stopped.has(point))return;
  stopped.add(point);
  event({checkpoint:point});
  if(process.send)process.send({point});
  await new Promise(resolve=>{process.once('message',message=>{if(message==='continue')resolve();});});
};
registerHooks({load(url,context,next){
  const result=next(url,context);
  if(!url.includes('/dist/'))return result;
  let text=String(result.source);
  if(/\/(metaso|images)\/credentials\.js$/.test(url)){
    text=text.replace(/(export async function load(?:Image)?ApiKey\(options = \{\}\) \{)/g,"$1 globalThis.__promptTestEvent({keyLoad:true}); throw Error('Credential loading forbidden');");
  }
  if(url.endsWith('/core/prompt-replacement.js')){
    const anchor='const readDone = performance.now();';
    if(!text.includes(anchor))throw Error('Snapshot checkpoint anchor changed');
    text=text.replace(anchor,anchor+" await globalThis.__promptTestStop('snapshot');");
  }
  if(url.endsWith('/storage/io.js')){
    const anchor='export async function atomicWrite(target, bytes) {';
    if(!text.includes(anchor))throw Error('Atomic checkpoint anchor changed');
    text=text.replace(anchor,`export async function atomicWrite(target, bytes) {
      const name=String(target).replaceAll('\\\\','/');
      const stage=name.endsWith('/metasocli.yaml')?'manifest':name.includes('/prompt-replacements/inputs/')?'input':name.includes('/sources/')?'source':name.includes('/prompt-replacements/')?'record':undefined;
      if(stage)await globalThis.__promptTestStop(stage+'-before');
      const result=await promptTestAtomicWrite(target,bytes);
      if(stage)await globalThis.__promptTestStop(stage+'-after');
      return result;
    }
    async function promptTestAtomicWrite(target,bytes){`);
  }
  if(url.endsWith('/cli/main.js')){
    const anchor="process.stdout.write(typeof data === 'string'";
    if(!text.includes(anchor))throw Error('Output checkpoint anchor changed');
    text=text.replace(anchor,"await globalThis.__promptTestStop('stdout-before');\n    "+anchor);
  }
  return {...result,source:text};
}});
