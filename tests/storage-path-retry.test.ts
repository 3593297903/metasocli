import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { safePath, projectPath } from '../src/storage/paths.js';
import { acquireLease, liveLease, waitLease } from '../src/storage/locking.js';
import { readStable } from '../src/storage/io.js';

vi.mock('node:fs/promises',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:fs/promises')>();
  return {...actual,realpath:vi.fn(actual.realpath),lstat:vi.fn(actual.lstat),unlink:vi.fn(actual.unlink),open:vi.fn(actual.open)};
});

const actual=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const roots:string[]=[];
const originalPlatform=Object.getOwnPropertyDescriptor(process,'platform')!;
let delays:number[]=[];
beforeEach(()=>{
  for(const name of ['realpath','lstat','unlink','open'] as const)vi.mocked(fs[name]).mockReset().mockImplementation(actual[name] as never);
  delays=[];
  // Assert requested budgets, without depending on Windows millisecond scheduling.
  vi.spyOn(globalThis,'setTimeout').mockImplementation(((fn:(...args:unknown[])=>void,ms:number,...args:unknown[])=>{
    delays.push(ms);queueMicrotask(()=>fn(...args));return 0;
  }) as typeof setTimeout);
});
afterEach(async()=>{
  Object.defineProperty(process,'platform',originalPlatform);vi.restoreAllMocks();
  for(const root of roots.splice(0))await actual.rm(root,{recursive:true,force:true});
});
async function fixture(){const root=await actual.mkdtemp(join(tmpdir(),'metasocli-path-retry-'));roots.push(root);const file=join(root,'lease.lock');return {root,file};}
const denied=(path:string,code='EPERM',syscall='realpath')=>Object.assign(new Error(`${code}: injected ${syscall} '${path}'`),{code,syscall,path,errno:-4048,cause:{origin:'deterministic local fault'}});
function faults(file:string,errors:(Error|(()=>Promise<never>))[]){
  let calls=0;
  vi.mocked(fs.realpath).mockImplementation((async(path,...args)=>{
    if(String(path)===file){const error=errors[calls++];if(error){if(typeof error==='function')return error();throw error;}}
    return actual.realpath(path,...args as []);
  }) as typeof fs.realpath);
  return ()=>calls;
}
const count=(file:string)=>vi.mocked(fs.realpath).mock.calls.filter(([p])=>String(p)===file).length;

