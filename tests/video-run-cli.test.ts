import { afterEach, expect, test } from 'vitest';
import { readFile, writeFile, mkdir, cp, rename } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cleanup } from './helpers.js';
import { batchFixture } from './batch-helpers.js';
import { files } from './prompt-replacement-fixture.js';
const exec=promisify(execFile),cli=resolve('dist/cli/main.js');
afterEach(cleanup);
async function setup(root:string,local=false,suffix=''){
  const audit=join(dirname(root),'video-run-audit'+suffix+'.jsonl');
  return {audit,env:{...process.env,METASO_API_KEY:'',METASOCLI_IMAGE_API_KEY:'',METASO_RUNTIME_DIR:join(dirname(root),'runtime'),VIDEO_RUN_AUDIT:audit,VIDEO_RUN_LOCAL:local?'1':'0',
    NODE_OPTIONS:[process.env.NODE_OPTIONS,'--import='+pathToFileURL(resolve('scripts/video-run-test-guard.mjs')).href].filter(Boolean).join(' ')}};
}
const events=async(path:string)=>(await readFile(path,'utf8')).trim().split(/\r?\n/).map(s=>JSON.parse(s));
async function record(name:string,data:unknown){if(process.env.METASO_TEST_EVIDENCE_DIR)await writeFile(join(process.env.METASO_TEST_EVIDENCE_DIR,'runner-cli-'+name+'.json'),JSON.stringify(data,null,2));}
test('real CLI selector and exact-batch local path never load credentials, read runtime or network',async()=>{
  const f=await batchFixture([1]),{env,audit}=await setup(f.root,true);
  for(const args of [['--episodes','ep-z'],['--batch',f.batch.plan.batchId]]){
    const output=await exec(process.execPath,[cli,'video','run','--root',f.root,...args],{env,windowsHide:true});
    expect(JSON.parse(output.stdout)).toMatchObject({state:'prepared',batchId:f.batch.plan.batchId});
  }
  expect(await events(audit)).toHaveLength(2);
  await record('local',{events:await events(audit),keyReads:0,runtimeReads:0,network:0});
});
test('strict public arguments reject duplicates, conflicts and added fee/key/force flags without echo',async()=>{
  const f=await batchFixture([1]),before=await files(f.root),{env,audit}=await setup(f.root,true);
  const base=[cli,'video','run','--root',f.root];
  for(const tail of [[],['--episodes','ep-z','--root','PRIVATE'],['--episodes','ep-z','--episodes','PRIVATE'],['--episodes','ep-z','--confirm','--confirm'],
    ['--episodes','ep-z','--selection','PRIVATE'],['--batch',f.batch.plan.batchId,'--concurrency','2'],['--batch',f.batch.plan.batchId,'--expect-scope','PRIVATE'],
    ['--episodes','ep-z','--key','PRIVATE'],['--force'],['--all-episodes'],['--episodes','ep-z','--accept-unknown-result'],['--episodes','ep-z','--endpoint','PRIVATE'],
    ['--episodes','ep-z','--poll-ms','60001'],['--episodes','ep-z','--capacity-poll-ms','1'],['--episodes','ep-z','--scheduler-wait-ms','300001'],['--episodes','ep-z','--concurrency','5']]){
    const r=await exec(process.execPath,[...base,...tail],{env,windowsHide:true}).catch(e=>e);
    expect(r.code,JSON.stringify(tail)).toBe(1);expect(r.stdout).not.toContain('PRIVATE');
  }
  const legacy=await exec(process.execPath,[cli,'video','execute','--root',f.root,'--episodes','ep-z','--confirm'],{env,windowsHide:true}).catch(e=>e);
  expect(JSON.parse(legacy.stdout).error.code).toBe('VIDEO_SCOPE_REQUIRED');
  expect(await files(f.root)).toEqual(before);expect((await events(audit)).every(e=>e.command)).toBe(true);
},30000);
test('all three Skills share an actual single-call PowerShell runner; Chinese/space paths and relocated install',async()=>{
  const f=await batchFixture([2]),root=join(dirname(f.root),'中文 故事'),install=join(dirname(f.root),'独立 安装');await rename(f.root,root);
  await mkdir(install);await cp(resolve('dist'),join(install,'dist'),{recursive:true});
  // Copy packages instead of linking the old installation or another project.
  await cp(resolve('node_modules/zod'),join(install,'node_modules/zod'),{recursive:true});
  await cp(resolve('node_modules/yaml'),join(install,'node_modules/yaml'),{recursive:true});
  await cp(resolve('node_modules/undici'),join(install,'node_modules/undici'),{recursive:true});
  await cp(resolve('package.json'),join(install,'package.json'));
  const doc=await readFile('docs/VIDEO_EXECUTE.md','utf8'),sample=doc.match(/^\x60{3}powershell\r?\n([\s\S]*?)^\x60{3}/m)![1];
  for(const name of ['metasoclitk','metasocli-video-prompts','metasocli-video-prompts-旁白']){
    const text=await readFile(join('skills',name,'SKILL.md'),'utf8');
    expect(text).toContain('[固定视频入口 video run](../../docs/VIDEO_EXECUTE.md#固定视频入口)');
    expect(text.indexOf('[固定视频入口 video run]')).toBeLessThan(text.indexOf('[已有图片授权与提交上下文]'));
    expect(text).toContain('video run 调用次数为0');expect(text).toContain('不自动撤销此前已成功的替换');
    const {env,audit}=await setup(root,false,'-'+name),script=join(dirname(root),'run-'+name+'.ps1');
    await writeFile(script,"$nodeExe=$env:V_NODE;$installRoot=$env:V_INSTALL;$storyRoot=$env:V_ROOT;$videoSelectorArgs=@('--episodes','ep-z');$videoConfirmed=$true;$videoOptions=@('--poll-ms','0')\n"+sample);
    const start=performance.now();
    const r=process.platform==='win32'?await exec('pwsh.exe',['-NoProfile','-NonInteractive','-File',script],{windowsHide:true,env:{...env,V_NODE:process.execPath,V_INSTALL:install,V_ROOT:root}})
      :await exec(process.execPath,[join(install,'dist/cli/main.js'),'video','run','--root',root,'--episodes','ep-z','--confirm','--poll-ms','0'],{env});
    const log=await events(audit),receipt=JSON.parse(r.stdout);
    expect(receipt.state).toBe('complete');expect(log.filter(e=>e.command)).toHaveLength(1);
    expect(log.find(e=>e.command).command.slice(0,2)).toEqual(['video','run']);
    expect(log.filter(e=>e.post)).toHaveLength(name==='metasoclitk'?2:0);
    await record(name,{elapsedMs:performance.now()-start,receipt,events:log});
  }
},90000);

