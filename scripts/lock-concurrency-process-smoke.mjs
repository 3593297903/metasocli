// Windows/local filesystem stress only. No API clients, credentials or business tasks.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,lstat,readFile,writeFile,appendFile,open,unlink,realpath,rm} from 'node:fs/promises';
import {join,resolve,dirname,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {acquireLease,waitLease,liveLease} from '../dist/storage/locking.js';
const script=fileURLToPath(import.meta.url),packageRoot=resolve(dirname(script),'..');
globalThis.fetch=async()=>{throw new Error('Network forbidden in lock-only smoke');};
const errorRecord=e=>({code:e?.code??null,message:String(e?.message??e),stack:e?.stack??null});

if(process.argv[2]==='worker'){
  const [role,file,trace,witness]=process.argv.slice(3),keepAlive=setInterval(()=>{},1000);
  const released=new Promise(r=>process.on('message',m=>{if(m?.type==='release')r();}));
  try{
    if(role==='waiter'){
      let unexpected;try{unexpected=await acquireLease(file);}catch(e){assert.equal(e.code,'LOCK_BUSY');}
      if(unexpected){await unexpected.release();assert.fail('Waiter acquired before holder release');}
      process.send?.({type:'blocked',pid:process.pid});
    }
    const lease=await waitLease(file,30000);let marker;
    try{
      await lease.assertOwned();marker=await open(witness,'wx'); // Independent overlap witness.
      const owner=JSON.parse(await readFile(file,'utf8'));assert.equal(owner.token,lease.token);assert.equal(owner.pid,process.pid);
      await appendFile(trace,JSON.stringify({event:'enter',role,pid:process.pid,token:lease.token})+'\n');
      process.send?.({type:'entered',role,pid:process.pid,token:lease.token});
      if(role==='holder')await released;
      await lease.assertOwned();await appendFile(trace,JSON.stringify({event:'leave',role,pid:process.pid,token:lease.token})+'\n');
    }finally{if(marker){await marker.close();await unlink(witness);}await lease.release();}
  }finally{clearInterval(keepAlive);process.disconnect?.();}
}else{
  const output=resolve(process.env.METASO_TEST_EVIDENCE_DIR??join(packageRoot,'.work/lock-concurrency'));
  await mkdir(output,{recursive:true});const base=await mkdtemp(join(output,'lock-stress-')),baseReal=await realpath(base);
  const report={offline:true,platform:process.platform,packageRoot,pathsBuildSha256:createHash('sha256').update(await readFile(join(packageRoot,'dist/storage/paths.js'))).digest('hex'),lockingBuildSha256:createHash('sha256').update(await readFile(join(packageRoot,'dist/storage/locking.js'))).digest('hex'),startedAt:new Date().toISOString(),rounds:[],process:null};
  const save=()=>writeFile(join(base,'report.json'),JSON.stringify(report,null,2));
  const clean=async folder=>{
    const actual=await realpath(folder),rel=relative(baseReal,actual),info=await lstat(folder);
    if(info.isSymbolicLink()||isAbsolute(rel)||rel.startsWith('..')||!rel||!/^round-[123][\\/]case-\d+$/u.test(rel))throw Error('Unsafe stress cleanup target');
    await rm(actual,{recursive:true,force:true});
  };
  async function snapshot(file){try{const s=await lstat(file,{bigint:true});return {exists:true,isLink:s.isSymbolicLink(),dev:String(s.dev),ino:String(s.ino),nlink:String(s.nlink),bytes:String(s.size),owner:s.isFile()&&s.size<4096n?await readFile(file,'utf8'):null};}catch(e){return {observationError:errorRecord(e)};}}
  for(let round=1;round<=3;round++){
    const row={round,startedAt:new Date().toISOString(),cases:[],completed:0,acquisitions:0,observations:0,failures:0};report.rounds.push(row);
    for(let n=0;n<100;n++){
      const folder=join(base,`round-${round}`,`case-${n}`),file=join(folder,'lease.lock');await mkdir(folder,{recursive:true});let acquisitions=0,observations=0;
      // Never clean while the other branch is still running, including failure cases.
      const results=await Promise.allSettled([
        (async()=>{for(let i=0;i<30;i++){const lease=await waitLease(file);try{await lease.assertOwned();}finally{await lease.release();}acquisitions++;}})(),
        (async()=>{for(let i=0;i<100;i++){await liveLease(file);observations++;}})(),
      ]);
      const errors=results.flatMap((r,i)=>r.status==='rejected'?[{side:i===0?'owner':'observer',...errorRecord(r.reason)}]:[]);
      const item={case:n,acquisitions,observations,errors};if(errors.length)item.fileState=await snapshot(file);
      else try{await clean(folder);}catch(e){errors.push({side:'cleanup',...errorRecord(e)});item.fileState=await snapshot(file);}
      row.cases.push(item);row.completed++;row.acquisitions+=acquisitions;row.observations+=observations;if(errors.length)row.failures++;
      if((n+1)%25===0){await save();console.log(`ROUND ${round}: ${n+1}/100 completed, failures=${row.failures}`);}
    }
    row.endedAt=new Date().toISOString();await save();
  }
  const children=[];
  function child(role,file,trace,witness){
    const proc=spawn(process.execPath,[script,'worker',role,file,trace,witness],{cwd:base,env:process.env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
    const messages=[];let stderr='';proc.stderr.on('data',b=>stderr+=b);proc.on('message',m=>messages.push(m));
    const done=new Promise(r=>{proc.once('error',e=>r({code:null,error:errorRecord(e),stderr}));proc.once('exit',(code,signal)=>r({code,signal,stderr}));});
    const item={proc,done,messages,async wait(type){
      const existing=messages.find(m=>m.type===type);if(existing)return existing;
      let timer,listener;try{return await Promise.race([
        new Promise(r=>{listener=m=>{if(m.type===type)r(m);};proc.on('message',listener);}),
        done.then(r=>{throw Error(`Worker exited before ${type}: ${JSON.stringify(r)}`);}),
        new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(`Worker timeout: ${type}`)),30000);}),
      ]);}finally{clearTimeout(timer);proc.off('message',listener);}
    }};children.push(item);return item;
  }
  try{
    const folder=join(base,'two-process');await mkdir(folder);const file=join(folder,'lease.lock'),trace=join(folder,'trace.jsonl'),witness=join(folder,'critical.lock');
    const holder=child('holder',file,trace,witness),first=await holder.wait('entered');
    const waiter=child('waiter',file,trace,witness);await waiter.wait('blocked');
    assert.equal(waiter.messages.some(m=>m.type==='entered'),false);assert.equal((await liveLease(file))?.token,first.token);
    holder.proc.send({type:'release'});const second=await waiter.wait('entered');assert.notEqual(second.token,first.token);assert.notEqual(second.pid,first.pid);
    const exits=await Promise.all(children.map(c=>c.done));for(const exit of exits)assert.equal(exit.code,0,JSON.stringify(exit));
    const events=(await readFile(trace,'utf8')).trim().split('\n').map(s=>JSON.parse(s));let active=0,peak=0;
    for(const e of events){active+=e.event==='enter'?1:-1;assert.ok(active===0||active===1);peak=Math.max(peak,active);}assert.equal(active,0);assert.equal(peak,1);
    assert.deepEqual(events.map(e=>e.role+':'+e.event),['holder:enter','holder:leave','waiter:enter','waiter:leave']);
    assert.equal(await liveLease(file),undefined);report.process={passed:true,peak,holder:first,waiter:second,exits,events};
  }catch(e){report.process={passed:false,error:errorRecord(e)};}
  finally{for(const c of children)if(c.proc.exitCode===null&&!c.proc.killed)c.proc.kill('SIGKILL');await Promise.allSettled(children.map(c=>c.done));}
  report.endedAt=new Date().toISOString();report.totals={cases:report.rounds.reduce((n,r)=>n+r.completed,0),acquisitions:report.rounds.reduce((n,r)=>n+r.acquisitions,0),observations:report.rounds.reduce((n,r)=>n+r.observations,0),failures:report.rounds.reduce((n,r)=>n+r.failures,0)};
  report.passed=report.totals.cases===300&&report.totals.acquisitions===9000&&report.totals.observations===30000&&report.totals.failures===0&&report.process.passed;
  await save();await writeFile(join(output,'lock-stress-latest.json'),JSON.stringify({report:join(base,'report.json'),passed:report.passed},null,2));
  console.log(JSON.stringify({report:join(base,'report.json'),passed:report.passed,totals:report.totals,process:report.process}));process.exitCode=report.passed?0:1;
}
