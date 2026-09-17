import { expect, it } from 'vitest';
import { canonicalSha256, sha256Hex } from '../src/storage/canonical.js';
import { hasUsableFileIdentity, sameFileIdentity } from '../src/storage/file-identity.js';
it('canonical hashes preserve array order and text bytes', () => {
  expect(canonicalSha256({ b: 2, a: 1 })).toBe(canonicalSha256({ a: 1, b: 2 }));
  expect(canonicalSha256([1, 2])).not.toBe(canonicalSha256([2, 1]));
  expect(sha256Hex('台词\r\n')).not.toBe(sha256Hex('台词\n'));
});
it('uses exact filesystem identities including signed words', () => {
  expect(hasUsableFileIdentity({ dev: 0n, ino: -1n })).toBe(true);
  expect(hasUsableFileIdentity({ dev: 1n, ino: 0n })).toBe(false);
  expect(sameFileIdentity({ dev: 1n, ino: -1n }, { dev: 1n, ino: (1n << 64n) - 1n })).toBe(false);
});
