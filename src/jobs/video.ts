import { open, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Output, type Job, type SavedOutput } from '../contracts/job.js';
import { parse } from '../contracts/story.js';
import { fail } from '../core/errors.js';
import { exists, projectPath } from '../storage/paths.js';
import { readJson, writeJson, syncDirectory } from '../storage/io.js';
import { sameFileIdentity } from '../storage/file-identity.js';
import { publicHttps, type Fetch } from '../metaso/transport.js';

export const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
interface Box { kind: string; start: number; end: number; body: number }
function boxes(buffer: Buffer): Box[] {
  const result = []; let p = 0;
  while (p < buffer.length) {
    if (p + 8 > buffer.length) fail('VIDEO_INVALID', 'Truncated MP4 box.');
    let size = buffer.readUInt32BE(p), header = 8;
    if (size === 1) {
      if (p + 16 > buffer.length) fail('VIDEO_INVALID', 'Truncated MP4 extended box.');
      const large = buffer.readBigUInt64BE(p + 8);
      if (large > BigInt(MAX_VIDEO_BYTES)) fail('VIDEO_INVALID', 'Invalid MP4 box size.');
      size = Number(large); header = 16;
    }
    if (size === 0) size = buffer.length - p;
    if (size < header || p + size > buffer.length) fail('VIDEO_INVALID', 'Invalid MP4 box bounds.');
    result.push({ kind: buffer.toString('ascii', p + 4, p + 8), start: p, body: p + header, end: p + size }); p += size;
  }
  return result;
}
function child(buffer: Buffer, name: string): Buffer | undefined { const box = boxes(buffer).find(b => b.kind === name); return box ? buffer.subarray(box.body, box.end) : undefined; }
function movieMetadata(moov: Buffer) {
  const mvhd = child(moov, 'mvhd');
  if (!mvhd || mvhd.length < 20 || ![0, 1].includes(mvhd[0]!)) fail('VIDEO_INVALID', 'MP4 movie timing metadata is missing.');
  const v1 = mvhd[0] === 1;
  if (v1 && mvhd.length < 32) fail('VIDEO_INVALID', 'MP4 timing metadata is truncated.');
  const timescale = mvhd.readUInt32BE(v1 ? 20 : 12);
  const duration = (v1 ? Number(mvhd.readBigUInt64BE(24)) : mvhd.readUInt32BE(16)) / timescale;
  if (!Number.isFinite(duration) || duration <= 0) fail('VIDEO_INVALID', 'MP4 duration is invalid.');
  for (const box of boxes(moov).filter(b => b.kind === 'trak')) {
    const track = moov.subarray(box.body, box.end), mdia = child(track, 'mdia'), tkhd = child(track, 'tkhd');
    const hdlr = mdia ? child(mdia, 'hdlr') : undefined;
    if (!hdlr || hdlr.length < 12 || hdlr.toString('ascii', 8, 12) !== 'vide' || !tkhd || tkhd.length < 84) continue;
    const width = Math.round(tkhd.readUInt32BE(tkhd.length - 8) / 65536), height = Math.round(tkhd.readUInt32BE(tkhd.length - 4) / 65536);
    if (width <= 0 || height <= 0 || width > 8192 || height > 8192) fail('VIDEO_INVALID', 'MP4 video dimensions are invalid.');
    return { width, height, duration };
  }
  return fail('VIDEO_INVALID', 'MP4 has no video track metadata.');
}
/** Stream hash and inspect bounded MP4 metadata; does not claim full codec decoding. */
export async function inspectVideo(file: string): Promise<Omit<SavedOutput, 'path'>> {
  const handle = await open(file, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    const size = Number(before.size);
    if (!before.isFile() || size > MAX_VIDEO_BYTES || size < 32) fail('VIDEO_INVALID', 'Video size is invalid.');
    const hash = createHash('sha256'), buffer = Buffer.alloc(65536); let total = 0;
    for (;;) { const part = await handle.read(buffer, 0, buffer.length, total); if (!part.bytesRead) break; total += part.bytesRead; if (total > MAX_VIDEO_BYTES) fail('VIDEO_INVALID', 'Video exceeded the size bound.'); hash.update(buffer.subarray(0, part.bytesRead)); }
    let p = 0, ftyp = false, mdat = false, moov: Buffer | undefined;
    while (p < size) {
      const header = Buffer.alloc(16); const got = await handle.read(header, 0, Math.min(16, size - p), p);
      if (got.bytesRead < 8) fail('VIDEO_INVALID', 'Video container is truncated.');
      let length = header.readUInt32BE(0), headerSize = 8;
      if (length === 1) { if (got.bytesRead < 16) fail('VIDEO_INVALID', 'Truncated extended box.'); const wide = header.readBigUInt64BE(8); if (wide > BigInt(size)) fail('VIDEO_INVALID', 'Oversized video box.'); length = Number(wide); headerSize = 16; }
      if (length === 0) length = size - p;
      if (length < headerSize || p + length > size) fail('VIDEO_INVALID', 'Video container has invalid bounds.');
      const kind = header.toString('ascii', 4, 8);
      if (kind === 'ftyp') ftyp = length >= 16;
      if (kind === 'mdat') mdat = length > headerSize;
      if (kind === 'moov') {
        if (moov || length > 8 * 1024 * 1024) fail('VIDEO_INVALID', 'Unsupported movie metadata size or layout.');
        moov = Buffer.alloc(length - headerSize); const gotMoov = await handle.read(moov, 0, moov.length, p + headerSize);
        if (gotMoov.bytesRead !== moov.length) fail('VIDEO_INVALID', 'Movie metadata is truncated.');
      }
      p += length;
    }
    if (!ftyp || !mdat || !moov) fail('VIDEO_INVALID', 'Expected MP4 format, movie metadata and media data.');
    const metadata = movieMetadata(moov), after = await handle.stat({ bigint: true });
    if (total !== size || !sameFileIdentity(before, after) || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.size !== after.size) fail('VIDEO_CHANGED', 'Video changed during verification.');
    return { bytes: size, sha256: hash.digest('hex'), ...metadata };
  } finally { await handle.close(); }
}
const DownloadReceipt = z.object({ operationId: z.uuid(), taskId: z.string(), requestHash: z.string(), output: Output }).strict();
const outputPath = (job: Job) => `outputs/${job.episodeId}/${job.segmentId}-${job.operationId}.mp4`;
const downloadReceipt = (job: Job) => `.metasocli/receipts/${job.operationId}-download.json`;
export async function reconcileOutput(root: string, job: Job): Promise<SavedOutput | undefined> {
  const target = await projectPath(root, outputPath(job));
  if (!await exists(target)) {
    if (job.status === 'downloaded') fail('OUTPUT_MISSING', 'Recorded video is missing. Restore the file or explicitly download the same task again.');
    return undefined;
  }
  const receiptFile = await projectPath(root, downloadReceipt(job));
  if (!await exists(receiptFile)) fail('OUTPUT_CONFLICT', 'Output exists without its own verification receipt.');
  const receipt = parse(DownloadReceipt, await readJson(receiptFile));
  if (receipt.operationId !== job.operationId || receipt.taskId !== job.taskId || receipt.requestHash !== job.requestHash || receipt.output.path !== outputPath(job)) fail('OUTPUT_CONFLICT', 'Output receipt belongs to another operation.');
  const actual = await inspectVideo(target);
  if (actual.sha256 !== receipt.output.sha256 || actual.bytes !== receipt.output.bytes) fail('OUTPUT_CHANGED', 'Saved video differs from its download receipt.');
  return { path: outputPath(job), ...actual };
}
export async function downloadVideo(root: string, job: Job, url: string, duration: number, fetcher: Fetch = fetch, ratio = 'adaptive'): Promise<SavedOutput> {
  const existing = await reconcileOutput(root, job); if (existing) return existing;
  let response: Response | undefined, current = publicHttps(url);
  for (let redirects = 0; redirects <= 3; redirects++) {
    try { response = await fetcher(current, { redirect: 'manual', signal: AbortSignal.timeout(120000), headers: { Accept: 'video/mp4,application/octet-stream' } }); }
    catch { return fail('DOWNLOAD_FAILED', 'Video download could not connect; resume the same task.'); }
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location'); await response.body?.cancel();
    if (!location || redirects === 3) fail('DOWNLOAD_REDIRECT', 'Video download redirect limit reached.');
    current = publicHttps(new URL(location, current).href);
  }
  if (!response?.ok || !response.body) fail('DOWNLOAD_FAILED', 'Video download was rejected; query the same task for a fresh URL.');
  const contentType = response.headers.get('content-type')?.split(';')[0];
  if (contentType && !['video/mp4', 'application/octet-stream'].includes(contentType)) fail('VIDEO_INVALID', 'Video response has an unexpected media type.');
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/u.test(length) || Number(length) > MAX_VIDEO_BYTES)) fail('VIDEO_INVALID', 'Video download exceeds its size limit.');
  const target = await projectPath(root, outputPath(job)); await mkdir(dirname(target), { recursive: true });
  const temp = await projectPath(root, `${outputPath(job)}.part-${randomUUID()}`);
  const handle = await open(temp, 'wx', 0o600), reader = response.body.getReader(); let size = 0, moved = false;
  try {
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > MAX_VIDEO_BYTES) fail('VIDEO_INVALID', 'Video exceeds its size limit.'); await handle.writeFile(chunk.value); }
    if (length && !response.headers.get('content-encoding') && Number(length) !== size) fail('DOWNLOAD_TRUNCATED', 'Video body does not match Content-Length.');
    await handle.sync(); await handle.close();
    const metadata = await inspectVideo(temp);
    if (Math.abs(metadata.duration - duration) > 1) fail('VIDEO_DURATION', 'Downloaded video duration differs from the planned duration.');
    if (ratio !== 'adaptive') {
      const [w, h] = ratio.split(':').map(Number);
      if (Math.abs(metadata.width / metadata.height / (w! / h!) - 1) > 0.03) fail('VIDEO_RATIO', 'Downloaded video aspect ratio differs from the plan.');
    }
    const output = { path: outputPath(job), ...metadata };
    await writeJson(await projectPath(root, downloadReceipt(job)), { operationId: job.operationId, taskId: job.taskId, requestHash: job.requestHash, output });
    if (await exists(await projectPath(root, outputPath(job)))) fail('OUTPUT_CONFLICT', 'Output appeared during download.');
    await rename(temp, target); moved = true; await syncDirectory(dirname(target));
    return output;
  } finally {
    await reader.cancel().catch(() => {}); reader.releaseLock(); await handle.close();
    if (!moved) await unlink(temp).catch(() => {});
  }
}