for(const entry of ['safePath','projectPath','liveLease','assertOwned'] as const)test(`transient leaf EPERM: ${entry} rechecks full ancestors and retains the real owner`,async()=>{
  const {root,file}=await fixture(),lease=await acquireLease(file);const bytes=await actual.readFile(file),error=denied(file);
  const calls=faults(file,[error]);vi.mocked(fs.realpath).mockClear();
  try{
    if(entry==='safePath')expect(await safePath(file)).toBe(file);
    if(entry==='projectPath')expect(await projectPath(root,'lease.lock')).toBe(file);
    if(entry==='liveLease')expect(await liveLease(file)).toMatchObject({token:lease.token,pid:process.pid,host:hostname()});
    if(entry==='assertOwned')await lease.assertOwned();
    expect(calls()).toBe(2);expect(count(root)).toBe(2);expect(delays).toEqual([25]);
    expect(await actual.readFile(file)).toEqual(bytes);expect(fs.unlink).not.toHaveBeenCalled();
  }finally{vi.mocked(fs.realpath).mockImplementation(actual.realpath);await lease.release();}
});
test('four transient EPERMs succeed on attempt five with exactly 100ms requested wait',async()=>{
  const {root,file}=await fixture();await actual.writeFile(file,'unchanged');const calls=faults(file,Array.from({length:4},()=>denied(file)));
  expect(await safePath(file)).toBe(file);expect(calls()).toBe(5);expect(count(root)).toBe(5);expect(delays).toEqual([25,25,25,25]);
});
test('persistent EPERM fails on attempt five with original diagnostics and no writes/deletes',async()=>{
  const {file}=await fixture(),lease=await acquireLease(file),bytes=await actual.readFile(file),error=denied(file);
  const calls=faults(file,Array(6).fill(error));vi.mocked(fs.open).mockClear();vi.mocked(fs.unlink).mockClear();
  try{await expect(liveLease(file)).rejects.toBe(error);expect(error).toMatchObject({code:'EPERM',syscall:'realpath',path:file,cause:{origin:'deterministic local fault'}});
    expect(calls()).toBe(5);expect(delays).toEqual([25,25,25,25]);expect(fs.open).not.toHaveBeenCalled();expect(fs.unlink).not.toHaveBeenCalled();expect(await actual.readFile(file)).toEqual(bytes);
  }finally{vi.mocked(fs.realpath).mockImplementation(actual.realpath);await lease.release();}
});
test('EPERM and PATH_CHANGED share five total attempts instead of resetting each other',async()=>{
  const {root,file}=await fixture();await actual.writeFile(file,'x');const last=denied(file);
  const calls=faults(file,[denied(file),denied(file,'ENOENT'),denied(file),denied(file,'ENOENT'),last,denied(file)]);
  await expect(safePath(file)).rejects.toBe(last);expect(calls()).toBe(5);expect(count(root)).toBe(5);expect(delays).toEqual([25,5,25,5]);
});
test('ordinary validation adds neither wait nor repeat',async()=>{
  const {root,file}=await fixture();await actual.writeFile(file,'normal');expect(await safePath(file)).toBe(file);expect(count(root)).toBe(1);expect(count(file)).toBe(1);expect(delays).toEqual([]);
});
for(const code of ['EACCES','EBUSY'])test(`other realpath error ${code} is not retried`,async()=>{
  const {file}=await fixture();await actual.writeFile(file,'x');const error=denied(file,code),calls=faults(file,[error]);
  await expect(safePath(file)).rejects.toBe(error);expect(calls()).toBe(1);expect(delays).toEqual([]);
});
test('non-Windows EPERM is not retried',async()=>{
  const {file}=await fixture();await actual.writeFile(file,'x');Object.defineProperty(process,'platform',{...originalPlatform,value:'linux'});const error=denied(file),calls=faults(file,[error]);
  await expect(safePath(file)).rejects.toBe(error);expect(calls()).toBe(1);expect(delays).toEqual([]);
});
test('ancestor directory EPERM is not retried',async()=>{
  const {root,file}=await fixture();await actual.writeFile(file,'x');const error=denied(root),calls=faults(root,[error]);
  await expect(safePath(file)).rejects.toBe(error);expect(calls()).toBe(1);expect(count(file)).toBe(0);expect(delays).toEqual([]);
});
test('leaf directory EPERM is not retried',async()=>{
  const {root}=await fixture(),error=denied(root),calls=faults(root,[error]);await expect(safePath(root)).rejects.toBe(error);expect(calls()).toBe(1);expect(delays).toEqual([]);
});
test('lstat EPERM is not caught by the realpath-only branch',async()=>{
  const {file}=await fixture();await actual.writeFile(file,'x');const error=denied(file,'EPERM','lstat');
  vi.mocked(fs.lstat).mockImplementation((async(path,...args)=>{if(String(path)===file)throw error;return actual.lstat(path,...args as []);}) as typeof fs.lstat);
  await expect(safePath(file)).rejects.toBe(error);expect(count(file)).toBe(0);expect(delays).toEqual([]);
});
for(const identity of [{ino:0n},{ino:1},{dev:1n<<65n}])test(`unusable bigint identity ${String(identity.ino??identity.dev)} cannot enable a retry`,async()=>{
  const {file}=await fixture();await actual.writeFile(file,'x');const error=denied(file),calls=faults(file,[error]);
  vi.mocked(fs.lstat).mockImplementation((async(path,...args)=>{const info=await actual.lstat(path,...args as []);return String(path)===file?Object.assign(Object.create(info),identity):info;}) as typeof fs.lstat);
  await expect(safePath(file)).rejects.toBe(error);expect(calls()).toBe(1);expect(delays).toEqual([]);
});
test('a multiply linked leaf cannot enable an EPERM retry',async()=>{
  const {root,file}=await fixture();await actual.writeFile(file,'x');await actual.link(file,join(root,'alias'));const error=denied(file),calls=faults(file,[error]);
  await expect(safePath(file)).rejects.toBe(error);expect(calls()).toBe(1);expect(delays).toEqual([]);
});
test('actual disappearance on recheck returns no owner without observer deletion',async()=>{
  const {file}=await fixture(),lease=await acquireLease(file);
  faults(file,[async()=>{await actual.unlink(file);throw denied(file);}]);vi.mocked(fs.unlink).mockClear();
  expect(await liveLease(file)).toBeUndefined();expect(delays).toEqual([25]);expect(fs.unlink).not.toHaveBeenCalled();await lease.release();
});
test('replacement owner is freshly read; original lease cannot assert or remove it',async()=>{
  const {file}=await fixture(),lease=await acquireLease(file),replacement={token:randomUUID(),pid:process.pid,host:hostname(),createdAt:new Date().toISOString()};
  faults(file,[async()=>{await actual.writeFile(file,JSON.stringify(replacement));throw denied(file);}]);
  expect(await liveLease(file)).toEqual(replacement);await expect(lease.assertOwned()).rejects.toMatchObject({code:'LOCK_LOST'});await lease.release();
  expect(JSON.parse(await actual.readFile(file,'utf8'))).toEqual(replacement);expect(fs.unlink).not.toHaveBeenCalled();
});
for(const kind of ['symlink','junction','hardlink','protected-parent'] as const)test(`recheck rejects ${kind} replacement and leaves external bytes unchanged`,async()=>{
  const {root,file}=await fixture(),outside=await fixture(),external=outside.file;await actual.writeFile(file,'lock');await actual.writeFile(external,'external immutable');
  faults(file,[async()=>{
    if(kind==='protected-parent')await actual.writeFile(join(root,'story2libtv.yaml'),'protected');
    else{await actual.unlink(file);if(kind==='hardlink')await actual.link(external,file);else await actual.symlink(kind==='junction'?outside.root:external,file,kind==='junction'?'junction':'file');}
    throw denied(file);
  }]);
  await expect(safePath(file)).rejects.toMatchObject({code:kind==='protected-parent'?'LEGACY_ROOT':'LINK_PATH'});
  expect(delays).toEqual([25]);expect(await actual.readFile(external,'utf8')).toBe('external immutable');expect(fs.unlink).not.toHaveBeenCalled();
});
test('live holder still blocks acquisition after transient recheck; no contender side effects',async()=>{
  const {file}=await fixture(),lease=await acquireLease(file),before=await actual.readFile(file);faults(file,[denied(file)]);
  try{await expect(waitLease(file,0)).rejects.toMatchObject({code:'LOCK_BUSY'});expect(await actual.readFile(file)).toEqual(before);expect(fs.unlink).not.toHaveBeenCalled();await lease.assertOwned();}
  finally{await lease.release();}
});
test('dead same-host owner follows the existing recovery gate and new token rules',async()=>{
  const {file}=await fixture(),pid=2147483647,old={token:randomUUID(),pid,host:hostname(),createdAt:new Date().toISOString()};await actual.writeFile(file,JSON.stringify(old));
  const kill=process.kill.bind(process);vi.spyOn(process,'kill').mockImplementation(((target,...args)=>{if(target===pid)throw Object.assign(new Error('test dead PID'),{code:'ESRCH'});return kill(target,...args);}) as typeof process.kill);
  faults(file,[denied(file)]);const lease=await acquireLease(file);expect(lease.token).not.toBe(old.token);await lease.assertOwned();await lease.release();
  await expect(actual.lstat(file)).rejects.toMatchObject({code:'ENOENT'});
});
test('recovery gate and foreign/uncertain owners cannot be taken over',async()=>{
  const {file}=await fixture(),record={token:randomUUID(),pid:2147483647,host:'foreign-host',createdAt:new Date().toISOString()};await actual.writeFile(file,JSON.stringify(record));
  await actual.writeFile(file+'.recovery','unresolved gate');faults(file,[denied(file)]);
  await expect(acquireLease(file)).rejects.toMatchObject({code:'LOCK_BUSY'});await actual.unlink(file+'.recovery');
  await expect(acquireLease(file)).rejects.toMatchObject({code:'LOCK_BUSY'});
  record.host=hostname();await actual.writeFile(file,JSON.stringify(record));
  vi.spyOn(process,'kill').mockImplementation(()=>{throw Object.assign(new Error('cannot prove death'),{code:'EPERM'});});
  await expect(acquireLease(file)).rejects.toMatchObject({code:'LOCK_BUSY'});expect(fs.unlink).not.toHaveBeenCalled();
});
test('malformed owner stays LOCK_UNKNOWN and is never deleted',async()=>{
  const {file}=await fixture();await actual.writeFile(file,'{corrupt');faults(file,[denied(file)]);
  await expect(liveLease(file)).rejects.toMatchObject({code:'LOCK_UNKNOWN'});expect(await actual.readFile(file,'utf8')).toBe('{corrupt');expect(fs.unlink).not.toHaveBeenCalled();
});
test('stable reads still reject unavailable file identity',async()=>{
  const {file}=await fixture();await actual.writeFile(file,'data');
  vi.mocked(fs.open).mockImplementation((async(path,...args)=>{const handle=await actual.open(path,...args as [string]);if(String(path)===file){const stat=handle.stat.bind(handle);handle.stat=(async(...a:unknown[])=>Object.assign(await stat(...a as []),{ino:0n})) as typeof handle.stat;}return handle;}) as typeof fs.open);
  await expect(readStable(file)).rejects.toMatchObject({code:'FILE_IDENTITY_UNAVAILABLE'});
});
test('owner-open disappearance followed by replacement revalidates and reads the new token',async()=>{
  const {root,file}=await fixture(),lease=await acquireLease(file),replacement={token:randomUUID(),pid:process.pid,host:hostname(),createdAt:new Date().toISOString()};let calls=0;
  vi.mocked(fs.realpath).mockClear();vi.mocked(fs.open).mockImplementation((async(path,...args)=>{
    if(String(path)===file&&calls++===0){await actual.unlink(file);await actual.writeFile(file,JSON.stringify(replacement));throw denied(file,'ENOENT','open');}
    return actual.open(path,...args as [string]);
  }) as typeof fs.open);
  expect(await liveLease(file)).toEqual(replacement);expect(calls).toBe(2);expect(count(root)).toBe(2);expect(delays).toEqual([25]);expect(fs.unlink).not.toHaveBeenCalled();
  await lease.release();expect(JSON.parse(await actual.readFile(file,'utf8'))).toEqual(replacement);
});
test('owner-open repeated disappearance with a present path is bounded and preserves the error and lock',async()=>{
  const {file}=await fixture(),lease=await acquireLease(file),bytes=await actual.readFile(file),error=denied(file,'ENOENT','open');let calls=0;
  vi.mocked(fs.open).mockImplementation((async(path,...args)=>{if(String(path)===file){calls++;throw error;}return actual.open(path,...args as [string]);}) as typeof fs.open);
  try{await expect(liveLease(file)).rejects.toBe(error);expect(calls).toBe(5);expect(delays).toEqual([25,25,25,25]);expect(fs.unlink).not.toHaveBeenCalled();expect(await actual.readFile(file)).toEqual(bytes);}
  finally{vi.mocked(fs.open).mockImplementation(actual.open);await lease.release();}
});
test('owner-open replacement cannot bypass the next full parent boundary check',async()=>{
  const {root,file}=await fixture(),lease=await acquireLease(file),before=await actual.readFile(file);let calls=0;
  vi.mocked(fs.open).mockImplementation((async(path,...args)=>{
    if(String(path)===file&&calls++===0){await actual.writeFile(join(root,'story2libtv.yaml'),'new protected marker');throw denied(file,'ENOENT','open');}
    return actual.open(path,...args as [string]);
  }) as typeof fs.open);
  await expect(liveLease(file)).rejects.toMatchObject({code:'LEGACY_ROOT'});expect(calls).toBe(1);expect(delays).toEqual([25]);expect(fs.unlink).not.toHaveBeenCalled();expect(await actual.readFile(file)).toEqual(before);await lease.release();
});

