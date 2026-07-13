import type { GameState, JsonObject } from "./types.js";

export function recordAutomaticSave(
  state: GameState,
  idempotencyKey: string,
  summary: string | undefined,
  changedPaths: string[],
  extra: JsonObject = {},
): void {
  const keys = Array.isArray(state.engine.idempotencyKeys) ? state.engine.idempotencyKeys : [];
  state.engine.idempotencyKeys = [...keys, idempotencyKey].slice(-100);

  const log = Array.isArray(state.engine.transactionLog) ? state.engine.transactionLog : [];
  state.engine.transactionLog = [...log, {
    idempotencyKey,
    revision: state.revision,
    time: state.updatedAt,
    summary: summary ?? "",
    changedPaths,
    ...extra,
  }].slice(-100);

  state.engine.autoSave = {
    status: "saved",
    revision: state.revision,
    savedAt: state.updatedAt,
  };
}
