#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { initializeStory, importStory, loadStory } from '../core/project.js';
import { createPlan, createPlanFromContextIr, loadPlan } from '../core/planning.js';
import { inspectAssets, registerAsset } from '../assets/registry.js';
import { fail, publicError } from '../core/errors.js';
import { readJson, readStable } from '../storage/io.js';
import { normalizeText } from '../story/text.js';
import { MetasoClient, redact, type ContextIrClient } from '../metaso/client.js';
import { credentialStatus, loadApiKey } from '../metaso/credentials.js';
import { listJobs, readJob } from '../jobs/store.js';
import { submit, type JobDependencies } from '../jobs/submit.js';
import { resume, attachTask } from '../jobs/resume.js';
import type { Job } from '../contracts/job.js';
import { normalizeTargetDurationSeconds } from '../story/duration.js';
import { submitContextIr, resumeContextIr, attachContextIrTask, type IrDependencies } from '../jobs/context-ir.js';
import { readIrOperation, listIrOperations, type IrPersistence } from '../jobs/context-ir-store.js';
import { operationKind } from '../jobs/submission-guard.js';
import { parse } from '../contracts/story.js';
import { z } from 'zod';

export const HELP = `metasocli 0.1.0 — independent Metaso MiniMax-H3 CLI
All story commands require --root <dedicated-story-directory>.

auth status
init       --root <path> [--name <name>]
import     --root <path> --draft <json> [--replace]
import     --root <path> --file <utf8.txt> --kind script|video-prompts --episode <id> --duration <target-seconds: >0..15>
assets list     --root <path>
assets register --root <path> --id <asset-id> (--file <image-or-narration-audio>|--url <public-https-url>) [--provenance user|imagegen]
                [--expected-sha256 <selected-reference-hash>]
plan       --root <path> --episode <id> [--workflow h3-inline-ir|h3-context-ir]
plan       --root <path> --from-context-ir <operation-id> --review <review.json>
context-ir --root <path> --plan <prepare-id> --segment <id> --confirm [--submit-only] [--retry-of <operation-id>]
           [--max-polls <1..720>] [--poll-ms <0..60000>]
generate   --root <path> --plan <id> --confirm [--segment <id>] [--submit-only] [--retry-of <operation-id>]
status     --root <path> [--operation <id>] [--remote]
resume     --root <path> --operation <id> [--max-polls <1..720>] [--poll-ms <0..60000>]
download   --root <path> --operation <id> [--redownload-missing]
attach-task --root <path> --operation <id> --task <provider-id> --confirm-task-link
doctor     --root <path>

New plans default to h3-inline-ir: every video POST sends context_ir_enabled=true.
generate requires authorization for video generation including inline IR; planning is offline.
Legacy independent IR commands remain available for text tasks and recovery. IR never automatically creates video.
generate refuses false-IR plans: replan the original episode with h3-inline-ir. Use resume for existing tasks.
resume/status/download never create a task or change its original parameters.
init/import/plan/status/doctor work without an API key. Remote operations use METASO_API_KEY or this installation's encrypted credential.
JSON output is the default. --json is accepted. No global setup or old installation is touched.
`;
type Value = string | boolean | undefined;
function required(values: Record<string, Value>, name: string): string {
  const value = values[name]; if (typeof value !== 'string' || !value) fail('CLI_ARGUMENT', `--${name} is required.`); return value;
}
function number(values: Record<string, Value>, name: string): number | undefined {
  const value = values[name]; if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) fail('CLI_ARGUMENT', `--${name} must be a nonnegative integer.`);
  return Number(value);
}
function durationNumber(values: Record<string, Value>): number {
  const value = required(values, 'duration');
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) fail('CLI_ARGUMENT', '--duration must be a plain positive decimal number of seconds.');
  const target = Number(value);
  // Reuse the import rule so the CLI never accepts a value the manifest cannot persist.
  normalizeTargetDurationSeconds(target, '--duration');
  return target;
}
const flags: Record<string, { strings?: string[]; booleans?: string[] }> = {
  'auth status': {},
  init: { strings: ['name'] }, import: { strings: ['draft', 'file', 'kind', 'episode', 'duration'], booleans: ['replace'] },
  'assets list': {}, 'assets register': { strings: ['id', 'file', 'url', 'provenance', 'expected-sha256'] },
  plan: { strings: ['episode', 'workflow', 'from-context-ir', 'review'] }, generate: { strings: ['plan', 'segment', 'retry-of', 'max-polls', 'poll-ms'], booleans: ['confirm', 'submit-only'] },
  'context-ir': { strings: ['plan', 'segment', 'retry-of', 'max-polls', 'poll-ms'], booleans: ['confirm', 'submit-only'] },
  status: { strings: ['operation'], booleans: ['remote'] },
  resume: { strings: ['operation', 'max-polls', 'poll-ms'] }, download: { strings: ['operation'], booleans: ['redownload-missing'] },
  'attach-task': { strings: ['operation', 'task'], booleans: ['confirm-task-link'] }, doctor: {},
};
function pollOptions(v: Record<string, Value>) {
  const maxPolls = number(v, 'max-polls'), pollIntervalMs = number(v, 'poll-ms');
  if (maxPolls !== undefined && (maxPolls < 1 || maxPolls > 720)) fail('CLI_ARGUMENT', '--max-polls must be 1–720.');
  if (pollIntervalMs !== undefined && pollIntervalMs > 60000) fail('CLI_ARGUMENT', '--poll-ms must be 0–60000.');
  return { ...(maxPolls !== undefined ? { maxPolls } : {}), ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}) };
}
function jobExit(job: { status: string; lastError?: unknown }) { return ['failed', 'cancelled', 'submit_unknown', 'query_unknown'].includes(job.status) || job.lastError ? 2 : 0; }
export interface CliResult { exitCode: number; data: unknown }
export async function runCli(args: string[], injected?: JobDependencies & { irClient?: ContextIrClient; irPersistence?: IrPersistence }): Promise<CliResult> {
  try {
    if (!args.length || args.includes('--help') || args[0] === 'help') return { exitCode: 0, data: HELP };
    if (args[0] === '--version') return { exitCode: 0, data: '0.1.0' };
    const count = ['assets', 'auth'].includes(args[0] ?? '') ? 2 : 1, command = args.slice(0, count).join(' '), spec = flags[command];
    if (!spec) fail('CLI_ARGUMENT', 'Unknown command. Run --help.');
    const options: Record<string, { type: 'string' | 'boolean' }> = { root: { type: 'string' }, json: { type: 'boolean' } };
    for (const name of spec.strings ?? []) options[name] = { type: 'string' };
    for (const name of spec.booleans ?? []) options[name] = { type: 'boolean' };
    let v: Record<string, Value>;
    try { v = parseArgs({ args: args.slice(count), options, strict: true, allowPositionals: false }).values as Record<string, Value>; }
    catch { return fail('CLI_ARGUMENT', 'Invalid command options. Run --help; values and secrets are not echoed.'); }
    if (command === 'auth status') return { exitCode: 0, data: { ...(await credentialStatus()), provider: 'Metaso', model: 'MiniMax-H3', liveCheckPerformed: false } };
    const root = resolve(required(v, 'root'));
    const deps = async () => injected ?? { client: new MetasoClient(await loadApiKey()) };
    const irDeps = async (): Promise<IrDependencies> => {
      if (!injected) return { client: new MetasoClient(await loadApiKey()) };
      if (!injected.irClient) fail('IR_CLIENT_MISSING', 'Injected dependencies require a separate IR client.');
      return { client: injected.irClient, fetcher: injected.fetcher, persistence: injected.irPersistence, sleep: injected.sleep };
    };
    if (command === 'init') return { exitCode: 0, data: await initializeStory(root, typeof v.name === 'string' ? v.name : basename(root)) };
    if (command === 'import') {
      let draft: unknown;
      if (v.draft) {
        if (['file', 'kind', 'episode', 'duration'].some(k => v[k] !== undefined)) fail('CLI_ARGUMENT', '--draft cannot be combined with single-file import options.');
        const file = resolve(required(v, 'draft')); draft = await readJson(file);
        if (draft && typeof draft === 'object' && 'source' in draft && typeof draft.source === 'string') draft = { ...draft, source: resolve(dirname(file), draft.source) };
      } else {
        const source = resolve(required(v, 'file')), text = normalizeText(await readStable(source));
        draft = { source, kind: required(v, 'kind'), episodeId: required(v, 'episode'), segments: [{ id: 's1', start: 0, end: text.length, duration: durationNumber(v) }] };
      }
      const story = await importStory(root, draft, v.replace === true);
      return { exitCode: 0, data: { projectId: story.projectId, revision: story.revision, episodes: story.episodes.map(e => ({ id: e.id, kind: e.kind, segments: e.segments.length })), assets: await inspectAssets(root) } };
    }
    if (command === 'assets list') return { exitCode: 0, data: await inspectAssets(root) };
    if (command === 'assets register') {
      if (v.provenance !== undefined && !['user', 'imagegen'].includes(String(v.provenance))) fail('CLI_ARGUMENT', 'Unsupported provenance.');
      const asset = await registerAsset(root, required(v, 'id'), { file: v.file as string | undefined, url: v.url as string | undefined, provenance: v.provenance as 'user' | 'imagegen' | undefined, expectedSha256: v['expected-sha256'] as string | undefined }, injected?.fetcher);
      return { exitCode: 0, data: { assetId: asset.recipe.assetId, recipeHash: asset.recipeHash, sha256: asset.media?.sha256 } };
    }
    if (command === 'plan') {
      if (v['from-context-ir'] !== undefined || v.review !== undefined) {
        if (v.episode !== undefined || v.workflow !== undefined) fail('CLI_ARGUMENT', '--from-context-ir/--review cannot be combined with --episode/--workflow.');
        return { exitCode: 0, data: await createPlanFromContextIr(root, required(v, 'from-context-ir'), await readJson(resolve(required(v, 'review')))) };
      }
      if (v.workflow !== undefined && v.workflow !== 'h3-inline-ir' && v.workflow !== 'h3-context-ir') fail('CLI_ARGUMENT', '--workflow must be h3-inline-ir or h3-context-ir.');
      return { exitCode: 0, data: await createPlan(root, required(v, 'episode'), v.workflow as 'h3-inline-ir' | 'h3-context-ir' | undefined) };
    }
    if (command === 'context-ir') {
      if (v.confirm !== true) fail('GENERATION_NOT_AUTHORIZED', 'Authorize the independent paid IR stage before using --confirm.');
      const polling = pollOptions(v), planId = required(v, 'plan'), segmentId = required(v, 'segment');
      if (v['retry-of']) parse(z.uuid(), v['retry-of']);
      const dependencies = await irDeps();
      let operation = await submitContextIr(root, planId, segmentId, true, dependencies, v['retry-of'] as string | undefined);
      if (!v['submit-only'] && ['queued', 'running', 'query_unknown', 'enhanced'].includes(operation.status)) operation = await resumeContextIr(root, operation.operationId, dependencies, polling);
      return { exitCode: jobExit(operation), data: operation };
    }
    if (command === 'status' && v.remote) {
      const operationId = required(v, 'operation');
      const job = await operationKind(root, operationId) === 'ir'
        ? await resumeContextIr(root, operationId, await irDeps(), { maxPolls: 1, observeOnly: true })
        : await resume(root, operationId, await deps(), { maxPolls: 1, download: false, observeOnly: true });
      return { exitCode: jobExit(job), data: job };
    }
    if (command === 'status' || command === 'doctor') {
      const story = await loadStory(root), assets = await inspectAssets(root);
      const selected = v.operation ? required(v, 'operation') : undefined, kind = selected ? await operationKind(root, selected) : undefined;
      const jobs = selected ? (kind === 'video' ? [await readJob(root, selected)] : []) : await listJobs(root);
      const contextIrOperations = selected ? (kind === 'ir' ? [await readIrOperation(root, selected)] : []) : await listIrOperations(root);
      if (contextIrOperations.some(ir => jobs.some(job => job.operationId === ir.operationId))) fail('OPERATION_CONFLICT', 'Operation ID exists in both namespaces.');
      return { exitCode: 0, data: { version: '0.1.0', projectId: story.projectId, revision: story.revision, episodes: story.episodes.map(e => e.id), assets, jobs, contextIrOperations,
        ...(command === 'doctor' ? { node: process.version, credentials: await credentialStatus(), missingAssets: assets.filter(a => a.status !== 'ready').map(a => a.assetId), nativeApiVerifiedLive: false } : {}) } };
    }
    if (command === 'attach-task') {
      const operationId = required(v, 'operation'), taskId = required(v, 'task');
      return { exitCode: 0, data: await operationKind(root, operationId) === 'ir'
        ? await attachContextIrTask(root, operationId, taskId, v['confirm-task-link'] === true, await irDeps())
        : await attachTask(root, operationId, taskId, v['confirm-task-link'] === true, await deps()) };
    }
    if (command === 'resume' || command === 'download') {
      const operationId = required(v, 'operation'), polling = pollOptions(v), kind = await operationKind(root, operationId);
      if (kind === 'ir' && command === 'download') fail('IR_NOT_VIDEO', 'IR produces a managed prompt file, not a video to download.');
      const job = kind === 'ir' ? await resumeContextIr(root, operationId, await irDeps(), polling)
        : await resume(root, operationId, await deps(), command === 'download' ? { maxPolls: 1, observeOnly: true, redownloadMissing: v['redownload-missing'] === true } : polling);
      return { exitCode: jobExit(job), data: job };
    }
    if (command === 'generate') {
      if (v.confirm !== true) fail('GENERATION_NOT_AUTHORIZED', 'Review the plan, then use --confirm only within explicit paid-generation authorization.');
      const polling = pollOptions(v); // Validate every execution option before any paid request.
      const plan = await loadPlan(root, required(v, 'plan'));
      if (plan.workflow?.stage === 'prepare') fail('IR_PREPARE_NOT_VIDEO', 'Use context-ir --plan <id> --segment <id> --confirm, review its result, then derive a video plan.');
      if (v['retry-of'] && !v.segment) fail('CLI_ARGUMENT', '--retry-of requires exactly one --segment.');
      if (v['retry-of']) parse(z.uuid(), v['retry-of']);
      const segments = v.segment ? plan.segments.filter(s => s.segmentId === v.segment) : plan.segments;
      if (!segments.length) fail('SEGMENT_MISSING', 'Segment does not exist in this plan.');
      if (segments.some(segment => segment.contextIr !== true)) fail('INLINE_IR_REQUIRED', 'New video generation requires context_ir_enabled=true. Replan the original episode with plan --episode <id> --workflow h3-inline-ir; use resume for existing tasks.');
      const dependencies = await deps();
      const jobs: Job[] = [];
      for (const segment of segments) {
        let job = await submit(root, plan.planId, segment.segmentId, true, dependencies, v['retry-of'] as string | undefined);
        if (!v['submit-only'] && ['queued', 'running', 'query_unknown', 'generated', 'downloaded'].includes(job.status)) job = await resume(root, job.operationId, dependencies, polling);
        jobs.push(job); if (jobExit(job)) break;
      }
      return { exitCode: jobs.some(jobExit) ? 2 : 0, data: { jobs } };
    }
    return fail('CLI_ARGUMENT', 'Unsupported command.');
  } catch (error) { return { exitCode: 1, data: { error: publicError(error) } }; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runCli(process.argv.slice(2));
  const data = redact(result.data, [process.env.METASO_API_KEY ?? '']);
  process.stdout.write(typeof data === 'string' ? `${data}\n` : `${JSON.stringify(data, null, 2)}\n`);
  process.exitCode = result.exitCode;
}
