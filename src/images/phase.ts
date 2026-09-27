import { z } from 'zod';
import { parse } from '../contracts/story.js';
import { fail } from '../core/errors.js';
import { exists, projectPath } from '../storage/paths.js';
import { readJson, writeJson } from '../storage/io.js';
import { acquireLease, liveLease, withProjectWrite } from '../storage/locking.js';
const Stage=z.object({projectId:z.uuid(),planId:z.uuid(),runtime:z.string(),quotaGroup:z.string(),token:z.uuid(),state:z.enum(['active','complete'])}).strict();
export async function assertNoImageStage(root:string) {
  const file=await projectPath(root,'.metasocli/image-stage.json');
  if(await exists(file) && parse(Stage,await readJson(file)).state==='active') fail('IMAGE_STAGE_ACTIVE','Finish or recover the image stage before new video plans/submissions. Existing video task IDs can still resume.');
}
export async function startImageStage(root:string,record:z.infer<typeof Stage>) {
  const file=await projectPath(root,'.metasocli/image-stage.json');
  if(await liveLease(await projectPath(root,'.metasocli/video-stage.lock'))) fail('VIDEO_STAGE_ACTIVE','A video batch owns this story; finish its new submissions before image preparation.');
  if(await exists(file)) {const old=parse(Stage,await readJson(file));if(old.state==='active'&&old.planId!==record.planId)fail('IMAGE_STAGE_ACTIVE','Recover the existing image plan before starting another in this story.');}
  await writeJson(file,parse(Stage,record));
}
export async function finishImageStage(root:string,planId:string,complete:boolean) {
  const file=await projectPath(root,'.metasocli/image-stage.json'),stage=parse(Stage,await readJson(file));
  if(stage.planId!==planId)fail('IMAGE_STAGE_ACTIVE','Image stage belongs to another plan.');
  stage.state=complete?'complete':'active'; await writeJson(file,stage);
}
export async function acquireVideoStage(root:string) {
  return withProjectWrite(root,async()=>{await assertNoImageStage(root);return acquireLease(await projectPath(root,'.metasocli/video-stage.lock'));});
}
