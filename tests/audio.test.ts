import { expect, it } from 'vitest';
import { inspectAudio, MAX_AUDIO_BYTES } from '../src/assets/audio.js';
import { wav, mp3Frames } from './audio-fixtures.js';

it('validates PCM and float WAV sample metadata and VBR MP3 frames', () => {
  expect(inspectAudio(wav())).toEqual({ mime: 'audio/wav', duration: 3, sampleRate: 8000, channels: 1 });
  expect(inspectAudio(wav(4, 0, 3)).duration).toBe(4);
  expect(inspectAudio(mp3Frames()).duration).toBe(120 * 1152 / 44100);
  expect(inspectAudio(mp3Frames(120, true)).duration).toBe(119 * 1152 / 44100);
  const id3 = Buffer.from([73,68,51,4,0,0,0,0,0,3,0,0,0]);
  const tag = Buffer.alloc(128); tag.write('TAG');
  expect(inspectAudio(Buffer.concat([id3, mp3Frames(), tag])).mime).toBe('audio/mpeg');
});
it('rejects partial containers, frames, false metadata and unsupported media', () => {
  const badAlign = wav(); badAlign.writeUInt16LE(1, 32);
  const badXing = mp3Frames(120, true); badXing.writeUInt32BE(800, 44);
  const badFormat = wav(); badFormat.writeUInt16LE(6, 20);
  const badId3 = Buffer.from([73,68,51,4,0,0,255,0,0,0]);
  for (const bytes of [Buffer.from('not audio'), wav().subarray(0, -1), mp3Frames().subarray(0, -1), badAlign, badXing, badFormat, badId3]) expect(() => inspectAudio(bytes)).toThrow();
});
it('enforces file and duration limits without trimming the reference', () => {
  for (const seconds of [1, 16]) expect(() => inspectAudio(wav(seconds))).toThrow(expect.objectContaining({ code: 'AUDIO_DURATION' }));
  expect(inspectAudio(wav(2)).duration).toBe(2); expect(inspectAudio(wav(15)).duration).toBe(15);
  expect(() => inspectAudio(Buffer.alloc(MAX_AUDIO_BYTES + 1))).toThrow(expect.objectContaining({ code: 'AUDIO_LIMIT' }));
});
