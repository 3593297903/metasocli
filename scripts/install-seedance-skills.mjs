import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withSkillService } from './seedance-codex-skills.mjs';
import { seedanceEntries } from './seedance-skill.mjs';

const installRoot = await realpath(dirname(dirname(fileURLToPath(import.meta.url))));
const entries = Object.keys(seedanceEntries);
const scope = process.argv[2];
if (!['--repo', '--user'].includes(scope) || process.argv.length !== 3) {
  throw Error('Usage: node scripts/install-seedance-skills.mjs --repo|--user');
}
if (JSON.parse(await readFile(join(installRoot, 'package.json'), 'utf8')).name !== 'metasocli') {
  throw Error('Unknown installation owner');
}
async function statIfPresent(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function checkedDirectory(parent, name) {
  const path = join(parent, name);
  try { await mkdir(path); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!(await lstat(path)).isDirectory() || relative(path, await realpath(path))) {
    throw Error('Skill installation needs a real directory at '+path);
  }
  return path;
}
const root = scope === '--repo' ? installRoot : await realpath(homedir());
const discovery = await checkedDirectory(await checkedDirectory(root, '.agents'), 'skills');
const prepared = [];
const sha256 = value => createHash('sha256').update(value).digest('hex');
for (const id of entries) {
  if (scope === '--user') {
    const other = join(root, '.codex', 'skills', id);
    if (await statIfPresent(other)) throw Error('Another user-level entry exists at '+other);
  }
  const source = join(installRoot, 'skills', id);
  const body = await readFile(join(source, 'SKILL.md'), 'utf8');
  const header = body.match(/^---\r?\n[\s\S]+?\r?\n---\r?\n/u)?.[0];
  if (!header?.includes('name: '+id+'\n') && !header?.includes('name: '+id+'\r\n')) throw Error('Unexpected skill identity '+id);
  const link = scope === '--repo' ? '../../../skills/'+id+'/SKILL.md' :
    join(source, 'SKILL.md').replaceAll('\\', '/');
  const usage = seedanceEntries[id].purpose === 'story'
    ? '，按正文整理剧本、准备素材并交付逐集分镜清单。'
    : '，依据用户原话区分选型、讨论和明确生成的集段。';
  const pointer = header+'\n读取[项目技能正文](<'+link+'>)'+usage+'\n';
  let wrapper = pointer;
  const dest = join(discovery, id);
  if(seedanceEntries[id].purpose==='story'){
    // Give explicit selection the full instructions on its first model turn.
    // Links in an installed user entry must still resolve into the same package.
    const destLink = path => (scope==='--repo' ? relative(dest,path) : path).replaceAll('\\','/');
    const expanded = body.slice(header.length).trim().replace(
      /\]\((\.\.?\/[^)]+)\)/gu,(_match,target)=>'](<'+destLink(join(source,target))+'>)');
    const content='安装根见[本包 package.json](<'+destLink(join(installRoot,'package.json'))+'>) 所在目录。\n\n'+expanded+'\n';
    wrapper=pointer+'\n<!-- metasocli-prep-sha256 '+sha256(content)+' -->\n'+content;
  }
  const yaml = await readFile(join(source, 'agents', 'openai.yaml'), 'utf8');
  const already = await statIfPresent(dest);
  let previousWrapper;
  if (already) {
    if (!already.isDirectory() || relative(dest, await realpath(dest))) throw Error('Unexpected skill path '+dest);
    for (const [name, expected] of [['SKILL.md', wrapper], ['agents/openai.yaml', yaml]]) {
      const path = join(dest, name);
      if (!(await lstat(path)).isFile() || relative(path, await realpath(path))) throw Error('Existing entry differs at '+path);
      const actual=await readFile(path,'utf8');
      if(actual===expected)continue;
      // Upgrade only our exact historical pointer or an intact, checksummed
      // full story wrapper. Local edits or another installation must survive.
      if(name==='SKILL.md' && seedanceEntries[id].purpose==='story' && actual.startsWith(pointer)){
        const prior=actual.slice(pointer.length).match(/^\n<!-- metasocli-prep-sha256 ([a-f0-9]{64}) -->\n([\s\S]+)$/u);
        if(actual===pointer || (prior && sha256(prior[2])===prior[1])){previousWrapper=actual;continue;}
      }
      throw Error('Existing entry differs at '+path);
    }
  }
  prepared.push({id, dest, already: !!already, previousWrapper, wrapper, yaml});
}
for (const item of prepared) {
  if (!item.already || item.previousWrapper!==undefined) {
    const stage = await mkdtemp(join(discovery, '.'+item.id+'-'));
    try {
      await writeFile(join(stage, 'SKILL.md'), item.wrapper);
      if(item.already){
        const path=join(item.dest,'SKILL.md');
        if(await readFile(path,'utf8')!==item.previousWrapper)throw Error('Existing entry changed at '+path);
        await rename(join(stage,'SKILL.md'),path);
      } else {
        await mkdir(join(stage, 'agents'));
        await writeFile(join(stage, 'agents', 'openai.yaml'), item.yaml);
        await rename(stage, item.dest);
      }
    } finally {
      if (dirname(stage) === discovery) await rm(stage, {recursive: true, force: true});
    }
  }
  console.log(item.dest);
}
if (scope === '--user') {
  await withSkillService(installRoot,process.env,async service=>{
    const [row]=await service.list([installRoot]);
    for(const item of prepared){
      const installed=join(item.dest,'SKILL.md');
      const enabledUser=row.skills.find(s=>s.name===item.id && s.enabled && s.scope==='user' && !relative(s.path,installed));
      if(!enabledUser) throw Error('Codex has not enabled the installed entry: '+installed);
      const repoFile=join(installRoot,'.agents','skills',item.id,'SKILL.md');
      const duplicate=row.skills.find(s=>s.name===item.id && s.scope==='repo' && !relative(s.path,repoFile));
      if(duplicate?.enabled && await service.disableFile(repoFile)!==false) {
        throw Error('Codex did not disable the duplicate entry at '+repoFile);
      }
    }
    const [verified]=await service.list([installRoot]);
    for(const item of prepared){
      const matches=verified.skills.filter(s=>s.enabled && s.name===item.id);
      if(matches.length!==1 || relative(matches[0].path,join(item.dest,'SKILL.md'))) {
        throw Error('Expected one active Codex entry for '+item.id);
      }
    }
  });
}
