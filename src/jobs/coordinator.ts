import { z } from 'zod';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Hash, parse } from '../contracts/story.js';
import { JobSchema, type Job } from '../contracts/job.js';
import { loadStory } from '../core/project.js';
import { fail } from '../core/errors.js';
import { exists, pathIdentity, safePath, samePath } from '../storage/paths.js';
import { readJson, writeJson } from '../storage/io.js';
import { canonicalSha256 } from '../storage/canonical.js';
import { liveLease, serialized, waitLease } from '../storage/locking.js';
import { listJobs } from './store.js';

const Slot = z.object({ root: z.string(), projectId: z.uuid(), operationId: z.uuid(), requestHash: Hash, inputHash: Hash,
  taskId: z.string().optional(), status: z.enum([...JobSchema.shape.status.options, 'reserved']), updatedAt: z.iso.datetime() }).strict();
const Ledger = z.object({ schemaVersion: z.literal(1), owner: z.literal('metasocli'), hash: Hash,
  projects: z.array(z.object({ root: z.string(), projectId: z.uuid(), retiredAt: z.iso.datetime().optional() }).strict()), slots: z.array(Slot) }).strict();
export type LedgerState = z.infer<typeof Ledger>;
export type SlotRecord = z.infer<typeof Slot>;
export const terminal = (status: string) => ['generated', 'downloaded', 'failed', 'cancelled'].includes(status);
export const occupied = (ledger: LedgerState) => ledger.slots.filter(s => !terminal(s.status));
export const unsafeSlots = (ledger: LedgerState) => ledger.slots.filter(s => ['submit_unknown', 'query_unknown'].includes(s.status));
export function runtimeDirectory(injected?: string) { return resolve(injected ?? process.env.METASO_RUNTIME_DIR ?? join(homedir(), '.metasocli-runtime')); }
async function readLedger(runtime: string): Promise<LedgerState> {
  const file = await safePath(join(runtime, 'video-ledger.json')), marker = await safePath(join(runtime, 'owner.json'));
  if (!await exists(file)) {
    if (await exists(marker)) fail('COORDINATOR_MISSING', 'Shared reservations are missing; preserve runtime and reconcile before creating.');
    return { schemaVersion: 1, owner: 'metasocli', hash: '0'.repeat(64), projects: [], slots: [] };
  }
  const ledger = parse(Ledger, await readJson(file)), { hash, ...base } = ledger;
  if (canonicalSha256(base) !== hash) fail('COORDINATOR_TAMPERED', 'Shared reservation hash mismatch.');
  return ledger;
}
async function saveLedger(runtime: string, ledger: LedgerState) {
  const { hash: _, ...base } = ledger; ledger.hash = canonicalSha256(base);
  await writeJson(await safePath(join(runtime, 'video-ledger.json')), ledger);
  await writeJson(await safePath(join(runtime, 'owner.json')), { owner: 'metasocli', schemaVersion: 1 });
}
export function slotFor(root: string, job: Job): SlotRecord {
  return { root: resolve(root), projectId: job.projectId, operationId: job.operationId, requestHash: job.requestHash, inputHash: job.inputHash,
    ...(job.taskId ? { taskId: job.taskId } : {}), status: job.status, updatedAt: job.updatedAt };
}
/** Migrate equivalent v1 spellings only after hash verification. Never discard a reservation. */
function normalizeRoots(ledger: LedgerState) {
  const projects = new Map<string, LedgerState['projects'][number]>(), rootsById = new Map<string, string>();
  for (const project of ledger.projects) {
    // Keep the access spelling: Node's permission allow-list can be case-sensitive
    // even on Windows. Only identity keys/comparisons are case-folded.
    project.root = resolve(project.root);
    const identity = pathIdentity(project.root), previous = projects.get(identity), previousRoot = rootsById.get(project.projectId);
    if ((previous && previous.projectId !== project.projectId) || (previousRoot && previousRoot !== identity)) {
      fail('COORDINATOR_CONFLICT', 'Registered project and root identities differ. Restore the original project path before recovery.');
    }
    if (!previous) projects.set(identity, project);
    rootsById.set(project.projectId, identity);
  }
  ledger.projects = [...projects.values()];
  const operations = new Set<string>();
  for (const slot of ledger.slots) {
    const project = projects.get(pathIdentity(slot.root));
    if (project?.projectId !== slot.projectId || operations.has(slot.operationId)) {
      fail('COORDINATOR_CONFLICT', 'Reservation has a conflicting project or operation identity.');
    }
    slot.root = project.root;
    operations.add(slot.operationId);
  }
}
async function sync(ledger: LedgerState, root: string) {
  normalizeRoots(ledger);
  const story = await loadStory(root), registered = ledger.projects.find(p => samePath(p.root, root));
  if (registered && registered.projectId !== story.projectId) fail('COORDINATOR_CONFLICT', 'Registered project identity changed.');
  if (ledger.projects.some(p => p.projectId === story.projectId && !samePath(p.root, root))) {
    fail('COORDINATOR_CONFLICT', 'This project identity is registered at another root. Restore the original project path before recovery.');
  }
  if (!registered) ledger.projects.push({ root, projectId: story.projectId });
  for (const project of ledger.projects) {
    await safePath(project.root);
    const slots = ledger.slots.filter(s => samePath(s.root, project.root));
    if (!await exists(project.root)) {
      // A hash-verified terminal ledger is sufficient archival evidence, including
      // v1 records written before retiredAt existed. Empty registration is not proof.
      // Retain every task ID/hash/status; a marker alone can never release capacity.
      if (!slots.length || slots.some(s => !terminal(s.status) || (['generated', 'downloaded'].includes(s.status) && !s.taskId))) {
        fail('COORDINATOR_PROJECT_MISSING', 'A registered project path is missing without complete terminal evidence. Preserve its slots and restore the original directory before creating.');
      }
      project.retiredAt ??= new Date().toISOString();
      continue;
    }
    delete project.retiredAt; // A restored root must pass the original identity and job checks again.
    if ((await loadStory(project.root)).projectId !== project.projectId) fail('COORDINATOR_CONFLICT', 'Registered story no longer has its original identity.');
    const jobs = await listJobs(project.root);
    for (const slot of slots) {
      if (!jobs.some(j => j.operationId === slot.operationId)) { slot.status = 'submit_unknown'; continue; }
    }
    for (const job of jobs) {
      const i = ledger.slots.findIndex(s => s.operationId === job.operationId);
      if (i >= 0) {
        const slot = ledger.slots[i]!;
        if (!samePath(slot.root, project.root) || slot.projectId !== job.projectId || slot.requestHash !== job.requestHash || slot.inputHash !== job.inputHash
          || (slot.taskId && job.taskId && slot.taskId !== job.taskId)) fail('COORDINATOR_CONFLICT', 'Reservation and task identity differ.');
        ledger.slots[i] = slotFor(project.root, job);
      } else if (job.status !== 'prepared') ledger.slots.push(slotFor(project.root, job));
    }
  }
  const ids = ledger.slots.flatMap(s => s.taskId ? [s.taskId] : []);
  if (ids.length !== new Set(ids).size) fail('TASK_LINK_CONFLICT', 'Remote task is registered more than once across projects.');
}
/** Lock order: shared ledger -> short project write. Never acquire this while holding a project lock. */
export async function withCoordinator<T>(root: string, runtime: string, work: (ledger: LedgerState, save: () => Promise<void>) => Promise<T>): Promise<T> {
  root = await safePath(root); runtime = await safePath(runtime);
  return serialized('ledger:' + pathIdentity(runtime), async () => {
    const lease = await waitLease(join(runtime, 'coordinator.lock'));
    try {
      const ledger = await readLedger(runtime); await sync(ledger, root);
      const save = async () => { await lease.assertOwned(); await saveLedger(runtime, ledger); };
      await save();
      return await work(ledger, save);
    } finally { await lease.release(); }
  });
}
export async function reconcileRuntime(root: string, runtime?: string) {
  return withCoordinator(root, runtimeDirectory(runtime), async ledger => ledger);
}
export async function requireScheduler(runtime: string, token?: string) {
  const scheduler = await liveLease(join(runtime, 'batch.lock'));
  if (scheduler && scheduler.token !== token) fail('SCHEDULER_BUSY', 'A batch owns this installation scheduler; wait for it or resume its existing tasks.');
  if (token && scheduler?.token !== token) fail('LOCK_LOST', 'Batch scheduler ownership was lost.');
}
export async function acquireScheduler(runtime: string, waitMs = 30000) {
  return waitLease(await safePath(join(runtime, 'batch.lock')), waitMs);
}
