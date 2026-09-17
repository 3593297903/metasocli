import { fail } from '../core/errors.js';
export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
export function inspectImage(bytes: Buffer): { mime: 'image/png' | 'image/jpeg' | 'image/webp'; width: number; height: number } {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) fail('IMAGE_LIMIT', 'Image must be at most 30 MiB.');
  let width = 0, height = 0, mime: 'image/png' | 'image/jpeg' | 'image/webp' = 'image/png';
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
    if (!bytes.subarray(-8, -4).equals(Buffer.from('IEND'))) fail('IMAGE_INVALID', 'PNG is truncated.');
  } else if (bytes.length > 4 && bytes.readUInt16BE(0) === 0xffd8 && bytes.readUInt16BE(bytes.length - 2) === 0xffd9) {
    mime = 'image/jpeg'; let i = 2;
    while (i + 4 <= bytes.length) {
      if (bytes[i] !== 0xff) break;
      while (bytes[i] === 0xff) i++;
      const marker = bytes[i++]!;
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (i + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(i);
      if (length < 2 || i + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        height = bytes.readUInt16BE(i + 3); width = bytes.readUInt16BE(i + 5); break;
      }
      i += length;
    }
  } else if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length) {
    mime = 'image/webp'; const format = bytes.toString('ascii', 12, 16);
    if (format === 'VP8X') {
      width = bytes.readUIntLE(24, 3) + 1; height = bytes.readUIntLE(27, 3) + 1;
    } else if (format === 'VP8 ' && bytes.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
      width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff;
    } else if (format === 'VP8L' && bytes[20] === 0x2f) {
      const packed = bytes.readUInt32LE(21); width = (packed & 0x3fff) + 1; height = ((packed >>> 14) & 0x3fff) + 1;
    }
  }
  if (!width || !height) fail('IMAGE_INVALID', 'Expected a supported PNG, JPEG or WebP image.');
  if (width < 256 || height < 256 || width > 5760 || height > 5760 || width / height < 0.4 || width / height > 2.5) {
    fail('IMAGE_DIMENSIONS', 'H3 images require dimensions 256–5760 and aspect ratio 0.4–2.5.');
  }
  return { mime, width, height };
}
