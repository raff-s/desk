export class DeskError extends Error {}

export function fail(message: string): never {
  throw new DeskError(message);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
