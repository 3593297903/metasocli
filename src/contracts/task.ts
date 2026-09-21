import { z } from 'zod';
export const TaskId = z.union([z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/u), z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String)]);
