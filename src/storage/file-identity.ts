import { MetasoError as StoryError } from "../core/errors.js";

export interface FileIdentity { readonly dev: bigint; readonly ino: bigint }
const MIN_SIGNED = -(1n << 63n);
const MAX_UNSIGNED = (1n << 64n) - 1n;
function validWord(value: unknown): value is bigint {
  return typeof value === "bigint" && value >= MIN_SIGNED && value <= MAX_UNSIGNED;
}

/** Node bigint stat fields are opaque, exact identifiers, not positive counters.
 * Accept signed or unsigned 64-bit words without conversion/normalization.
 * Device zero is valid (e.g. virtual filesystems); inode zero is unavailable.
 * Missing, Number, and out-of-range values cannot prove stable identity.
 */
export function hasUsableFileIdentity(info: { readonly dev?: unknown; readonly ino?: unknown }): info is FileIdentity {
  return validWord(info.dev) && validWord(info.ino) && info.ino !== 0n;
}

export function requireFileIdentity(info: { readonly dev?: unknown; readonly ino?: unknown }, path: string): FileIdentity {
  if (!hasUsableFileIdentity(info)) {
    throw new StoryError("FILE_IDENTITY_UNAVAILABLE", "Filesystem did not supply a supported stable bigint identity");
  }
  return { dev: info.dev, ino: info.ino };
}

export function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return hasUsableFileIdentity(left) && hasUsableFileIdentity(right) && left.dev === right.dev && left.ino === right.ino;
}
