import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as yaml } from 'yaml';
import { seedanceEntries, skillDecision } from './seedance-skill.mjs';
import { withSkillService } from './seedance-codex-skills.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const codex = process.env.METASOCLI_CODEX_BIN ?? 'codex';
const ids = Object.keys(seedanceEntries);
const scratch = await mkdtemp(join(tmpdir(), 'metasocli-ycy-skill-'));
const story = join(scratch, 'story');
const profile = join(scratch, 'codex-profile');
await mkdir(profile);
execFileSync(process.execPath, [join(root,'dist/cli/main.js'), 'init', '--root', story, '--name', 'skill discovery fixture'], {windowsHide:true});
const helper = join(root, 'scripts', 'seedance-skill.mjs');
const report = {codex: execFileSync(codex, ['--version'], {encoding:'utf8', windowsHide:true}).trim(), discovery:[], prompts:[], guard:[]};
let responses = [];
let creates = 0;
const server = createServer(async (req,res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (req.method === 'POST' && req.url === '/v1/videos') creates++;
  if (req.method === 'POST' && req.url === '/v1/responses') {
    const body = JSON.parse(Buffer.concat(chunks));
    const inputText=[];
    JSON.stringify(body.input,(_k,v)=>{if(typeof v==='string') inputText.push(v);return v;});
    responses.push(inputText.join('\n'));
  }
  res.writeHead(400, {'content-type':'application/json'});
  res.end('{"error":{"message":"Offline request captured; no model or video was called.","type":"invalid_request_error"}}');
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = 'http://127.0.0.1:'+server.address().port;
const env = {...process.env, CODEX_HOME:profile};
const config = [
  'model="skill-test"', 'model_provider="offline"', 'web_search="disabled"',
  '[model_providers.offline]', 'name="Local skill probe"', 'wire_api="responses"',
  'base_url="'+origin+'/v1"', 'requires_openai_auth=false', 'request_max_retries=0', 'stream_max_retries=0',
  '[analytics]', 'enabled=false', '[feedback]', 'enabled=false',
  ...[root,story].flatMap(cwd => ['[projects.'+JSON.stringify(cwd)+']', 'trust_level="trusted"']),
];
// Replay only the three path-based settings into the mock-model profile.
// First verify what the actual installed Codex configuration resolves to.
const installed=await withSkillService(root,process.env,api=>api.list([root,story]));
for(const row of installed){
  for(const id of ids){
    const eligible=row.skills.filter(s=>s.name===id && s.enabled);
    const file=join(homedir(),'.agents','skills',id,'SKILL.md');
    assert.equal(eligible.length,1,'Unexpected active entry count for '+id+' in '+row.cwd);
    assert.equal(resolve(eligible[0].path).toLowerCase(),file.toLowerCase());
    if(row.cwd===root){
      const repo=row.skills.find(s=>s.name===id && s.scope==='repo');
      assert.ok(repo && !repo.enabled,'Expected duplicate repository registration disabled: '+id);
      config.push('[[skills.config]]','path = '+JSON.stringify(repo.path),'enabled = false');
    }
  }
}
await writeFile(join(profile, 'config.toml'), config.join('\n')+'\n');
function processOutput(cmd, args, cwd, customEnv=env) {
  return new Promise((done, reject) => {
    const p = spawn(cmd, args, {cwd, env:customEnv, windowsHide:true, stdio:['ignore','pipe','pipe']});
    let out='', err='';
    p.stdout.on('data', b => { out+=b.toString(); });
    p.stderr.on('data', b => { err=(err+b.toString()).slice(-3000); });
    const timer = setTimeout(() => { p.kill(); reject(Error('Timed out: '+cmd)); }, 30000);
    p.once('error', err => {clearTimeout(timer); reject(err);});
    p.once('exit', code => {
      clearTimeout(timer);
      p.stdout.destroy(); p.stderr.destroy();
      done({code, out, err});
    });
  });
}
try {
  const rows=await withSkillService(root,env,api=>api.list([root,story]));
  for(const cwd of [root,story]){
    const row=rows.find(r=>resolve(r.cwd)===resolve(cwd));
    assert.ok(row,'Missing discovery result for '+cwd);
    const bodies=[];
    for(const id of ids) {
      const entry=row.skills.find(s=>s.enabled && s.name===id);
      assert.ok(entry,'Missing '+id+' in '+cwd);
      const path=entry.path ?? entry.skillPath;
      const dir=dirname(path);
      const expected=join(homedir(),'.agents','skills',id,'SKILL.md');
      assert.equal(resolve(path).toLowerCase(),resolve(expected).toLowerCase());
      const ui=yaml(await readFile(join(dir,'agents','openai.yaml'),'utf8'));
      const display=seedanceEntries[id].trigger.slice(1);
      assert.equal(ui.policy.allow_implicit_invocation,false);assert.equal(ui.interface.display_name,display);
      const wrapper=await readFile(path,'utf8');
      const link=wrapper.match(/\]\(<(.+?)>\)/u);
      const canonical=resolve(dir,link[1]);
      assert.equal(canonical,join(root,'skills',id,'SKILL.md'));
      const body=await readFile(canonical,'utf8');
      assert.match(body,new RegExp('^name: '+id+'$','m'));
      if(id==='yiciyuang2'){
        const flatten=text=>text.trim().replace(/\]\(<?[^)]+?>?\)/gu,'](link)');
        for(const registered of [path,join(root,'.agents','skills',id,'SKILL.md')]){
          const full=await readFile(registered,'utf8');
          const start=full.indexOf('# 创艺坊 Seedance 2.5 剧本准备');
          assert.ok(start>=0);
          assert.equal(flatten(full.slice(start)),flatten(body.slice(body.indexOf('# 创艺坊 Seedance 2.5 剧本准备'))));
          for(const match of full.matchAll(/\]\(<([^>]+)>\)/gu)) await access(resolve(dirname(registered),match[1]));
        }
      }
      bodies.push(wrapper.replace(/^---[\s\S]*?\r?\n---\r?\n/u,'').trim());
      report.discovery.push({cwd:cwd===root?'repo':'independent-story',id,display,scope:entry.scope,path,canonical,bodySha256:createHash('sha256').update(body).digest('hex')});
    }
    for(const [message,index] of [
      ['$ycy480sd2.5 生成第2集第3、5段',0], ['$ycy720sd2.5 生成第3集',1],
      ['$ycy480sd2.50 生成第2集',0], ['生成第2集',-1],
      ['$yiciyuang2.5cli 按这份剧本准备第1到3集',2], ['$yiciyuang2.5cl 生成第2集',2],
      ['$yiciyuang2.5cli',2],
    ]) {
      responses=[];
      const call=await processOutput(codex,['exec','--ephemeral','--skip-git-repo-check','--color','never','--sandbox','read-only',message],cwd);
      assert.ok(responses.length,'Local Codex request not observed. '+call.err);
      const got=bodies.map((s,i)=>responses.some(payload=>payload.includes(s))?ids[i]:null).filter(Boolean);
      const matchedPaths=responses.flatMap(payload=>payload.match(/<path>[^<]*ycy[^<]*<\/path>|\[[^\]]+\]\(<[^>]*ycy[^>]*>\)/gu)??[]);
      const snippets=responses.flatMap(s=>s.split('\n').filter(t=>/ycy/i.test(t)).map(t=>t.slice(0,170)).slice(-12));
      const sources=row.skills.filter(s=>ids.includes(s.name)).map(s=>[s.name,s.scope]);
      assert.deepEqual(got,index===-1?[]:[ids[index]],'Wrong loaded Skill for '+message+' at '+cwd+'; links='+JSON.stringify(matchedPaths)+' snippets='+JSON.stringify(snippets)+' sources='+JSON.stringify(sources));
      report.prompts.push({cwd:cwd===root?'repo':'independent-story',message,loaded:got,...(index===2?{fullBodyInModelInput:true}:{})});
    }
    responses=[];
    const id='yiciyuang2';
    const message='请准备这份独立剧本第一集';
    const entry=row.skills.find(s=>s.enabled && s.name===id);
    await withSkillService(cwd,env,async api=>{
      await api.startSelectedSkillTurn(id,entry.path,message);
      const sawBody=()=>responses.some(text=>text.includes('seedance checklist --root <story> --episode <id>'));
      for(let i=0;i<150 && !responses.length;i++) await delay(100);
      assert.ok(responses.length,'No request for native selected Skill event');
      assert.ok(sawBody(),'Native selection did not inject the full story Skill');
      const loaded=ids.filter((_,i)=>responses.some(payload=>payload.includes(bodies[i])));
      assert.deepEqual(loaded,[id]);
      report.prompts.push({cwd:cwd===root?'repo':'independent-story',inputType:'skill',message,loaded,fullBodyInModelInput:true});
    });
  }

  // Trace a real child CLI launch, if any. The only fetch destination for a
  // video create is our in-process HTTP collector (including accidental calls).
  const preload=join(scratch,'guard.mjs'), launches=join(scratch,'launches.jsonl');
  await writeFile(launches,'');
  await writeFile(preload,`
    import {appendFileSync} from 'node:fs';
    import {resolve} from 'node:path';
    if(process.argv[1] && resolve(process.argv[1])===${JSON.stringify(join(root,'dist','cli','main.js'))})
      appendFileSync(${JSON.stringify(launches)},JSON.stringify(process.argv.slice(2))+'\\n');
    const fetchLocal=globalThis.fetch;
    globalThis.fetch=(input,init)=>fetchLocal(${JSON.stringify(origin)}+new URL(input instanceof Request ? input.url : input).pathname,init);
  `);
  const testEnv={...env,NODE_OPTIONS:'--import='+pathToFileURL(preload).href,METASOCLI_IMAGE_API_KEY:'offline-skill-test'};
  const base={entry:ids[0],root:story,episodes:['ep-2']};
  for(const [message,intent,status,entry=ids[0],selectedInUI=false] of [
    ['$ycy480sd2.5','select','model_selected'], ['$ycy480sd2.5','generate','model_selected'],
    ['$ycy480sd2.50 生成第2集','generate','no_submission'],
    ['讨论示例 “$ycy480sd2.5 生成第2集”','generate','no_submission'],
    ['可以用 $ycy480sd2.5 生成第2集吗？','generate','no_submission'],
    ['用法里写的 $ycy480sd2.5 生成第2集是什么意思？','generate','no_submission'],
    ['$ycy480sd2.5 不要生成第2集','generate','no_submission'],
    ['如果用 $ycy480sd2.5 生成第2集要多少钱？','generate','no_submission'],
    ['$ycy480sd2.5 只看状态','status','no_submission'], ['$ycy720sd2.5 生成第2集','generate','no_submission'],
    ['$yiciyuang2.5cli','select','prepare_story','yiciyuang2'],
    ['$yiciyuang2.5cli 请按24秒和12张图准备第2集','prepare','prepare_story','yiciyuang2'],
    ['按原镜段准备第2集','prepare','prepare_story','yiciyuang2',true],
    ['$yiciyuang2.5 生成第2集','generate','no_submission','yiciyuang2'],
    ['$yiciyuang2.5cli0 生成第2集','generate','no_submission','yiciyuang2',true],
    ['$yiciyuang2.5cl 生成第2集','generate','no_submission','yiciyuang2'],
    ['解释“$yiciyuang2.5cli 生成第2集”','generate','no_submission','yiciyuang2'],
    ['$yiciyuang2.5cli 怎么用？','discuss','no_submission','yiciyuang2'],
    ['$yiciyuang2.5cli 生成第2集','generate','video_entry_required','yiciyuang2'],
    ['$yiciyuang2.5cli 生成第2集','generate','no_submission','ycy720sd2'],
  ]){
    const packet=join(scratch,'request.json');
    await writeFile(packet,JSON.stringify({...base,message,intent,entry,selectedInUI}));
    const out=await processOutput(process.execPath,[helper,packet],story,testEnv);
    assert.equal(out.code,0,out.err);assert.equal(JSON.parse(out.out).status,status);
    assert.equal(await readFile(launches,'utf8'),'');assert.equal(creates,0);
    report.guard.push({message,entry,selectedInUI,status,cliLaunches:0,videoCreates:creates});
  }
  const pending={...base,prior:{root:story,message:'$ycy480sd2.5'},message:'麻烦把第二集做成视频',intent:'generate'};
  assert.deepEqual((await skillDecision(pending)).args,
    ['video','run','--root',story,'--model','seedance-2.5-face-full-5s-480p','--episodes','ep-2','--confirm']);
  assert.equal((await skillDecision({...pending,root})).status,'no_submission');
  assert.equal((await skillDecision({...pending,message:'请生成第二集，不要生成第三集'})).status,'run');
  const fixtureHome=join(scratch,'isolated-owner');
  const fixtureEnv={...env,USERPROFILE:fixtureHome,HOME:fixtureHome};
  const homedirProbe=await processOutput(process.execPath,['-p','require("node:os").homedir()'],scratch,fixtureEnv);
  assert.equal(resolve(homedirProbe.out.trim()),fixtureHome);
  const foreign=join(fixtureHome,'.agents','skills','yiciyuang2');
  await mkdir(join(foreign,'agents'),{recursive:true});
  const ownerText='local owner contents\n';
  await writeFile(join(foreign,'SKILL.md'),ownerText);
  const conflict=await processOutput(process.execPath,[join(root,'scripts','install-seedance-skills.mjs'),'--user'],root,fixtureEnv);
  assert.notEqual(conflict.code,0);
  assert.match(conflict.err,/Existing entry differs/u);
  assert.equal(await readFile(join(foreign,'SKILL.md'),'utf8'),ownerText);
  report.ownership={foreignEntryPreserved:true};
  const file=process.argv[2] ? resolve(process.argv[2]) : join(scratch,'report.json');
  await writeFile(file,JSON.stringify({...report,videoCreates:creates},null,2)+'\n');
  console.log(JSON.stringify({file,discovery:report.discovery.length,prompts:report.prompts.length,guard:report.guard.length,videoCreates:creates}));
} finally {
  server.closeAllConnections();
  await new Promise(done=>server.close(done));
}
