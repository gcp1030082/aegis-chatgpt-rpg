import type { GameState, SaveRecord, SaveSummary } from "../domain/types.js";

export interface GameStore {
  initialize(): Promise<void>;
  createGame(state: GameState): Promise<GameState>;
  getGame(gameId: string): Promise<GameState | null>;
  compareAndSwap(gameId: string, expectedRevision: number, next: GameState): Promise<GameState>;
  createSave(save: SaveRecord): Promise<SaveRecord>;
  getSave(gameId: string, saveId: string): Promise<SaveRecord | null>;
  listSaves(gameId: string): Promise<SaveSummary[]>;
  close(): Promise<void>;
}
