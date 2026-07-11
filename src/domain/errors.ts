export type AegisErrorCode =
  | "GAME_NOT_FOUND"
  | "GAME_ALREADY_EXISTS"
  | "SAVE_NOT_FOUND"
  | "REVISION_CONFLICT"
  | "INVALID_GAME_ID"
  | "INVALID_STATE"
  | "INVALID_DIFF"
  | "PAYLOAD_TOO_LARGE"
  | "STORAGE_ERROR";

export class AegisError extends Error {
  constructor(
    public readonly code: AegisErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AegisError";
  }
}

export function asAegisError(error: unknown): AegisError {
  if (error instanceof AegisError) return error;
  return new AegisError(
    "STORAGE_ERROR",
    error instanceof Error ? error.message : "Unknown AEGIS error.",
  );
}
