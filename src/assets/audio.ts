import { fail } from '../core/errors.js';

export const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
export interface AudioInfo { mime: 'audio/mpeg' | 'audio/wav'; duration: number; sampleRate: number; channels: number }

/** Structural metadata validation, not speech recognition or a promise of full audio decoding. */
export function inspectAudio(bytes: Buffer): AudioInfo {
  if (!bytes.length || bytes.length > MAX_AUDIO_BYTES) fail('AUDIO_LIMIT', 'Reference audio must be at most 15 MiB.');
  const info = bytes.toString('ascii', 0, 4) === 'RIFF' ? wave(bytes) : mp3(bytes);
  if (info.duration < 2 || info.duration > 15) fail('AUDIO_DURATION', 'Reference audio must be 2–15 seconds; it is not trimmed automatically.');
  return info;
}

function wave(b: Buffer): AudioInfo {
  if (b.length < 44 || b.toString('ascii', 8, 12) !== 'WAVE' || b.readUInt32LE(4) + 8 !== b.length) fail('AUDIO_INVALID', 'WAV container is malformed or truncated.');
  let sampleRate = 0, channels = 0, align = 0, dataSize = 0, formatSeen = false, dataSeen = false;
  let offset = 12;
  while (offset + 8 <= b.length) {
    const name = b.toString('ascii', offset, offset + 4), size = b.readUInt32LE(offset + 4), start = offset + 8;
    if (start + size > b.length) fail('AUDIO_INVALID', 'WAV chunk exceeds its container.');
    if (name === 'fmt ') {
      if (formatSeen || size < 16) fail('AUDIO_INVALID', 'WAV has an invalid format chunk.');
      formatSeen = true;
      let format = b.readUInt16LE(start);
      channels = b.readUInt16LE(start + 2); sampleRate = b.readUInt32LE(start + 4);
      const rate = b.readUInt32LE(start + 8), bits = b.readUInt16LE(start + 14);
      align = b.readUInt16LE(start + 12);
      if (format === 0xfffe) {
        if (size < 40 || b.readUInt16LE(start + 16) < 22 || !b.subarray(start + 26, start + 40).equals(Buffer.from('000000001000800000aa00389b71', 'hex'))) fail('AUDIO_INVALID', 'Unsupported WAV extensible format.');
        format = b.readUInt16LE(start + 24);
      }
      if (![1, 3].includes(format) || !(format === 1 ? [8, 16, 24, 32] : [32, 64]).includes(bits)) fail('AUDIO_INVALID', 'WAV requires PCM or IEEE float encoding.');
      if (![1, 2].includes(channels) || sampleRate < 8000 || sampleRate > 192000 || align !== channels * bits / 8 || rate !== sampleRate * align) fail('AUDIO_INVALID', 'WAV sample metadata is inconsistent.');
    } else if (name === 'data') {
      if (dataSeen) fail('AUDIO_INVALID', 'Multiple WAV data chunks are unsupported.');
      dataSeen = true; dataSize = size;
    }
    offset = start + size + (size % 2);
  }
  if (offset !== b.length || !formatSeen || !dataSeen || !dataSize || dataSize % align) fail('AUDIO_INVALID', 'WAV sample data is incomplete.');
  return { mime: 'audio/wav', duration: dataSize / align / sampleRate, sampleRate, channels };
}

function mp3(b: Buffer): AudioInfo {
  let offset = 0, end = b.length;
  if (b.toString('ascii', 0, 3) === 'ID3') {
    if (b.length < 10 || ![2, 3, 4].includes(b[3]!) || b.subarray(6, 10).some(n => n > 127)) fail('AUDIO_INVALID', 'Invalid MP3 ID3 header.');
    const size = b[6]! * 2097152 + b[7]! * 16384 + b[8]! * 128 + b[9]!;
    offset = 10 + size + (b[3] === 4 && (b[5]! & 0x10) ? 10 : 0);
  }
  if (end >= 128 && b.toString('ascii', end - 128, end - 125) === 'TAG') end -= 128;
  let frames = 0, samples = 0, sampleRate = 0, channels = 0, declaredFrames: number | undefined;
  while (offset + 4 <= end) {
    const h = b.readUInt32BE(offset), version = (h >>> 19) & 3, layer = (h >>> 17) & 3;
    const bitrateIndex = (h >>> 12) & 15, rateIndex = (h >>> 10) & 3;
    if ((h >>> 21) !== 0x7ff || version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) fail('AUDIO_INVALID', 'Expected complete MPEG Layer III audio frames.');
    const rate = [44100, 48000, 32000][rateIndex]! / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const channelCount = ((h >>> 6) & 3) === 3 ? 1 : 2;
    const bitrate = (version === 3 ? [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320] : [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160])[bitrateIndex]! * 1000;
    const length = Math.floor((version === 3 ? 144 : 72) * bitrate / rate) + ((h >>> 9) & 1);
    if (offset + length > end || length < 24 || (frames && (sampleRate !== rate || channels !== channelCount))) fail('AUDIO_INVALID', 'MP3 is truncated or changes its sample format.');
    if (!frames) {
      const side = version === 3 ? (channelCount === 1 ? 17 : 32) : (channelCount === 1 ? 9 : 17);
      const xing = offset + 4 + ((h >>> 16) & 1 ? 0 : 2) + side;
      if (xing + 12 <= offset + length && ['Xing', 'Info'].includes(b.toString('ascii', xing, xing + 4)) && (b.readUInt32BE(xing + 4) & 1)) declaredFrames = b.readUInt32BE(xing + 8);
    }
    sampleRate = rate; channels = channelCount; frames++; samples += version === 3 ? 1152 : 576; offset += length;
  }
  if (offset !== end || frames < 2 || !sampleRate) fail('AUDIO_INVALID', 'MP3 contains no complete audio stream.');
  // A Xing/Info frame is metadata; encoders may count it or exclude it in their declared frame count.
  if (declaredFrames !== undefined) {
    if (declaredFrames !== frames && declaredFrames !== frames - 1) fail('AUDIO_INVALID', 'MP3 frame count does not match its header.');
    samples = samples / frames * declaredFrames;
  }
  return { mime: 'audio/mpeg', duration: samples / sampleRate, sampleRate, channels };
}
