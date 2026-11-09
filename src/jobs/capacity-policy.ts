import { z } from 'zod';
import { Hash } from '../contracts/story.js';

export const CapacityReason = z.enum(['reserved','create_accepted','create_ended_without_id','submitter_exited_without_id',
  'query_unavailable','source_unavailable','provider_terminal','remote_active_recovered']);
export type CapacityReason = z.infer<typeof CapacityReason>;
const Basis=z.object({version:z.number().int().nonnegative(),reason:CapacityReason,evidence:Hash,decidedAt:z.iso.datetime()}).strict();
/** Business state never substitutes for this scheduling decision. Observation clocks are local, not wall time. */
export const CapacityDecision = z.object({
  policy: z.literal('R3'), state: z.enum(['held','released']), version: z.number().int().nonnegative(),
  issued: z.number().int().nonnegative(), applied: z.number().int().nonnegative(),
  reason: CapacityReason, evidence: Hash, decidedAt: z.iso.datetime(), terminal: z.boolean(),
  sourceKey: Hash.optional(),
  lastRelease:Basis.optional(),lastRestore:Basis.optional(),
}).strict();
export const releases = (reason: CapacityReason) => !['reserved','create_accepted','remote_active_recovered'].includes(reason);
export interface Share { root: string; capacity: number; remaining: number; eligible: boolean }
/** root is a validated identity key. Shares are ephemeral, never remote reservations. */
export function dispatchShares(heldRoots: string[], tickets: Share[]) {
  let free = Math.max(0, 4 - heldRoots.length);
  const assigned = new Map<string, number>();
  return tickets.map(ticket => {
    const held = heldRoots.filter(root => root === ticket.root).length;
    const need = ticket.eligible ? Math.min(ticket.remaining, Math.max(0, ticket.capacity - held - (assigned.get(ticket.root) ?? 0))) : 0;
    const share = Math.min(free, need); free -= share;
    assigned.set(ticket.root, (assigned.get(ticket.root) ?? 0) + share);
    return share;
  });
}
