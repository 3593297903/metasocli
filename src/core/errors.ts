export class MetasoError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "MetasoError"; }
}
export function fail(code: string, message: string): never { throw new MetasoError(code, message); }
export function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
// Only controlled diagnostics reach the CLI. Never print fetch/OS error causes.
export function publicError(error: unknown): { code: string; message: string } {
  return error instanceof MetasoError
    ? { code: error.code, message: error.message }
    : { code: "LOCAL_ERROR", message: "Operation failed; inspect local files and permissions. No automatic resubmission." };
}
