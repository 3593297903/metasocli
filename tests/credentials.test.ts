import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialStatus, loadApiKey, saveLocalApiKey } from '../src/metaso/credentials.js';
import { cleanup, roots } from './helpers.js';
afterEach(cleanup);

it('prefers the explicit environment and never reads an old project credential', async () => {
  const options = { env: { METASO_API_KEY: 'mk-test-not-a-real-key' }, file: 'E:\\libcli\\credentials.json' };
  expect(await loadApiKey(options)).toBe('mk-test-not-a-real-key');
  expect(await credentialStatus(options)).toEqual({ configured: true, source: 'environment' });
  await expect(loadApiKey({ env: {}, file: options.file })).rejects.toMatchObject({ code: 'LEGACY_ROOT' });
  await expect(loadApiKey({ env: { METASO_API_KEY: 'key\nheader' } })).rejects.toMatchObject({ code: 'API_KEY_INVALID' });
});

it('reports missing or malformed credentials without echoing their contents', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'metasocli-auth-')); roots.push(dir);
  const file = join(dir, 'credentials.json'), options = { env: {}, file };
  expect(await credentialStatus(options)).toEqual({ configured: false, source: 'none' });
  await expect(loadApiKey(options)).rejects.toMatchObject({ code: 'API_KEY_MISSING' });
  await writeFile(file, JSON.stringify({ plaintext: 'do-not-echo' }));
  await expect(loadApiKey(options)).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' });
});

it.skipIf(process.platform !== 'win32')('encrypts for the current Windows user and restores the same key after a fresh read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'metasocli-auth-')); roots.push(dir);
  const file = join(dir, 'credentials.json'), key = 'mk-offline-fixture-not-a-real-api-key';
  await saveLocalApiKey(key, file);
  expect(await readFile(file, 'utf8')).not.toContain(key);
  expect(await credentialStatus({ env: {}, file })).toEqual({ configured: true, source: 'local-encrypted' });
  expect(await loadApiKey({ env: {}, file })).toBe(key);
  await expect(saveLocalApiKey('mk-replacement', file)).rejects.toMatchObject({ code: 'CREDENTIAL_EXISTS' });
  const record = JSON.parse(await readFile(file, 'utf8'));
  record.ciphertext = record.ciphertext.slice(0, -16);
  await writeFile(file, JSON.stringify(record));
  await expect(loadApiKey({ env: {}, file })).rejects.toMatchObject({ code: 'CREDENTIAL_UNAVAILABLE' });
});
