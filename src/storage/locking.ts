import { open, unlink, lstat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fail, isCode } from '../core/errors.js';
import { exists, projectPath } from './paths.js';
import { readStable } from './io.js';
import { sameFileIdentity } from './file-identity.js';

const Owner = z.object({ token: z.uuid(), pid: z.number().int().positive(), host: z.string(), createdAt: z.iso.datetime() }).strict();
async function owner(file: string) {
  try { return Owner.parse(JSON.parse((await readStable(file, 4096)).toString('utf8'))); }
  catch { return fail('LOCK_UNKNOWN', 'Lock ownership is unreadable. Preserve the lock and inspect it before recovery.'); }
}
function dead(pid: number): boolean {
  try { process.kill(pid, 0); return false; } catch (e) { return isCode(e, 'ESRCH'); }
}
export async function withProjectLock<T>(root: string, work: (assertOwned: () => Promise<void>) => Promise<T>): Promise<T> {
  const file = await projectPath(root, '.metasocli/project.lock');
  const recovery = await projectPath(root, '.metasocli/recovery.lock');
  if (await exists(recovery)) fail('LOCK_BUSY', 'Lock recovery is active or interrupted; inspect recovery.lock.');
  let handle;
  try { handle = await open(file, 'wx', 0o600); }
  catch (e) {
    if (!isCode(e, 'EEXIST')) throw e;
    const observed = await owner(file);
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
      await projectPath(root, '.metasocli/project.lock');
      if (await exists(recovery) || !sameFileIdentity(identity, await lstat(file, { bigint: true })) || (await owner(file)).token !== record.token) {
        fail('LOCK_LOST', 'Project lock ownership changed; stopping side effects.');
      }
    };
    await assertOwned();
    return await work(assertOwned);
  } finally {
    await handle.close();
    const current = await lstat(file, { bigint: true }).catch(() => null);
    if (current && sameFileIdentity(identity, current)) {
      if (!written || (await owner(file)).token === record.token) await unlink(file);
    }
  }
}
