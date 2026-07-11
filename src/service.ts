import { createHash } from "node:crypto";
import type { AppConfig } from "./config.js";
import { applyStateDiff } from "./domain/diff.js";
import { cloneState, defaultGameState, toGameView } from "./domain/default-state.js";
import { AegisError } from "./domain/errors.js";
import { prepareTurn } from "./domain/context.js";
import type { GameState, SaveRecord } from "./domain/types.js";
import { assertGameId, validateGameState } from "./domain/validation.js";
import type { GameStore } from "./storage/store.js";

export class AegisService {
  constructor(
    private readonly store: GameStore,
    private readonly config: Pick<AppConfig, "maxDiffBytes" | "maxStateBytes">,
  ) {}

  async createGame(gameId: string, title?: string): Promise<GameState> {
    assertGameId(gameId);
    const state = defaultGameState(gameId, cleanText(title, 100) || "AEGIS 冒險");
    validateGameState(state, this.config.maxStateBytes);
    return this.store.createGame(state);
  }

  async getGame(gameId: string): Promise<GameState> {
    assertGameId(gameId);
    const state = await this.store.getGame(gameId);
    if (!state) throw new AegisError("GAME_NOT_FOUND", `找不到遊戲 ${gameId}。`);
    validateGameState(state, this.config.maxStateBytes);
    return state;
  }

  async prepareTurn(
    gameId: string,
    playerInput: string,
    runtime = "auto",
    actionType = "auto",
  ) {
    const input = cleanText(playerInput, 4000);
    if (!input) throw new AegisError("INVALID_DIFF", "玩家輸入不可為空白。");
    return prepareTurn(await this.getGame(gameId), input, runtime, actionType);
  }

  async applyDiff(
    gameId: string,
    expectedRevision: number,
    idempotencyKey: string,
    diff: unknown,
    turnSummary?: string,
  ) {
    assertRevision(expectedRevision);
    const key = cleanIdempotencyKey(idempotencyKey);
    const current = await this.getGame(gameId);
    if (hasIdempotencyKey(current, key)) {
      return { game: current, changedPaths: [], idempotentReplay: true };
    }
    if (current.revision !== expectedRevision) {
      throw new AegisError("REVISION_CONFLICT", "遊戲狀態已更新，請重新準備回合。", {
        expectedRevision,
        actualRevision: current.revision,
      });
    }
    const result = applyStateDiff(current, diff, {
      maxDiffBytes: this.config.maxDiffBytes,
      maxStateBytes: this.config.maxStateBytes,
      idempotencyKey: key,
      turnSummary: cleanText(turnSummary, 500) || undefined,
    });
    const game = await this.store.compareAndSwap(gameId, expectedRevision, result.game);
    return { game, changedPaths: result.changedPaths, idempotentReplay: false };
  }

  async createSave(gameId: string, name: string, idempotencyKey: string): Promise<SaveRecord> {
    const state = await this.getGame(gameId);
    const key = cleanIdempotencyKey(idempotencyKey);
    const createdAt = new Date().toISOString();
    const save: SaveRecord = {
      saveId: deterministicSaveId(gameId, key),
      gameId,
      name: cleanText(name, 100) || `Revision ${state.revision}`,
      sourceRevision: state.revision,
      createdAt,
      state: cloneState(state),
    };
    return this.store.createSave(save);
  }

  async listSaves(gameId: string) {
    await this.getGame(gameId);
    return this.store.listSaves(gameId);
  }

  async loadSave(
    gameId: string,
    saveId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ) {
    assertRevision(expectedRevision);
    const key = cleanIdempotencyKey(idempotencyKey);
    const current = await this.getGame(gameId);
    if (hasIdempotencyKey(current, key)) {
      return { game: current, idempotentReplay: true };
    }
    if (current.revision !== expectedRevision) {
      throw new AegisError("REVISION_CONFLICT", "遊戲狀態已更新，請重新確認後讀檔。", {
        expectedRevision,
        actualRevision: current.revision,
      });
    }
    const save = await this.store.getSave(gameId, saveId);
    if (!save) throw new AegisError("SAVE_NOT_FOUND", `找不到存檔 ${saveId}。`);

    const restored = cloneState(save.state);
    restored.gameId = current.gameId;
    restored.title = current.title;
    restored.createdAt = current.createdAt;
    restored.revision = current.revision + 1;
    restored.updatedAt = new Date().toISOString();
    appendRestoreTransaction(restored, key, save);
    validateGameState(restored, this.config.maxStateBytes);
    const game = await this.store.compareAndSwap(gameId, expectedRevision, restored);
    return { game, idempotentReplay: false };
  }

  async dashboard(gameId: string) {
    const game = await this.getGame(gameId);
    const saves = await this.store.listSaves(gameId);
    return { game: toGameView(game), saves };
  }
}

function hasIdempotencyKey(state: GameState, key: string): boolean {
  const keys = state.engine.idempotencyKeys;
  return Array.isArray(keys) && keys.includes(key);
}

function appendRestoreTransaction(state: GameState, key: string, save: SaveRecord): void {
  const keys = Array.isArray(state.engine.idempotencyKeys) ? state.engine.idempotencyKeys : [];
  keys.push(key);
  state.engine.idempotencyKeys = keys.slice(-100);
  const log = Array.isArray(state.engine.transactionLog) ? state.engine.transactionLog : [];
  log.push({
    idempotencyKey: key,
    revision: state.revision,
    time: state.updatedAt,
    summary: `Loaded save ${save.name}`,
    changedPaths: ["*"],
    sourceSaveId: save.saveId,
  });
  state.engine.transactionLog = log.slice(-100);
}

function deterministicSaveId(gameId: string, key: string): string {
  const hex = createHash("sha256").update(`${gameId}:${key}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function cleanIdempotencyKey(value: string): string {
  const key = cleanText(value, 120);
  if (!key || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new AegisError(
      "INVALID_DIFF",
      "idempotency_key 必須是 1–120 字元的英數、點、底線、冒號或連字號。",
    );
  }
  return key;
}

function assertRevision(value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new AegisError("INVALID_DIFF", "expected_revision 必須是非負整數。");
  }
}

function cleanText(value: string | undefined, maxLength: number): string {
  return (value ?? "").trim().slice(0, maxLength);
}
