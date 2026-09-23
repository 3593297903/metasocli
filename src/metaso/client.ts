import { z } from 'zod';
import { MetasoError, fail } from '../core/errors.js';
import { sha256Hex } from '../storage/canonical.js';
import { validateRequest, type H3Request } from './h3.js';
import { boundedBody, publicHttps, type Fetch } from './transport.js';
import { TaskId } from '../contracts/task.js';
import { validateIrRequest, type IrRequest } from './context-ir.js';
export { TaskId } from '../contracts/task.js';

export const API_BASE = 'https://metaso.cn/api/minimax/v2';
// Independently configured. Public docs do not prove the /api alias for IR; no automatic route fallback.
export const CONTEXT_IR_CREATE_URL = 'https://metaso.cn/api/minimax/v2/h3_context_ir';
export const CONTEXT_IR_QUERY_BASE = 'https://metaso.cn/api/minimax/v2/query/video_generation';
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
  constructor(code: string, message: string, readonly options: { rejected?: boolean; retryable?: boolean; retryAfterMs?: number; evidence?: Evidence; httpStatus?: number; safeToRetry?: boolean } = {}) { super(code, message); }
}
export interface Submission { taskId: string; evidence: Evidence }
export interface Observation {
  taskId: string; status: 'queued' | 'running' | 'generated' | 'failed' | 'cancelled' | 'unknown';
  rawStatus: string; url?: string; duration?: number; resolution?: string; ratio?: string; evidence: Evidence;
}
export interface VideoClient { create(request: H3Request): Promise<Submission>; query(taskId: string): Promise<Observation> }
export interface IrObservation {
  taskId: string; model: 'MiniMax-H3'; taskType: 'h3_context_ir';
  status: 'queued' | 'running' | 'enhanced' | 'failed' | 'cancelled' | 'unknown';
  rawStatus: string; prompt?: string; evidence: Evidence;
}
export interface ContextIrClient { createContextIr(request: IrRequest): Promise<Submission>; queryContextIr(taskId: string): Promise<IrObservation> }
export function retryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  if (/^\d+(\.\d+)?$/u.test(value)) return Math.ceil(Number(value) * 1000);
  const time = Date.parse(value); return Number.isFinite(time) ? Math.max(0, time - now) : undefined;
}
export class MetasoClient implements VideoClient, ContextIrClient {
  #key: string;
  constructor(key: string, private readonly fetcher: Fetch = fetch, private readonly timeoutMs = 30000, private readonly createTimeoutMs = 120000) {
    if (!key.trim() || /[\r\n]/u.test(key)) fail('API_KEY_MISSING', 'Set METASO_API_KEY for authenticated operations.');
    this.#key = key;
  }
  private async request(method: 'POST' | 'GET', suffix: string, body?: H3Request | IrRequest, absoluteUrl?: string) {
    let response: Response, bytes: Buffer;
    try {
      response = await this.fetcher(absoluteUrl ?? `${API_BASE}/${suffix}`, { method, redirect: 'error', signal: AbortSignal.timeout(method === 'POST' ? this.createTimeoutMs : this.timeoutMs),
        headers: { Authorization: `Bearer ${this.#key}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      bytes = await boundedBody(response, 1024 * 1024);
    } catch {
      throw new ProviderError('PROVIDER_UNREACHABLE', 'Provider response was not received completely.', { retryable: method === 'GET' });
    }
    let raw: unknown;
    try { raw = JSON.parse(bytes.toString('utf8')); } catch { raw = { malformedJson: true }; }
    const evidence: Evidence = { sha256: sha256Hex(bytes), response: redact(raw, [this.#key]), httpStatus: response.status };
    const hasIdentity = (value: unknown): boolean => !!value && typeof value === 'object' && Object.entries(value).some(([key, child]) => /^(?:task_?id|id)$/iu.test(key) || hasIdentity(child));
    const meaningfulError = (value: unknown): boolean => typeof value === 'string' ? !!value.trim()
      : !!value && typeof value === 'object' && !Array.isArray(value) && Object.entries(value).some(([key, child]) => ['message','code','type'].includes(key) && (typeof child === 'string' ? !!child.trim() : typeof child === 'number' && child !== 0));
    const rejectionBody = !!raw && typeof raw === 'object' && (('error' in raw && meaningfulError(raw.error))
      || ('base_resp' in raw && !!raw.base_resp && typeof raw.base_resp === 'object' && 'status_code' in raw.base_resp
        && typeof raw.base_resp.status_code === 'number' && Number.isInteger(raw.base_resp.status_code) && raw.base_resp.status_code > 0));
    const safeRateLimit = response.status === 429 && rejectionBody && !hasIdentity(raw);
    if (!response.ok) throw new ProviderError('PROVIDER_HTTP', `Provider returned HTTP ${response.status}.`, {
      rejected: method === 'POST' && !hasIdentity(raw) && ([400, 401, 402, 403, 404, 422].includes(response.status) || safeRateLimit),
      httpStatus: response.status, safeToRetry: method === 'POST' && safeRateLimit,
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
      task_type: z.literal('generation').optional(), modality: z.literal('video').optional(),
      content: z.object({ url: z.string().optional(), prompt: z.never().optional() }).nullable().optional(), duration: z.number().positive().optional(), resolution: z.string().optional(), ratio: z.string().optional() }).safeParse(task);
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
  async createContextIr(request: IrRequest): Promise<Submission> {
    const { raw, evidence } = await this.request('POST', '', validateIrRequest(request), CONTEXT_IR_CREATE_URL);
    const parsed = z.object({ task_id: TaskId.optional(), model: z.literal('MiniMax-H3').optional(), task_type: z.literal('h3_context_ir').optional(), task: z.object({ id: TaskId.optional(), task_id: TaskId.optional(),
      model: z.literal('MiniMax-H3').optional(), task_type: z.literal('h3_context_ir').optional() }).optional() }).safeParse(raw);
    const ids = parsed.success ? [parsed.data.task_id, parsed.data.task?.id, parsed.data.task?.task_id].filter((v): v is string => v !== undefined) : [];
    if (!ids.length || new Set(ids).size !== 1) throw new ProviderError('CREATE_CONTRACT', 'IR create response lacks one unambiguous task identity; do not resubmit.', { evidence });
    return { taskId: ids[0]!, evidence };
  }
  async queryContextIr(taskId: string): Promise<IrObservation> {
    if (!TaskId.safeParse(taskId).success) fail('TASK_ID_INVALID', 'Invalid IR task ID.');
    const { raw, evidence } = await this.request('GET', '', undefined, `${CONTEXT_IR_QUERY_BASE}/${encodeURIComponent(taskId)}`);
    const task = raw && typeof raw === 'object' && 'task' in raw ? raw.task : raw;
    const parsed = z.object({ id: TaskId.optional(), task_id: TaskId.optional(), status: z.string().min(1).max(128),
      model: z.literal('MiniMax-H3'), task_type: z.literal('h3_context_ir'), modality: z.literal('text').optional(),
      content: z.object({ prompt: z.string().optional(), url: z.never().optional() }).nullable().optional() }).safeParse(task);
    if (!parsed.success) throw new ProviderError('IR_QUERY_CONTRACT', 'Query is not an identified MiniMax-H3 IR text task.', { evidence });
    const t = parsed.data, ids = [t.id, t.task_id].filter(v => v !== undefined);
    if (!ids.length || ids.some(id => id !== taskId)) throw new ProviderError('IR_QUERY_CONTRACT', 'IR query returned a different task ID.', { evidence });
    const states: Record<string, IrObservation['status']> = { queued: 'queued', running: 'running', processing: 'running', succeeded: 'enhanced', success: 'enhanced', completed: 'enhanced', failed: 'failed', failure: 'failed', cancelled: 'cancelled' };
    const status = states[t.status.toLowerCase()] ?? 'unknown';
    if (status === 'enhanced' && !t.content?.prompt?.trim()) throw new ProviderError('IR_QUERY_CONTRACT', 'IR success lacks a nonempty text result.', { evidence });
    return { taskId, model: t.model, taskType: t.task_type, status, rawStatus: /^[a-z0-9_-]+$/iu.test(t.status) ? String(redact(t.status, [this.#key])) : 'unrecognized',
      ...(status === 'enhanced' ? { prompt: t.content!.prompt! } : {}), evidence };
  }
}
