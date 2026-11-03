import { readdir } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ImportDraft, parse, type Story } from '../contracts/story.js';
import { importStory, loadStory, mergeImport, normalizeImportDraft } from '../core/project.js';
import { fail, publicError } from '../core/errors.js';
import { canonicalSha256, sha256Hex } from '../storage/canonical.js';
import { atomicWrite, readJson, readStable, writeJson } from '../storage/io.js';
import { exists, pathIdentity, projectPath, safePath } from '../storage/paths.js';
import { serialized, waitLease } from '../storage/locking.js';
import { createImagePlan, loadImageProfile, restoreImagePlanIntent, selectImageAssets } from './planning.js';
import { imagePath, readImagePlan } from './store.js';
import { ImageBatch, PlanIntent, PreparationInput, PreparationState, type PreparationRecord, type PreparationStateRecord, type PrepareOptions, type WorkflowSummary } from './workflow-contracts.js';
import { checkPython, validateHandoff, validatorIdentity } from './handoff.js';
import { WorkflowTimer } from './workflow-timing.js';
import { normalizeText } from '../story/text.js';

export const preparationDirectory=(id:string)=>`.metasocli/image-preparations/${parse(z.uuid(),id)}`;
const hashRecord=<T extends object>(value:T)=>({...value,hash:canonicalSha256(value)});
function verified<T extends {hash:string}>(value:T):T {
  const {hash,...base}=value;if(canonicalSha256(base)!==hash)fail('IMAGE_PREPARATION_TAMPERED','Preparation identity or hash changed. Preserve the record.');return value;
}
function identity(input:Pick<PreparationRecord,'projectId'|'scope'|'profile'|'entries'>){
  return {projectId:input.projectId,scope:input.scope,profile:input.profile,entries:input.entries.map(e=>({episodeId:e.episodeId,replace:e.replace,
    draftHash:e.draft.sha256,requestHash:e.request.sha256,recipeHash:e.recipe.sha256,sourceHash:e.source.sha256,sourceBasename:e.sourceBasename}))};
}
async function readPreparationMetadata(root:string,id:string) {
  const dir=preparationDirectory(id),input=verified(parse(PreparationInput,await readJson(await projectPath(root,`${dir}/input.json`))));
  if(input.preparationId!==id||input.projectId!==(await loadStory(root)).projectId||canonicalSha256(identity(input))!==input.contentFingerprint
    ||canonicalSha256({contentFingerprint:input.contentFingerprint,validatorHash:input.validatorHash,workflowVersion:input.workflowVersion})!==input.inputFingerprint)
    fail('IMAGE_PREPARATION_TAMPERED','Preparation input fingerprint/project mismatch.');
  return input;
}
export async function readPreparation(root:string,id:string) {
  const input=await readPreparationMetadata(root,id),dir=preparationDirectory(id);
  for(const entry of input.entries){
    for(const file of [entry.draft,entry.request,entry.recipe,entry.source]){
      if(!file.path.startsWith(`${dir}/inputs/`)||sha256Hex(await readStable(await projectPath(root,file.path)))!==file.sha256)
        fail('IMAGE_PREPARATION_TAMPERED','An immutable preparation snapshot changed.');
    }
    const normalized=await normalizedEntry(root,entry);
    if(normalized.draft.episodeId!==entry.episodeId||canonicalSha256(normalized.episode)!==canonicalSha256(entry.expectedEpisode))fail('IMAGE_PREPARATION_TAMPERED','Snapshot normalization differs from its expected episode.');
  }
  return input;
}
async function normalizedEntry(root:string,entry:PreparationRecord['entries'][number]) {
  const draft=parse(ImportDraft,await readJson(await projectPath(root,entry.draft.path)));
  return normalizeImportDraft({...draft,source:await projectPath(root,entry.source.path)},await readStable(await projectPath(root,entry.source.path)));
}
async function readState(root:string,input:PreparationRecord) {
  const file=await projectPath(root,`${preparationDirectory(input.preparationId)}/state.json`);
  if(!await exists(file))return parse(PreparationState,hashRecord({schemaVersion:1,preparationId:input.preparationId,inputHash:input.hash,validatedBy:null,imported:[],status:'preparing',planHash:null}));
  const state=verified(parse(PreparationState,await readJson(file)));
  if(state.preparationId!==input.preparationId||state.inputHash!==input.hash||new Set(state.imported.map(e=>e.episodeId)).size!==state.imported.length
    ||state.imported.some(e=>!input.entries.some(i=>i.episodeId===e.episodeId&&canonicalSha256(i.expectedEpisode)===e.episodeHash)))fail('IMAGE_PREPARATION_TAMPERED','Preparation checkpoints do not match the frozen input.');
  return state;
}
async function saveState(root:string,state:PreparationStateRecord){const {hash,...base}=state;Object.assign(state,hashRecord(base));await writeJson(await projectPath(root,`${preparationDirectory(state.preparationId)}/state.json`),parse(PreparationState,state));}
export async function validatePreparedContent(root:string,input:PreparationRecord) {
  const story=await loadStory(root);
  for(const entry of input.entries){
    const expected=entry.expectedEpisode,actual=story.episodes.find(e=>e.id===entry.episodeId);
    if(!actual||canonicalSha256(actual)!==canonicalSha256(expected))fail('IMAGE_PREPARATION_STALE',`Prepared episode changed: ${entry.episodeId}.`);
    for(const [path,hash] of [[expected.source.rawPath,expected.source.rawHash],[expected.source.textPath,expected.source.textHash]])
      if(sha256Hex(await readStable(await projectPath(root,path!)))!==hash)fail('IMAGE_PREPARATION_STALE','Imported source bytes changed.');
    const normalized=await normalizedEntry(root,entry);mergeImport(story,normalized,false);
  }
  return story;
}
export async function validatePreparationHandoffs(root:string,input:PreparationRecord,python?:string) {
  for(const entry of input.entries)await validateHandoff('recipe',await projectPath(root,entry.recipe.path),await projectPath(root,entry.request.path),await projectPath(root,entry.draft.path),undefined,python);
}
async function validateDecisions(root:string,input:PreparationRecord,story:Story){
  // Python owns the handoff contract. This bridge binds its frozen decisions to the
  // actual selected Core assets, including recipes inherited from the story.
  const {ordered}=selectImageAssets(story,input.scope),selected=new Set(ordered);
  const decisions=new Map<string,{signature:string;episodeId:string;item:Decision;source:RequestAsset}>();
  interface Decision {assetId:string;kind:string;status:string;generationPrompt:string|null;recipeSha256:string|null;existingRelativePath:string|null;contentSha256:string|null;reason:string|null}
  interface RequestAsset {assetId:string;kind:string;dependencyAssetIds:string[];exactText:string[]}
  for(const entry of input.entries){
    const recipe=await readJson(await projectPath(root,entry.recipe.path)) as {assets:Decision[]};
    const request=await readJson(await projectPath(root,entry.request.path)) as {assets:RequestAsset[]};
    for(const item of recipe.assets){
      if(!selected.has(item.assetId))continue;
      const source=request.assets.find(a=>a.assetId===item.assetId);
      if(!source)fail('IMAGE_HANDOFF_CONFLICT',`Selected asset has no frozen request: ${item.assetId}.`);
      const signature=canonicalSha256({item:{...item,generationPrompt:item.generationPrompt===null?null:normalizeText(item.generationPrompt)},kind:source.kind,dependencies:source.dependencyAssetIds,exactText:source.exactText});
      const previous=decisions.get(item.assetId);
      if(previous&&previous.signature!==signature)fail('IMAGE_HANDOFF_CONFLICT',`Conflicting decisions for ${item.assetId}: ${previous.episodeId}, ${entry.episodeId}.`);
      decisions.set(item.assetId,{signature,episodeId:entry.episodeId,item,source});
    }
  }
  for(const id of ordered){
    const decision=decisions.get(id);
    if(!decision)fail('IMAGE_HANDOFF_CONFLICT',`Selected asset has no frozen handoff decision: ${id}.`);
    const {item,source}=decision,asset=story.assets.find(a=>a.recipe.assetId===id)!;
    if(item.status==='blocked')fail('IMAGE_PREPARATION_BLOCKED',`Asset ${id} is blocked: ${item.reason}`);
    if(item.status==='skipped_optional')fail('IMAGE_HANDOFF_CONFLICT',`Selected asset ${id} was skipped_optional; reconcile the selected scope and handoff without removing references.`);
    if(item.kind!==asset.recipe.kind||source.kind!==asset.recipe.kind||canonicalSha256(source.dependencyAssetIds)!==canonicalSha256(asset.recipe.dependencies)||canonicalSha256(source.exactText)!==canonicalSha256(asset.recipe.exactText))
      fail('IMAGE_HANDOFF_CONFLICT',`Frozen request and selected recipe differ: ${id}.`);
    if(item.status==='planned'&&(item.generationPrompt===null||normalizeText(item.generationPrompt)!==normalizeText(asset.recipe.prompt)||sha256Hex(normalizeText(asset.recipe.prompt))!==item.recipeSha256))
      fail('IMAGE_HANDOFF_CONFLICT',`Frozen full prompt and selected recipe differ: ${id}.`);
    if(item.status==='reused'){
      const media=story.assets.find(a=>a.recipe.assetId===item.assetId)?.media;
      if(!media||media.path!==item.existingRelativePath||media.sha256!==item.contentSha256||sha256Hex(await readStable(await projectPath(root,media.path),input.profile.maxImageBytes))!==media.sha256)
        fail('IMAGE_PREPARATION_STALE',`Reusable image evidence changed: ${item.assetId}.`);
    }
  }
}
async function snapshot(root:string,batchPath:string,validatorHash:string,timer:WorkflowTimer):Promise<PreparationRecord> {
  const gathered=await timer.measure('input-read',async()=>{
    const batch=parse(ImageBatch,await readJson(await safePath(resolve(root,batchPath)))),story=await loadStory(root);
    if(batch.projectId!==story.projectId)fail('IMAGE_PREPARATION_PROJECT','Batch belongs to a different story.');
    if(new Set(batch.entries.map(e=>e.episodeId)).size!==batch.entries.length)fail('IMAGE_SCOPE','Duplicate preparation episodes.');
    const profile=await loadImageProfile(batch.profilePath?await safePath(resolve(root,batch.profilePath)):undefined),entries=[];
    let projected=story;
    for(const row of batch.entries){
      const buffers:Record<string,Buffer>={};
      for(const [kind,path] of [['draft',row.draftPath],['request',row.requestPath],['recipe',row.recipePath]] as const)buffers[kind]=await readStable(await safePath(resolve(root,path)),4*1024*1024);
      const draft=parse(ImportDraft,JSON.parse(buffers.draft!.toString('utf8').replace(/^\uFEFF/u,'')));
      if(draft.episodeId!==row.episodeId)fail('IMAGE_SCOPE','Batch/draft episode identity differs.');
      const sourcePath=await safePath(resolve(root,draft.source)),source=await readStable(sourcePath);
      const normalized=normalizeImportDraft({...draft,source:sourcePath},source);
      projected=mergeImport(projected,normalized,row.replace);
      entries.push({row,buffers,source,sourceBasename:basename(sourcePath),expectedEpisode:normalized.episode,previousEpisodeHash:story.episodes.find(e=>e.id===row.episodeId)?canonicalSha256(story.episodes.find(e=>e.id===row.episodeId)!):null});
    }
    const selected=selectImageAssets(projected,batch.scope);
    if(selected.scope.some(s=>!batch.entries.some(e=>e.episodeId===s.episodeId)))fail('IMAGE_SCOPE','Preparation entries must cover the selected episode bindings. Use existing plan commands for independent historical scope.');
    return {batch,profile,entries};
  });
  const preparationId=randomUUID(),planId=randomUUID(),dir=preparationDirectory(preparationId);
  const entries=gathered.entries.map((e,n)=>({episodeId:e.row.episodeId,replace:e.row.replace,
    ...Object.fromEntries(['draft','request','recipe'].map(kind=>[kind,{path:`${dir}/inputs/${n}/${kind}.json`,sha256:sha256Hex(e.buffers[kind]!)}])),
    source:{path:`${dir}/inputs/${n}/source/${e.sourceBasename}`,sha256:sha256Hex(e.source)},sourceBasename:e.sourceBasename,
    expectedEpisode:e.expectedEpisode,previousEpisodeHash:e.previousEpisodeHash})) as PreparationRecord['entries'];
  const base={projectId:gathered.batch.projectId,scope:gathered.batch.scope,profile:gathered.profile,entries};
  const contentFingerprint=canonicalSha256(identity(base));
  const directory=await projectPath(root,'.metasocli/image-preparations');
  // The index is only a hint. Rebuild from immutable records; never use summary/index as validation.
  if(await exists(directory))for(const name of await readdir(directory)){
    if(!z.uuid().safeParse(name).success||!await exists(await projectPath(root,`${preparationDirectory(name)}/input.json`)))continue;
    const candidate=await readPreparationMetadata(root,name);
    if(candidate.contentFingerprint===contentFingerprint)return readPreparation(root,name);
  }
  const input=parse(PreparationInput,hashRecord({schemaVersion:1,workflowVersion:1,preparationId,planId,...base,contentFingerprint,
    inputFingerprint:canonicalSha256({contentFingerprint,validatorHash,workflowVersion:1}),validatorHash,createdAt:new Date().toISOString()}));
  await timer.measure('input-snapshot',async()=>{
    for(const [n,entry] of entries.entries()){
      const data=gathered.entries[n]!;
      for(const kind of ['draft','request','recipe'] as const)await atomicWrite(await projectPath(root,entry[kind].path),data.buffers[kind]!);
      await atomicWrite(await projectPath(root,entry.source.path),data.source);
    }
    await writeJson(await projectPath(root,`${dir}/input.json`),input);
  });
  return input;
}

