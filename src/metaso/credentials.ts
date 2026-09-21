import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { fail } from '../core/errors.js';
import { exists, safePath } from '../storage/paths.js';
import { readJson, writeJson } from '../storage/io.js';

// Bound to this installation, never to the story root, old package or shared user configuration.
export const LOCAL_CREDENTIAL_FILE = fileURLToPath(new URL('../../.local/metaso-credentials.json', import.meta.url));
const StoredCredential = z.object({ version: z.literal(1), protection: z.literal('windows-dpapi-current-user'),
  ciphertext: z.string().min(1).max(65536).regex(/^[A-Za-z0-9+/]+={0,2}$/u) }).strict();
type Options = { env?: NodeJS.ProcessEnv; file?: string };

function validKey(value: string): string {
  if (!/^[\x21-\x7e]{1,4096}$/u.test(value)) fail('API_KEY_INVALID', 'The Metaso API key must be a nonempty token without whitespace.');
  return value;
}

async function transform(value: string, direction: 'protect' | 'unprotect'): Promise<string> {
  if (process.platform !== 'win32') fail('CREDENTIAL_PLATFORM', 'Use METASO_API_KEY on this platform; the local credential uses Windows user encryption.');
  const operation = direction === 'protect'
    ? "$bytes = [System.Text.Encoding]::UTF8.GetBytes($value); $cipher = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($cipher))"
    : "$bytes = [Convert]::FromBase64String($value); $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($plain))";
  // Only fixed code appears on the command line. Credential bytes travel through private pipes.
  const script = `$ErrorActionPreference = 'Stop'; try { [void][System.Reflection.Assembly]::Load('System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a'); $value = [Console]::In.ReadToEnd(); ${operation} } catch { exit 1 }`;
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise<string>((resolve, reject) => {
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = []; let length = 0;
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Credential operation timed out.')); }, 15000);
    child.on('error', () => { clearTimeout(timeout); reject(new Error('Credential operation unavailable.')); });
    child.stdout.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > 65536) { child.kill(); return; }
      chunks.push(chunk);
    });
    child.stdin.on('error', () => {});
    child.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0 || length > 65536) reject(new Error('Credential operation failed.'));
      else resolve(Buffer.concat(chunks).toString('utf8').trim());
    });
    child.stdin.end(value, 'utf8');
  }).catch(() => fail('CREDENTIAL_UNAVAILABLE', 'Cannot access the encrypted credential as this Windows user. Configure METASO_API_KEY or reconnect locally.'));
}

export async function credentialStatus(options: Options = {}) {
  const env = options.env ?? process.env;
  if (env.METASO_API_KEY) { validKey(env.METASO_API_KEY); return { configured: true, source: 'environment' as const }; }
  const file = await safePath(options.file ?? LOCAL_CREDENTIAL_FILE);
  if (!await exists(file)) return { configured: false, source: 'none' as const };
  const parsed = StoredCredential.safeParse(await readJson(file));
  if (!parsed.success) fail('CREDENTIAL_INVALID', 'The local encrypted credential is invalid. Reconnect locally.');
  return { configured: true, source: 'local-encrypted' as const };
}

export async function loadApiKey(options: Options = {}): Promise<string> {
  const env = options.env ?? process.env;
  if (env.METASO_API_KEY) return validKey(env.METASO_API_KEY);
  const file = await safePath(options.file ?? LOCAL_CREDENTIAL_FILE);
  if (!await exists(file)) fail('API_KEY_MISSING', 'Set METASO_API_KEY or connect this installation to Metaso.');
  const parsed = StoredCredential.safeParse(await readJson(file));
  if (!parsed.success) fail('CREDENTIAL_INVALID', 'The local encrypted credential is invalid. Reconnect locally.');
  return validKey(await transform(parsed.data.ciphertext, 'unprotect'));
}

export async function saveLocalApiKey(value: string, file = LOCAL_CREDENTIAL_FILE): Promise<void> {
  validKey(value);
  await safePath(file);
  if (await exists(file)) fail('CREDENTIAL_EXISTS', 'A local credential already exists; preserve it and use METASO_API_KEY to override explicitly.');
  const ciphertext = await transform(value, 'protect');
  // Check decryption before persisting; never store the plaintext key.
  if (await transform(ciphertext, 'unprotect') !== value) fail('CREDENTIAL_UNAVAILABLE', 'Credential encryption verification failed.');
  await writeJson(file, StoredCredential.parse({ version: 1, protection: 'windows-dpapi-current-user', ciphertext }));
}
