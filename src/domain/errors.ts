export type AegisErrorCode =
  | "GAME_NOT_FOUND"
  | "GAME_ALREADY_EXISTS"
  | "SAVE_NOT_FOUND"
  | "TURN_NOT_PREPARED"
  | "TURN_SUPERSEDED"
  | "DASHBOARD_ALREADY_SHOWN"
  | "REVISION_CONFLICT"
  | "INVALID_GAME_ID"
  | "INVALID_STATE"
  | "INVALID_DIFF"
  | "NO_STATE_CHANGE"
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
    "儲存或系統操作失敗，進度未變更。請稍後安全重試。",
    { internalType: error instanceof Error ? error.name : "UnknownError" },
  );
}
