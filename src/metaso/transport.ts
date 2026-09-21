import { fail } from '../core/errors.js';
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export function publicHttps(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { return fail('INVALID_URL', 'Expected an absolute public HTTPS URL.'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !host.includes('.') || host.endsWith('.local') || host.endsWith('.localhost') || host.startsWith('[') || /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/u.test(host)) {
    fail('INVALID_URL', 'Expected a public HTTPS URL without embedded credentials.');
  }
  return url.href;
}
export async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > limit)) fail('RESPONSE_LIMIT', 'Response exceeds its size limit.');
  if (!response.body) fail('EMPTY_RESPONSE', 'Response body is absent.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.length;
      if (size > limit) fail('RESPONSE_LIMIT', 'Response exceeds its size limit.');
      chunks.push(item.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  // fetch transparently decompresses. Content-Length applies to compressed transfer bytes.
  if (declared && !response.headers.get('content-encoding') && Number(declared) !== size) fail('DOWNLOAD_TRUNCATED', 'Response length does not match metadata.');
  return Buffer.concat(chunks);
}
export async function fetchImage(url: string, fetcher: Fetch = fetch): Promise<Buffer> {
  return fetchMedia(url, 30 * 1024 * 1024, fetcher);
}
export async function fetchMedia(url: string, limit: number, fetcher: Fetch = fetch): Promise<Buffer> {
  let response: Response;
  try { response = await fetcher(publicHttps(url), { redirect: 'error', signal: AbortSignal.timeout(30000) }); }
  catch { return fail('ASSET_FETCH_FAILED', 'Cannot fetch the public media; no credentials were forwarded.'); }
  if (!response.ok) fail('ASSET_FETCH_FAILED', 'Media URL did not return a successful response.');
  return boundedBody(response, limit);
}
