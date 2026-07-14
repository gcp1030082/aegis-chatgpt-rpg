import type {
  DashboardClaim,
  GameState,
  SaveRecord,
  SaveSummary,
  TurnRecord,
} from "../domain/types.js";

export interface GameStore {
  initialize(): Promise<void>;
  createGame(state: GameState): Promise<GameState>;
  getGame(gameId: string): Promise<GameState | null>;
  compareAndSwap(gameId: string, expectedRevision: number, next: GameState): Promise<GameState>;
  beginTurn(turn: TurnRecord): Promise<TurnRecord>;
  claimDashboard(gameId: string, turnId: string): Promise<DashboardClaim>;
  createSave(save: SaveRecord): Promise<SaveRecord>;
  getSave(gameId: string, saveId: string): Promise<SaveRecord | null>;
  listSaves(gameId: string): Promise<SaveSummary[]>;
  close(): Promise<void>;
}
