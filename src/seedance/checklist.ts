import { loadStory } from '../core/project.js';
import { readEpisodeSource } from '../core/planning.js';
import { fail, publicError } from '../core/errors.js';
import { seedCounts, type SeedRole } from '../contracts/story.js';
import { orderedBindings, prepareInputs, verifiedFile } from './request.js';

/** Local, model-independent review; no plan, credentials or generation side effects. */
export async function seedChecklist(root:string, episodeId:string) {
  const story=await loadStory(root);
  const episode=story.episodes.find(e=>e.id===episodeId);
  if(!episode)fail('EPISODE_MISSING','Unknown episode '+episodeId);
  const source=await readEpisodeSource(root,episode);
  const segments=[];
  for(const segment of episode.segments) {
    const issues:{code:string;message:string}[]=[];
    const ordinals=new Map<SeedRole,number>();
    const assets=[];
    for(const {role,assetId,asset,problem} of orderedBindings(story,segment)) {
      const ordinal=(ordinals.get(role)??0)+1;
      ordinals.set(role,ordinal);
      let issue;
      try {
        if(problem)fail('ASSET_ROLE',problem);
        if(!asset)fail('MISSING_ASSET','Missing registered asset '+assetId);
        await verifiedFile(root,asset);
      }catch(error){issue=publicError(error);issues.push(issue);}
      assets.push({role,ordinal,assetId,path:asset?.path,mime:asset?.mime,sha256:asset?.sha256,
        status:issue?(issue.code==='MISSING_ASSET'?'missing':'invalid'):'ready',issue});
    }
    let promptHash:string|undefined;
    try{
      const span=source.slice(segment.start,segment.end);
      if(episode.kind==='script'?!segment.prompt.includes(span):segment.prompt!==span) fail('SOURCE_CHANGED','Imported prompt differs from its source span.');
      if(!issues.length)promptHash=prepareInputs(story,segment).promptHash;
    }catch(error){issues.push(publicError(error));}
    segments.push({episodeId,segmentId:segment.id,targetDuration:segment.targetDurationSeconds??segment.duration,duration:segment.duration,
      ratio:segment.seedance?.ratio??segment.parameters.ratio,counts:seedCounts(segment),assets,sourcePromptHash:segment.promptHash,promptHash,narration:segment.narration,
      status:issues.length?'blocked':'ready',issues});
  }
  return {episodeId,segments};
}
