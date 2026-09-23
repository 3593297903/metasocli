import { open, unlink, lstat, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fail, isCode } from '../core/errors.js';
import { exists, pathIdentity, projectPath, safePath } from './paths.js';
import { readStable } from './io.js';
import { sameFileIdentity } from './file-identity.js';
import type { FileHandle } from 'node:fs/promises';

export const Owner = z.object({ token: z.uuid(), pid: z.number().int().positive(), host: z.string(), createdAt: z.iso.datetime() }).strict();
async function owner(file: string) {
  // O_EXCL creates the file before its owner JSON has been flushed. A concurrent reader
  // may see that short interval; bounded rereads never delete or steal an unreadable lock.
  for (let attempt = 0; ; attempt++) {
    try { return Owner.parse(JSON.parse((await readStable(file, 4096)).toString('utf8'))); }
    catch (error) {
      if (isCode(error, 'ENOENT')) throw error;
      if (attempt >= 4) return fail('LOCK_UNKNOWN', 'Lock ownership is unreadable. Preserve the lock and inspect it before recovery.');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}
function dead(pid: number): boolean {
  try { process.kill(pid, 0); return false; } catch (e) { return isCode(e, 'ESRCH'); }
}
export async function liveLease(file: string): Promise<z.infer<typeof Owner> | undefined> {
  try { await safePath(file); }
  catch (error) { if (isCode(error, 'ENOENT') && !await exists(file)) return undefined; throw error; }
  if (!await exists(file)) return undefined;
  let record;
  try { record = await owner(file); } catch (error) { if (!await exists(file)) return undefined; throw error; }
  return record.host === hostname() && dead(record.pid) ? undefined : record;
}
export interface Lease { token: string; assertOwned(): Promise<void>; release(): Promise<void> }
export async function acquireLease(file: string, recovery = `${file}.recovery`): Promise<Lease> {
  // Another owner may unlink the lock between safePath's lstat and realpath.
  // Revalidate the full path once; never remove an uncertain owner's file.
  try { await safePath(file); }
  catch (error) { if (!isCode(error, 'ENOENT')) throw error; await safePath(file); }
  await mkdir(dirname(file), { recursive: true });
  if (await exists(recovery)) fail('LOCK_BUSY', 'Lock recovery is active or interrupted; inspect recovery.lock.');
  let handle: FileHandle;
  try { handle = await open(file, 'wx', 0o600); }
  catch (e) {
    if (!isCode(e, 'EEXIST')) throw e;
    let observed;
    try { observed = await owner(file); }
    catch (error) { if (isCode(error, 'ENOENT')) fail('LOCK_BUSY', 'Lock was released during acquisition; retry acquisition.'); throw error; }
    if (observed.host !== hostname() || !dead(observed.pid)) fail('LOCK_BUSY', 'Another process owns this project.');
    // All recovering processes serialize here; an acquirer rechecks this gate before use.
    let gate;
    try { gate = await open(recovery, 'wx', 0o600); } catch { return fail('LOCK_BUSY', 'Another process is recovering the project lock.'); }
    try {
      await gate.writeFile(JSON.stringify({ pid: process.pid, token: observed.token })); await gate.sync();
      const current = await owner(file);
      if (current.token !== observed.token || !dead(current.pid)) fail('LOCK_BUSY', 'Lock owner changed during recovery.');
      await unlink(file);
      handle = await open(file, 'wx', 0o600);
    } finally { await gate.close(); await unlink(recovery); }
  }
  const identity = await handle.stat({ bigint: true });
  const record = { token: randomUUID(), pid: process.pid, host: hostname(), createdAt: new Date().toISOString() };
  let written = false;
  try {
    await handle.writeFile(JSON.stringify(record)); await handle.sync(); written = true;
    const assertOwned = async () => {
      await safePath(file);
      if (await exists(recovery) || !sameFileIdentity(identity, await lstat(file, { bigint: true })) || (await owner(file)).token !== record.token) {
        fail('LOCK_LOST', 'Project lock ownership changed; stopping side effects.');
      }
    };
    await assertOwned();
    return { token: record.token, assertOwned, release };
  } catch (error) { await release(); throw error; }
  async function release() {
    await handle.close();
    const current = await lstat(file, { bigint: true }).catch(() => null);
    if (current && sameFileIdentity(identity, current)) {
      if (!written || (await owner(file)).token === record.token) await unlink(file);
    }
  }
}
export async function withProjectLock<T>(root: string, work: (assertOwned: () => Promise<void>) => Promise<T>): Promise<T> {
  const lease = await acquireLease(await projectPath(root, '.metasocli/project.lock'), await projectPath(root, '.metasocli/recovery.lock'));
  try { return await work(lease.assertOwned); } finally { await lease.release(); }
}
const queues = new Map<string, Promise<unknown>>();
/** Serializes short writes in this process; never enqueue network waits here. */
export async function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(work); queues.set(key, next);
  try { return await next; } finally { if (queues.get(key) === next) queues.delete(key); }
}
export async function waitLease(file: string, waitMs = 10000): Promise<Lease> {
  const until = Date.now() + waitMs;
  for (;;) {
    try { return await acquireLease(file); }
    catch (error) { if (!isCode(error, 'LOCK_BUSY') || Date.now() >= until) throw error; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
export function withProjectWrite<T>(root: string, work: (assertOwned: () => Promise<void>) => Promise<T>): Promise<T> {
  return serialized(`project:${pathIdentity(root)}`, async () => {
    const until = Date.now() + 10000;
    let lease: Lease;
    for (;;) {
      try { lease = await acquireLease(await projectPath(root, '.metasocli/project.lock'), await projectPath(root, '.metasocli/recovery.lock')); break; }
      catch (error) {
        if (!isCode(error, 'LOCK_BUSY') || Date.now() >= until || (await liveLease(await projectPath(root, '.metasocli/project.lock')))?.pid === process.pid) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    try { return await work(lease.assertOwned); } finally { await lease.release(); }
  });
}
