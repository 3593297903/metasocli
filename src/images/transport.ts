import { Dispatcher, getGlobalDispatcher } from 'undici';
import { fail } from '../core/errors.js';
import { IMAGE_GENERATION_TIMEOUT_MS } from './contracts.js';

export const effectiveImageTimeout = (configuredMs: number): number => Math.min(configuredMs, IMAGE_GENERATION_TIMEOUT_MS);

/** Request-local timeouts; keep the existing connection/proxy dispatcher intact. */
class ImageDispatcher extends Dispatcher {
  constructor(private readonly upstream: Dispatcher, private readonly timeoutMs: number) { super(); }
  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    return this.upstream.dispatch({ ...options, headersTimeout: this.timeoutMs, bodyTimeout: this.timeoutMs }, handler);
  }
}

export function imageDispatcher(timeoutMs: number): Dispatcher {
  return new ImageDispatcher(getGlobalDispatcher(), timeoutMs);
}

// Never serialize arbitrary fetch errors: their messages can contain URLs or credentials.
const safeCodes = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET', 'UND_ERR_ABORTED', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN']);
export function imageTransportReason(error: unknown): string | undefined {
  let reason: string | undefined, current = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const item = current as { name?: unknown; code?: unknown; cause?: unknown };
    if (typeof item.code === 'string' && safeCodes.has(item.code)) { reason = item.code; break; }
    if (item.name === 'TimeoutError') { reason = 'GENERATION_TIMEOUT'; break; }
    if (item.name === 'AbortError') reason = 'ABORTED';
    current = item.cause;
  }
  return reason;
}
export function imageTransportFailure(error: unknown, timeoutMs: number): never {
  const reason = imageTransportReason(error) ?? 'FETCH_ERROR';
  return fail('IMAGE_TRANSPORT_UNKNOWN', `Image request did not yield a complete response (${reason}; effective timeout ${timeoutMs} ms). Preserve the original operation; do not resend.`);
}
