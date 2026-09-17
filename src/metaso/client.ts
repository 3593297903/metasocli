import { z } from 'zod';
import { MetasoError, fail } from '../core/errors.js';
import { sha256Hex } from '../storage/canonical.js';
import { validateRequest, type H3Request } from './h3.js';
import { boundedBody, publicHttps, type Fetch } from './transport.js';

export const API_BASE = 'https://metaso.cn/api/minimax/v2';
export function redact(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === 'string') {
    let s = value;
    for (const secret of secrets) if (secret) s = s.replaceAll(secret, '[secret]');
    return s.replace(/https?:\/\/[^\s"<>]+/giu, '[url redacted]').replace(/data:[^\s"<>]+/giu, '[data redacted]').replace(/Bearer\s+\S+/giu, 'Bearer [secret]');
  }
  if (Array.isArray(value)) return value.map(v => redact(v, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [String(redact(k, secrets)), /authorization|api.?key|token|cookie|secret/iu.test(k) ? '[secret]' : redact(v, secrets)]));
  return value;
}
export interface Evidence { sha256: string; response: unknown; httpStatus?: number }
export class ProviderError extends MetasoError {
  constructor(code: string, message: string, readonly options: { rejected?: boolean; retryable?: boolean; retryAfterMs?: number; evidence?: Evidence } = {}) { super(code, message); }
}
export const TaskId = z.union([z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/u), z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String)]);
export interface Submission { taskId: string; evidence: Evidence }
export interface Observation {
  taskId: string; status: 'queued' | 'running' | 'generated' | 'failed' | 'cancelled' | 'unknown';
  rawStatus: string; url?: string; duration?: number; resolution?: string; ratio?: string; evidence: Evidence;
}
export interface VideoClient { create(request: H3Request): Promise<Submission>; query(taskId: string): Promise<Observation> }
export function retryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  if (/^\d+(\.\d+)?$/u.test(value)) return Math.ceil(Number(value) * 1000);
  const time = Date.parse(value); return Number.isFinite(time) ? Math.max(0, time - now) : undefined;
}
export class MetasoClient implements VideoClient {
  #key: string;
  constructor(key: string, private readonly fetcher: Fetch = fetch, private readonly timeoutMs = 30000) {
    if (!key.trim() || /[\r\n]/u.test(key)) fail('API_KEY_MISSING', 'Set METASO_API_KEY for authenticated operations.');
    this.#key = key;
  }
  private async request(method: 'POST' | 'GET', suffix: string, body?: H3Request) {
    let response: Response, bytes: Buffer;
    try {
      response = await this.fetcher(`${API_BASE}/${suffix}`, { method, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { Authorization: `Bearer ${this.#key}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      bytes = await boundedBody(response, 1024 * 1024);
    } catch {
      throw new ProviderError('PROVIDER_UNREACHABLE', 'Provider response was not received completely.', { retryable: method === 'GET' });
    }
    let raw: unknown;
    try { raw = JSON.parse(bytes.toString('utf8')); } catch { raw = { malformedJson: true }; }
    const evidence: Evidence = { sha256: sha256Hex(bytes), response: redact(raw, [this.#key]), httpStatus: response.status };
    if (!response.ok) throw new ProviderError('PROVIDER_HTTP', `Provider returned HTTP ${response.status}.`, {
      rejected: method === 'POST' && [400, 401, 402, 403, 404, 422, 429].includes(response.status),
      retryable: method === 'GET' && (response.status === 429 || response.status >= 500),
      retryAfterMs: retryAfter(response.headers.get('retry-after')), evidence,
    });
    return { raw, evidence };
  }
  async create(request: H3Request): Promise<Submission> {
    const { raw, evidence } = await this.request('POST', 'video_generation', validateRequest(request));
    const schema = z.object({ task_id: TaskId.optional(), task: z.object({ id: TaskId.optional(), task_id: TaskId.optional() }).optional() });
    const parsed = schema.safeParse(raw);
    const ids = parsed.success ? [parsed.data.task_id, parsed.data.task?.id, parsed.data.task?.task_id].filter((v): v is string => v !== undefined) : [];
    if (!ids.length || new Set(ids).size !== 1) throw new ProviderError('CREATE_CONTRACT', 'Create response lacks one unambiguous task ID; do not resubmit.', { evidence });
    return { taskId: ids[0]!, evidence };
  }
  async query(taskId: string): Promise<Observation> {
    if (!TaskId.safeParse(taskId).success) fail('TASK_ID_INVALID', 'Invalid task ID.');
    const { raw, evidence } = await this.request('GET', `query/video_generation/${encodeURIComponent(taskId)}`);
    const task = raw && typeof raw === 'object' && 'task' in raw ? raw.task : raw;
    const parsed = z.object({ id: TaskId.optional(), task_id: TaskId.optional(), status: z.string().min(1).max(128), model: z.string().optional(),
      content: z.object({ url: z.string().optional() }).nullable().optional(), duration: z.number().positive().optional(), resolution: z.string().optional(), ratio: z.string().optional() }).safeParse(task);
    if (!parsed.success) throw new ProviderError('QUERY_CONTRACT', 'Task response does not match the query contract.', { evidence });
    const t = parsed.data, ids = [t.id, t.task_id].filter(v => v !== undefined);
    if (!ids.length || ids.some(id => id !== taskId) || (t.model !== undefined && t.model !== 'MiniMax-H3')) throw new ProviderError('QUERY_CONTRACT', 'Query returned a different task identity or model.', { evidence });
    const states: Record<string, Observation['status']> = { queued: 'queued', running: 'running', processing: 'running', succeeded: 'generated', success: 'generated', completed: 'generated', failed: 'failed', failure: 'failed', cancelled: 'cancelled' };
    const status = states[t.status.toLowerCase()] ?? 'unknown';
    let url: string | undefined;
    if (status === 'generated') {
      try { url = publicHttps(t.content?.url ?? ''); } catch { throw new ProviderError('QUERY_CONTRACT', 'Completed task lacks a valid output URL.', { evidence }); }
    }
    return { taskId, status, rawStatus: /^[a-z0-9_-]+$/iu.test(t.status) ? String(redact(t.status, [this.#key])) : 'unrecognized', ...(url ? { url } : {}),
      ...(t.duration ? { duration: t.duration } : {}), ...(t.resolution ? { resolution: t.resolution } : {}), ...(t.ratio ? { ratio: t.ratio } : {}), evidence };
  }
}
