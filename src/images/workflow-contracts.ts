import { z } from 'zod';
import { Episode, Hash, Id, RelativePath } from '../contracts/story.js';
import { Selection } from '../contracts/batch.js';
import { ImagePlan, ImageProfile } from './contracts.js';

const InputPath=z.string().min(1).max(4096);
export const PreparationScope=z.union([
  z.object({episodes:z.array(Id).min(1).max(2000)}).strict(),
  z.object({selection:Selection}).strict(),
  z.object({assets:z.array(Id).min(1).max(2000)}).strict(),
]);
export const ImageBatch=z.object({schemaVersion:z.literal(1),projectId:z.uuid(),
  entries:z.array(z.object({episodeId:Id,draftPath:InputPath,requestPath:InputPath,recipePath:InputPath,replace:z.boolean().default(false)}).strict()).min(1).max(2000),
  scope:PreparationScope,profilePath:InputPath.nullable().default(null),
}).strict();
export const SnapshotFile=z.object({path:RelativePath,sha256:Hash}).strict();
export const PreparationInput=z.object({schemaVersion:z.literal(1),workflowVersion:z.literal(1),preparationId:z.uuid(),planId:z.uuid(),projectId:z.uuid(),
  inputFingerprint:Hash,contentFingerprint:Hash,createdAt:z.iso.datetime(),validatorHash:Hash,profile:ImageProfile,scope:PreparationScope,
  entries:z.array(z.object({episodeId:Id,replace:z.boolean(),draft:SnapshotFile,request:SnapshotFile,recipe:SnapshotFile,source:SnapshotFile,
    sourceBasename:z.string().min(1).max(255),expectedEpisode:Episode,previousEpisodeHash:Hash.nullable()}).strict()).min(1).max(2000),hash:Hash,
}).strict();
export type PreparationRecord=z.infer<typeof PreparationInput>;
export const PreparationState=z.object({schemaVersion:z.literal(1),preparationId:z.uuid(),inputHash:Hash,validatedBy:Hash.nullable(),
  imported:z.array(z.object({episodeId:Id,episodeHash:Hash}).strict()),status:z.enum(['preparing','ready']),planHash:Hash.nullable(),hash:Hash,
}).strict();
export type PreparationStateRecord=z.infer<typeof PreparationState>;
export const PlanIntent=z.object({schemaVersion:z.literal(1),preparationId:z.uuid(),inputHash:Hash,inputFingerprint:Hash,plan:ImagePlan,hash:Hash}).strict();
export interface WorkflowOptions {python?:string;checkpoint?:(name:string)=>Promise<void>}
export interface PrepareOptions extends WorkflowOptions {batch?:string;preparation?:string}
export interface CollectOptions extends WorkflowOptions {preparation:string}

export interface WorkflowSummary {
  preparationId:string;planId:string|null;projectId:string;status:'preparing'|'ready';sampledAt:string;
  importedEpisodes:string[];remainingEpisodes:string[];recordPath:string;summaryPath:string;timingsPath:string;
}