test.each([1,4,5])('EBADF lock observation with %i faults shares the existing five-attempt budget',async failures=>{
  const {root,file}=await fixture(),lease=await acquireLease(file),bytes=await actual.readFile(file);
  const errors=Array.from({length:failures},()=>denied(file,'EBADF'));
  const calls=faults(file,errors);vi.mocked(fs.realpath).mockClear();vi.mocked(fs.open).mockClear();
  try{
    if(failures===5){await expect(liveLease(file)).rejects.toBe(errors[4]);expect(fs.open).not.toHaveBeenCalled();}
    else expect(await liveLease(file)).toMatchObject({token:lease.token,pid:process.pid,host:hostname()});
    expect(calls()).toBe(Math.min(failures+1,5));expect(count(root)).toBe(calls());
    expect(delays).toEqual(Array(Math.min(failures,4)).fill(25));
    expect(await actual.readFile(file)).toEqual(bytes);expect(fs.unlink).not.toHaveBeenCalled();
  }finally{vi.mocked(fs.realpath).mockImplementation(actual.realpath);await lease.release();}
});
test('EBADF without syscall, EPERM and PATH_CHANGED share one full path budget',async()=>{
  const {root,file}=await fixture(),lease=await acquireLease(file),last=denied(file,'EBADF');
  const calls=faults(file,[Object.assign(Error(),{code:'EBADF'}),denied(file,'EPERM'),denied(file,'ENOENT'),denied(file,'EBADF'),last]);
  vi.mocked(fs.realpath).mockClear();
  try{await expect(liveLease(file)).rejects.toBe(last);expect(calls()).toBe(5);expect(count(root)).toBe(5);expect(delays).toEqual([25,25,5,25]);}
  finally{vi.mocked(fs.realpath).mockImplementation(actual.realpath);await lease.release();}
});
test.each(['ordinary .lock','acquisition','ancestor','leaf directory','non-Windows','unusable identity','multiple links','lstat','EACCES','EBUSY'])('EBADF exception does not broaden %s',async mode=>{
  const {root,file}=await fixture();await actual.writeFile(file,'ordinary');
  if(mode==='non-Windows')Object.defineProperty(process,'platform',{...originalPlatform,value:'linux'});
  if(mode==='multiple links')await actual.link(file,join(root,'alias'));
  const target=['ancestor','leaf directory'].includes(mode)?root:file;
  const error=denied(target,['EACCES','EBUSY'].includes(mode)?mode:'EBADF');
  const calls=faults(target,[error]);
  if(['unusable identity','lstat'].includes(mode))vi.mocked(fs.lstat).mockImplementation((async(p,...args)=>{
    if(mode==='lstat' && String(p)===file)throw error;
    const info=await actual.lstat(p,...args as []);return String(p)===file?Object.assign(Object.create(info),{ino:0n}):info;
  }) as typeof fs.lstat);
  const result=mode==='ordinary .lock'?safePath(file):mode==='acquisition'?acquireLease(file):liveLease(mode==='leaf directory'?root:file);
  await expect(result).rejects.toBe(error);expect(delays).toEqual([]);expect(calls()).toBe(mode==='lstat'?0:1);
});
test.each(['removed','new owner','symlink','junction','hardlink','protected ancestor'])('EBADF rechecks a lock replaced by %s',async kind=>{
  const {root,file}=await fixture(),lease=await acquireLease(file),outside=await fixture();
  const next={token:randomUUID(),pid:process.pid,host:hostname(),createdAt:new Date().toISOString()};
  await actual.writeFile(outside.file,JSON.stringify(next));vi.mocked(fs.realpath).mockClear();
  faults(file,[async()=>{
    if(kind==='protected ancestor')await actual.writeFile(join(root,'story2libtv.yaml'),'protected');
    else{
      await actual.unlink(file);
      if(kind==='new owner')await actual.writeFile(file,JSON.stringify(next));
      if(kind==='symlink')await actual.symlink(outside.file,file,'file');
      if(kind==='junction')await actual.symlink(outside.root,file,'junction');
      if(kind==='hardlink')await actual.link(outside.file,file);
    }
    throw denied(file,'EBADF');
  }]);
  try{
    if(kind==='removed')expect(await liveLease(file)).toBeUndefined();
    else if(kind==='new owner')expect(await liveLease(file)).toEqual(next);
    else await expect(liveLease(file)).rejects.toMatchObject({code:kind==='protected ancestor'?'LEGACY_ROOT':'LINK_PATH'});
    expect(delays).toEqual([25]);expect(count(root)).toBe(2);expect(fs.unlink).not.toHaveBeenCalled();
  }finally{vi.mocked(fs.realpath).mockImplementation(actual.realpath);await lease.release();}
  if(kind==='new owner')expect(JSON.parse(await actual.readFile(file,'utf8'))).toEqual(next);
});
test.each(['story scheduler','video stage','legacy scheduler'])('EBADF live %s is still exclusive on its actual observation path',async kind=>{
  const {root}=await fixture(),{requireScheduler}=await import('../src/jobs/coordinator.js');
  const {startImageStage}=await import('../src/images/phase.js');
  const file=kind==='legacy scheduler'?join(root,'batch.lock'):join(root,'.metasocli',kind==='video stage'?'video-stage.lock':'batch-scheduler.lock');
  const lease=await acquireLease(file),calls=faults(file,[denied(file,'EBADF')]),bytes=await actual.readFile(file);
  try{
    const check=kind==='video stage'?startImageStage(root,{projectId:randomUUID(),planId:randomUUID(),token:randomUUID(),state:'active',runtime:root,quotaGroup:'test'}):requireScheduler(root,root);
    await expect(check).rejects.toMatchObject({code:kind==='video stage'?'VIDEO_STAGE_ACTIVE':kind==='legacy scheduler'?'LEGACY_SCHEDULER_BUSY':'SCHEDULER_BUSY'});
    expect(calls()).toBe(2);expect(await actual.readFile(file)).toEqual(bytes);expect(fs.unlink).not.toHaveBeenCalled();
  }finally{vi.mocked(fs.realpath).mockImplementation(actual.realpath);await lease.release();}
});
test('EBADF image receiver inspection retains the live submitting slot',async()=>{
  const {imageFixture,imageResponse,profile}=await import('./image-api-helpers.js');
  const {cleanup}=await import('./helpers.js');
  const {createImagePlan}=await import('../src/images/planning.js');
  const {runImages}=await import('../src/images/run.js');
  const {listImageJobs}=await import('../src/images/store.js');
  const {reconcileImageLedger}=await import('../src/images/coordinator.js');
  try{
    const f=await imageFixture(),plan=(await createImagePlan(f.root,{episodes:['ep-1'],profile,submissionMode:'all-ready'})).plan;
    let seen:string|undefined,observations=0;
    const result=await runImages(f.root,plan.planId,true,{client:{async create(){
      const j=(await listImageJobs(f.root))[0]!,file=join(f.root,'.metasocli/image-receipts',j.operationId,'receiver.lock');
      const calls=faults(file,[denied(file,'EBADF')]);
      try{seen=(await reconcileImageLedger(f.root,profile)).slots.find(s=>s.operationId===j.operationId)?.status;observations=calls();}
      finally{vi.mocked(fs.realpath).mockImplementation(actual.realpath);}
      return imageResponse();
    }}});
    expect(seen).toBe('submitting');expect(observations).toBe(2);expect(result.summary.registered).toBe(1);
  }finally{await cleanup();}
});
test('EBADF from owner open uses the original unreadable-owner rule, with no second path inspection',async()=>{
  const {file}=await fixture(),lease=await acquireLease(file),bytes=await actual.readFile(file);
  vi.mocked(fs.realpath).mockClear();let opens=0;
  vi.mocked(fs.open).mockImplementation((async(p,...args)=>{
    if(String(p)===file){opens++;throw denied(file,'EBADF','open');}
    return actual.open(p,...args as [string]);
  }) as typeof fs.open);
  try{
    await expect(liveLease(file)).rejects.toMatchObject({code:'LOCK_UNKNOWN'});
    expect(count(file)).toBe(1);expect(opens).toBe(5);
    expect(await actual.readFile(file)).toEqual(bytes);expect(fs.unlink).not.toHaveBeenCalled();
  }finally{vi.mocked(fs.open).mockImplementation(actual.open);await lease.release();}
});