export async function prepareImages(root:string,options:PrepareOptions):Promise<WorkflowSummary & {execution?:unknown}> {
  root=await safePath(root);await loadStory(root);
  if(Boolean(options.batch)===Boolean(options.preparation))fail('CLI_ARGUMENT','Choose exactly one of --batch and --preparation.');
  await checkPython(options.python);
  const leaseFile=await projectPath(root,'.metasocli/image-preparation.lock');
  return serialized(pathIdentity(leaseFile),async()=>{
    const lease=await waitLease(leaseFile,120000),timer=new WorkflowTimer();let input:PreparationRecord|undefined,state:PreparationStateRecord|undefined;
    try{
      const validatorHash=await validatorIdentity();
      input=options.preparation?await readPreparation(root,options.preparation):await snapshot(root,options.batch!,validatorHash,timer);
      const dir=preparationDirectory(input.preparationId);state=await readState(root,input);
      await saveState(root,state);await options.checkpoint?.('snapshot-saved');
      if(state.validatedBy!==validatorHash){await timer.measure('handoff-validation',()=>validatePreparationHandoffs(root,input!,options.python));state.validatedBy=validatorHash;await saveState(root,state);}
      // Revalidate snapshots after subprocesses, and all merges before any episode import.
      input=await readPreparation(root,input.preparationId);let projected=await loadStory(root);
      for(const entry of input.entries){
        const actual=projected.episodes.find(e=>e.id===entry.episodeId),hash=actual?canonicalSha256(actual):null;
        if(hash!==entry.previousEpisodeHash&&hash!==canonicalSha256(entry.expectedEpisode))fail('IMAGE_PREPARATION_STALE','An episode was edited after input freezing.');
        projected=mergeImport(projected,await normalizedEntry(root,entry),entry.replace);
      }
      // Always enforce decisions, even for records validated by an older preparer.
      await validateDecisions(root,input,projected);
      for(const entry of input.entries){
        await lease.assertOwned();
        if(!state.imported.some(e=>e.episodeId===entry.episodeId)){
          await options.checkpoint?.(`import-before:${entry.episodeId}`);
          await timer.measure(`import:${entry.episodeId}`,async()=>importStory(root,(await normalizedEntry(root,entry)).draft,entry.replace,entry.previousEpisodeHash));
          await options.checkpoint?.(`import-after:${entry.episodeId}`);
          state.imported.push({episodeId:entry.episodeId,episodeHash:canonicalSha256(entry.expectedEpisode)});await saveState(root,state);
        }
      }
      const check=async()=>{await lease.assertOwned();await readPreparation(root,input!.preparationId);await validateDecisions(root,input!,await validatePreparedContent(root,input!));};
      const intentPath=await projectPath(root,`${dir}/plan-intent.json`);
      const plan=await timer.measure('plan-persistence',async()=>{
        if(await exists(intentPath)){
          const intent=verified(parse(PlanIntent,await readJson(intentPath)));
          if(intent.preparationId!==input!.preparationId||intent.inputHash!==input!.hash||intent.inputFingerprint!==input!.inputFingerprint||intent.plan.planId!==input!.planId||intent.plan.projectId!==input!.projectId)
            fail('IMAGE_PREPARATION_TAMPERED','Plan intent is not owned by this preparation.');
          return restoreImagePlanIntent(root,intent.plan,check);
        }
        if(state!.status==='ready'||await exists(await imagePath(root,'image-plans',input!.planId)))fail('IMAGE_PREPARATION_TAMPERED','Plan exists without its preparation intent.');
        await check();
        return (await createImagePlan(root,{...input!.scope,profile:input!.profile,submissionMode:'all-ready'},{planId:input!.planId,
          async beforeWrite(plan){await check();await writeJson(intentPath,hashRecord({schemaVersion:1,preparationId:input!.preparationId,inputHash:input!.hash,inputFingerprint:input!.inputFingerprint,plan}));await options.checkpoint?.('plan-intent-saved');},
          async afterWrite(){await options.checkpoint?.('plan-saved');},
        })).plan;
      });
      if(state.planHash&&state.planHash!==plan.planHash)fail('IMAGE_PREPARATION_TAMPERED','Prepared plan hash changed.');
      state.status='ready';state.planHash=plan.planHash;await saveState(root,state);
      await writeJson(await projectPath(root,`.metasocli/image-preparations/by-input/${input.inputFingerprint}.json`),{preparationId:input.preparationId,inputHash:input.hash});
      const {imageSummary}=await import('./reporting.js');
      const summary={...preparationSummary(input,state),execution:await imageSummary(root,plan.planId)};
      await writeJson(await projectPath(root,`${dir}/summary.json`),summary);return summary;
    }catch(error){
      if(input&&state){
        const story=await loadStory(root),observedImportedEpisodes=input.entries.filter(e=>story.episodes.some(actual=>actual.id===e.episodeId&&canonicalSha256(actual)===canonicalSha256(e.expectedEpisode))).map(e=>e.episodeId);
        const progress={...preparationSummary(input,state),observedImportedEpisodes,error:publicError(error)};
        await writeJson(await projectPath(root,`${preparationDirectory(input.preparationId)}/summary.json`),progress);
        if(error instanceof Error)Object.assign(error,{preparationProgress:progress});
      }
      throw error;
    }finally{try{if(input)await timer.save(root,`${preparationDirectory(input.preparationId)}/timings.json`);}finally{await lease.release();}}
  });
}
function preparationSummary(input:PreparationRecord,state:PreparationStateRecord):WorkflowSummary {
  const recordPath=preparationDirectory(input.preparationId);
  return {preparationId:input.preparationId,planId:state.status==='ready'?input.planId:null,projectId:input.projectId,status:state.status,sampledAt:new Date().toISOString(),
    importedEpisodes:state.imported.map(e=>e.episodeId),remainingEpisodes:input.entries.filter(e=>!state.imported.some(i=>i.episodeId===e.episodeId)).map(e=>e.episodeId),recordPath,summaryPath:`${recordPath}/summary.json`,timingsPath:`${recordPath}/timings.json`};
}
export async function preparedPlan(root:string,input:PreparationRecord){
  const state=await readState(root,input);if(state.status!=='ready'||!state.planHash)fail('IMAGE_PREPARATION_INCOMPLETE','Resume the local preparation before collecting results.');
  const intent=verified(parse(PlanIntent,await readJson(await projectPath(root,`${preparationDirectory(input.preparationId)}/plan-intent.json`)))),plan=await readImagePlan(root,input.planId);
  if(intent.inputHash!==input.hash||intent.inputFingerprint!==input.inputFingerprint||intent.preparationId!==input.preparationId||canonicalSha256(intent.plan)!==canonicalSha256(plan)||plan.planHash!==state.planHash)fail('IMAGE_PREPARATION_TAMPERED','Preparation/intent/plan linkage differs.');
  return plan;
}