test('shared sample preserves non-E drive paths as independent literal arguments (no off-workspace writes)',async()=>{
  if(process.platform!=='win32')return;
  const f=await batchFixture([1]),script=join(dirname(f.root),'portable.ps1');
  const sample=(await readFile('docs/VIDEO_EXECUTE.md','utf8')).match(/^\x60{3}powershell\r?\n([\s\S]*?)^\x60{3}/m)![1];
  await writeFile(script,`if (!(Get-PSDrive D -ErrorAction SilentlyContinue)) { New-PSDrive -Name D -PSProvider FileSystem -Root $env:V_DRIVE -Scope Script | Out-Null }
  function Fake-Node {
    param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)
    if ($Arguments[0] -cne 'D:\\中文 安装\\dist\\cli\\main.js' -or $Arguments[4] -cne 'C:\\故事 项目' -or $Arguments[6] -cne 'C:\\选择 文件.json') { throw 'Path arguments changed' }
    $global:LASTEXITCODE=0
    '{"schemaVersion":1,"batchId":"portable","batchHash":"hash","scopeHash":"scope","state":"prepared"}'
  }
  $installRoot='D:\\中文 安装';$nodeExe='Fake-Node';$storyRoot='C:\\故事 项目';$videoSelectorArgs=@('--selection','C:\\选择 文件.json');$videoConfirmed=$false;$videoOptions=@()
  `+sample);
  const r=await exec('pwsh.exe',['-NoProfile','-NonInteractive','-File',script],{windowsHide:true,env:{...process.env,V_DRIVE:dirname(f.root)}}).catch(e=>e);
  expect(r.code,r.stderr).toBeUndefined();expect(JSON.parse(r.stdout).state).toBe('prepared');
});
