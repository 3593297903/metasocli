import { fail } from '../core/errors.js';

export interface NormalizedDuration {
  /** Integer duration sent to MiniMax-H3. */
  duration: number;
  /** Original decimal target, present only when it differs from the integer duration. */
  targetDurationSeconds?: number;
}

/**
 * Converts a user-facing target duration into the only duration H3 accepts.
 * The ceiling prevents a requested target from being shortened or silently clamped.
 */
export function normalizeTargetDurationSeconds(targetDurationSeconds: number, location = 'Target duration'): NormalizedDuration {
  if (!Number.isFinite(targetDurationSeconds) || targetDurationSeconds <= 0 || targetDurationSeconds > 15) {
    fail('DURATION_TARGET', `${location} must be a finite number greater than 0 and no more than 15 seconds.`);
  }
  const duration = Math.ceil(targetDurationSeconds);
  if (duration < 4 || duration > 15) {
    fail('DURATION_TARGET', `${location} must round up to an executable 4–15 second H3 duration.`);
  }
  return Number.isInteger(targetDurationSeconds) ? { duration } : { duration, targetDurationSeconds };
}

/** Contract predicate used when reading already-persisted manifests and plans. */
export function targetMatchesDuration(duration: number, targetDurationSeconds: number): boolean {
  return Number.isFinite(targetDurationSeconds)
    && targetDurationSeconds > 0
    && targetDurationSeconds <= 15
    && Number.isInteger(duration)
    && duration >= 4
    && duration <= 15
    && duration === Math.ceil(targetDurationSeconds);
}
