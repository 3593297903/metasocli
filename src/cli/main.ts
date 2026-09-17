#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { initializeStory, importStory, loadStory } from '../core/project.js';
import { createPlan, loadPlan } from '../core/planning.js';
import { inspectAssets, registerAsset } from '../assets/registry.js';
import { fail, publicError } from '../core/errors.js';
import { readJson, readStable } from '../storage/io.js';
import { normalizeText } from '../story/text.js';
import { MetasoClient, redact } from '../metaso/client.js';
import { listJobs, readJob } from '../jobs/store.js';
import { submit, type JobDependencies } from '../jobs/submit.js';
import { resume, attachTask } from '../jobs/resume.js';
import type { Job } from '../contracts/job.js';

export const HELP = `metasocli 0.1.0 — independent Metaso MiniMax-H3 CLI
All story commands require --root <dedicated-story-directory>.

init       --root <path> [--name <name>]
import     --root <path> --draft <json> [--replace]
import     --root <path> --file <utf8.txt> --kind script|video-prompts --episode <id> --duration <4..15>
assets list     --root <path>
assets register --root <path> --id <asset-id> (--file <image>|--url <public-https-url>) [--provenance user|imagegen]
plan       --root <path> --episode <id>
generate   --root <path> --plan <id> --confirm [--segment <id>] [--submit-only] [--retry-of <operation-id>]
status     --root <path> [--operation <id>] [--remote]
resume     --root <path> --operation <id> [--max-polls <1..720>] [--poll-ms <0..60000>]
download   --root <path> --operation <id> [--redownload-missing]
attach-task --root <path> --operation <id> --task <provider-id> --confirm-task-link
doctor     --root <path>

generate requires explicit paid-generation authorization; other commands never create a video.
init/import/plan/status/doctor work without an API key. --remote, resume and download require METASO_API_KEY.
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
const flags: Record<string, { strings?: string[]; booleans?: string[] }> = {
  init: { strings: ['name'] }, import: { strings: ['draft', 'file', 'kind', 'episode', 'duration'], booleans: ['replace'] },
  'assets list': {}, 'assets register': { strings: ['id', 'file', 'url', 'provenance'] },
  plan: { strings: ['episode'] }, generate: { strings: ['plan', 'segment', 'retry-of', 'max-polls', 'poll-ms'], booleans: ['confirm', 'submit-only'] },
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
function jobExit(job: Job) { return ['failed', 'cancelled', 'submit_unknown', 'query_unknown'].includes(job.status) || job.lastError ? 2 : 0; }
export interface CliResult { exitCode: number; data: unknown }
export async function runCli(args: string[], injected?: JobDependencies): Promise<CliResult> {
  try {
    if (!args.length || args.includes('--help') || args[0] === 'help') return { exitCode: 0, data: HELP };
    if (args[0] === '--version') return { exitCode: 0, data: '0.1.0' };
    const count = args[0] === 'assets' ? 2 : 1, command = args.slice(0, count).join(' '), spec = flags[command];
    if (!spec) fail('CLI_ARGUMENT', 'Unknown command. Run --help.');
    const options: Record<string, { type: 'string' | 'boolean' }> = { root: { type: 'string' }, json: { type: 'boolean' } };
    for (const name of spec.strings ?? []) options[name] = { type: 'string' };
    for (const name of spec.booleans ?? []) options[name] = { type: 'boolean' };
    let v: Record<string, Value>;
    try { v = parseArgs({ args: args.slice(count), options, strict: true, allowPositionals: false }).values as Record<string, Value>; }
    catch { return fail('CLI_ARGUMENT', 'Invalid command options. Run --help; values and secrets are not echoed.'); }
    const root = resolve(required(v, 'root'));
    const deps = () => injected ?? { client: new MetasoClient(process.env.METASO_API_KEY ?? '') };
    if (command === 'init') return { exitCode: 0, data: await initializeStory(root, typeof v.name === 'string' ? v.name : basename(root)) };
    if (command === 'import') {
      let draft: unknown;
      if (v.draft) {
        if (['file', 'kind', 'episode', 'duration'].some(k => v[k] !== undefined)) fail('CLI_ARGUMENT', '--draft cannot be combined with single-file import options.');
        const file = resolve(required(v, 'draft')); draft = await readJson(file);
        if (draft && typeof draft === 'object' && 'source' in draft && typeof draft.source === 'string') draft = { ...draft, source: resolve(dirname(file), draft.source) };
      } else {
        const source = resolve(required(v, 'file')), text = normalizeText(await readStable(source));
        draft = { source, kind: required(v, 'kind'), episodeId: required(v, 'episode'), segments: [{ id: 's1', start: 0, end: text.length, duration: number(v, 'duration') }] };
      }
      const story = await importStory(root, draft, v.replace === true);
      return { exitCode: 0, data: { projectId: story.projectId, revision: story.revision, episodes: story.episodes.map(e => ({ id: e.id, kind: e.kind, segments: e.segments.length })), assets: await inspectAssets(root) } };
    }
    if (command === 'assets list') return { exitCode: 0, data: await inspectAssets(root) };
    if (command === 'assets register') {
      if (v.provenance !== undefined && !['user', 'imagegen'].includes(String(v.provenance))) fail('CLI_ARGUMENT', 'Unsupported provenance.');
      const asset = await registerAsset(root, required(v, 'id'), { file: v.file as string | undefined, url: v.url as string | undefined, provenance: v.provenance as 'user' | 'imagegen' | undefined }, injected?.fetcher);
      return { exitCode: 0, data: { assetId: asset.recipe.assetId, recipeHash: asset.recipeHash, sha256: asset.media?.sha256 } };
    }
    if (command === 'plan') return { exitCode: 0, data: await createPlan(root, required(v, 'episode')) };
    if (command === 'status' && v.remote) {
      const job = await resume(root, required(v, 'operation'), deps(), { maxPolls: 1, download: false, observeOnly: true });
      return { exitCode: jobExit(job), data: job };
    }
    if (command === 'status' || command === 'doctor') {
      const story = await loadStory(root), assets = await inspectAssets(root);
      const jobs = v.operation ? [await readJob(root, required(v, 'operation'))] : await listJobs(root);
      return { exitCode: 0, data: { version: '0.1.0', projectId: story.projectId, revision: story.revision, episodes: story.episodes.map(e => e.id), assets, jobs,
        ...(command === 'doctor' ? { node: process.version, apiKeyConfigured: Boolean(process.env.METASO_API_KEY), missingAssets: assets.filter(a => a.status !== 'ready').map(a => a.assetId), nativeApiVerifiedLive: false } : {}) } };
    }
    if (command === 'attach-task') return { exitCode: 0, data: await attachTask(root, required(v, 'operation'), required(v, 'task'), v['confirm-task-link'] === true, deps()) };
    if (command === 'resume' || command === 'download') {
      const job = await resume(root, required(v, 'operation'), deps(), command === 'download' ? { maxPolls: 1, observeOnly: true, redownloadMissing: v['redownload-missing'] === true } : pollOptions(v));
      return { exitCode: jobExit(job), data: job };
    }
    if (command === 'generate') {
      if (v.confirm !== true) fail('GENERATION_NOT_AUTHORIZED', 'Review the plan, then use --confirm only within explicit paid-generation authorization.');
      const polling = pollOptions(v); // Validate every execution option before any paid request.
      const plan = await loadPlan(root, required(v, 'plan')), dependencies = deps();
      if (v['retry-of'] && !v.segment) fail('CLI_ARGUMENT', '--retry-of requires exactly one --segment.');
      const segments = v.segment ? plan.segments.filter(s => s.segmentId === v.segment) : plan.segments;
      if (!segments.length) fail('SEGMENT_MISSING', 'Segment does not exist in this plan.');
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
