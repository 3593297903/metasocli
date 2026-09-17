import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail } from '../core/errors.js';
import { safePath } from './paths.js';
import { sameFileIdentity, requireFileIdentity } from './file-identity.js';
import { sha256Hex } from './canonical.js';

export async function readStable(file: string, maxBytes = 8 * 1024 * 1024): Promise<Buffer> {
  const handle = await open(file, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes)) fail('FILE_LIMIT', 'Input must be a bounded regular file.');
    const identity = requireFileIdentity(before, file);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(65536, maxBytes - total + 1));
      const { bytesRead } = await handle.read(chunk);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) fail('FILE_LIMIT', 'Input grew beyond its size limit.');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    if (!sameFileIdentity(identity, after) || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(total) !== after.size) {
      fail('FILE_CHANGED', 'Input changed while reading.');
    }
    return Buffer.concat(chunks);
  } finally { await handle.close(); }
}
export async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(dir, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
/** Caller holds project lock. Flush file, replace atomically, flush directory where supported. */
export async function atomicWrite(target: string, bytes: string | Uint8Array): Promise<void> {
  await safePath(target);
  await mkdir(dirname(target), { recursive: true });
  await safePath(target);
  const temp = `${target}.tmp-${randomUUID()}`;
  const handle = await open(temp, 'wx', 0o600);
  let renamed = false;
  try {
    await handle.writeFile(bytes); await handle.sync(); await handle.close();
    await safePath(target);
    await rename(temp, target); renamed = true;
    await syncDirectory(dirname(target));
  } finally {
    await handle.close();
    if (!renamed) await unlink(temp).catch(() => {});
  }
}
export async function writeJson(target: string, value: unknown): Promise<void> {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) fail('FILE_LIMIT', 'Structured record exceeds the local 8 MiB limit. Split the episode.');
  await atomicWrite(target, text);
}
export async function readJson(file: string): Promise<unknown> {
  try { return JSON.parse((await readStable(file)).toString('utf8')); }
  catch (e) { if (e instanceof SyntaxError) fail('INVALID_JSON', 'Stored JSON is invalid; preserve it for recovery.'); throw e; }
}
export async function fileHash(file: string, limit?: number): Promise<string> { return sha256Hex(await readStable(file, limit)); }
