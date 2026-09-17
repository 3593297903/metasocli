import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeStory, importStory } from '../src/core/project.js';
import { deflateSync } from 'node:zlib';
export const roots: string[] = [];
export async function fixture(text = '林舟：我会把每一句台词完整说完。\n') {
  const parent = await mkdtemp(join(tmpdir(), 'metasocli-test-')); roots.push(parent);
  const root = join(parent, 'story'), source = join(parent, 'source.txt');
  await writeFile(source, text); await initializeStory(root, 'Test');
  return { root, source, text, draft: { episodeId: 'ep-1', kind: 'video-prompts', source, segments: [{ id: 's1', start: 0, end: text.length, duration: 6 }] } };
}
export async function imported(text?: string) { const f = await fixture(text); await importStory(f.root, f.draft); return f; }
export async function cleanup() { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); }
export function png(width = 256, height = 256): Buffer {
  function chunk(name: string, data: Buffer) {
    const body = Buffer.concat([Buffer.from(name), data]); let crc = 0xffffffff;
    for (const n of body) { crc ^= n; for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length); body.copy(result, 4); result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4); return result;
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc(height * (width * 3 + 1)))), chunk('IEND', Buffer.alloc(0))]);
}
export function mp4(duration = 6): Buffer {
  function box(name: string, body: Buffer) { const h = Buffer.alloc(8); h.writeUInt32BE(body.length + 8); h.write(name, 4); return Buffer.concat([h, body]); }
  const mvhd = Buffer.alloc(100); mvhd.writeUInt32BE(1000, 12); mvhd.writeUInt32BE(duration * 1000, 16);
  const tkhd = Buffer.alloc(84); tkhd.writeUInt32BE(768 * 65536, 76); tkhd.writeUInt32BE(1366 * 65536, 80);
  const hdlr = Buffer.alloc(24); hdlr.write('vide', 8);
  return Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isom')), box('moov', Buffer.concat([box('mvhd', mvhd), box('trak', Buffer.concat([box('tkhd', tkhd), box('mdia', box('hdlr', hdlr))]))])), box('mdat', Buffer.alloc(64, 1))]);
}
