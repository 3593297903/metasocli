import { z } from 'zod';
import { parse, Hash } from '../contracts/story.js';
import { type Job } from '../contracts/job.js';
import { projectPath, exists } from '../storage/paths.js';
import { readJson, writeJson } from '../storage/io.js';
import { liveLease } from '../storage/locking.js';
import { fail } from '../core/errors.js';

const Record = z.object({ operationId: z.uuid(), projectId: z.uuid(), requestHash: Hash, token: z.uuid(), runtimeRoot: z.string().min(1) }).strict();
export const submissionLeasePath = (root: string, id: string) => projectPath(root, '.metasocli/submissions/' + parse(z.uuid(), id) + '.lock');
const recordPath = (root: string, id: string) => projectPath(root, '.metasocli/submissions/' + parse(z.uuid(), id) + '.json');
export async function saveSubmissionOwner(root: string, job: Job, token: string, runtimeRoot: string) {
  await writeJson(await recordPath(root, job.operationId), Record.parse({ operationId: job.operationId, projectId: job.projectId, requestHash: job.requestHash, token, runtimeRoot }));
}
export async function submissionOwner(root: string, job: Job) {
  const file = await recordPath(root, job.operationId);
  if (!await exists(file)) return undefined;
  const record = parse(Record, await readJson(file));
  if (record.operationId !== job.operationId || record.projectId !== job.projectId || record.requestHash !== job.requestHash) fail('SUBMISSION_OWNER_CONFLICT', 'Submission owner does not match its durable intent.');
  return record;
}
export async function liveSubmission(root: string, job: Job) {
  const record = await submissionOwner(root, job);
  if (!record) return false;
  return (await liveLease(await submissionLeasePath(root, job.operationId)))?.token === record.token;
}
