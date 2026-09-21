export function wav(seconds = 3, value = 0, format = 1): Buffer {
  const rate = 8000, channels = 1, bits = format === 3 ? 32 : 16, align = channels * bits / 8;
  const b = Buffer.alloc(44 + seconds * rate * align, value);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(format, 20); b.writeUInt16LE(channels, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * align, 28);
  b.writeUInt16LE(align, 32); b.writeUInt16LE(bits, 34); b.write('data', 36); b.writeUInt32LE(b.length - 44, 40);
  return b;
}
export function mp3Frames(count = 120, xing = false): Buffer {
  // Alternating valid Layer III frame sizes exercise variable bit rates without a decoder dependency.
  const frames = Array.from({ length: count }, (_, i) => {
    const high = i % 2 === 1, b = Buffer.alloc(Math.floor(144 * (high ? 160000 : 128000) / 44100));
    b.set([0xff, 0xfb, high ? 0xa0 : 0x90, 0]); return b;
  });
  if (xing) { const b = frames[0]!; b.write('Xing', 36); b.writeUInt32BE(1, 40); b.writeUInt32BE(count - 1, 44); }
  return Buffer.concat(frames);
}
