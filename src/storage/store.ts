import type {
  DashboardClaim,
  GameState,
  MigrationBackup,
  MigrationCommit,
  PrivateWorldState,
  ProgressResetCommit,
  ProgressResetResult,
  SaveRecord,
  SaveSummary,
  TurnRecord,
} from "../domain/types.js";

export interface GameStore {
  initialize(): Promise<void>;
  createGame(state: GameState): Promise<GameState>;
  getGame(gameId: string): Promise<GameState | null>;
  compareAndSwap(gameId: string, expectedRevision: number, next: GameState): Promise<GameState>;
  resetProgress(reset: ProgressResetCommit): Promise<ProgressResetResult>;
  createMigrationBackup(backup: MigrationBackup): Promise<MigrationBackup>;
  commitMigration(migration: MigrationCommit): Promise<GameState>;
  getPrivateWorld(gameId: string): Promise<PrivateWorldState | null>;
  putPrivateWorld(state: PrivateWorldState): Promise<PrivateWorldState>;
  listMigrationBackups(gameId: string): Promise<MigrationBackup[]>;
  beginTurn(turn: TurnRecord): Promise<TurnRecord>;
  claimDashboard(gameId: string, turnId: string): Promise<DashboardClaim>;
  claimOrCreatePresentationDashboard(
    gameId: string,
    presentationTurnId: string,
    presentedAt: string,
  ): Promise<DashboardClaim>;
  createSave(save: SaveRecord): Promise<SaveRecord>;
  getSave(gameId: string, saveId: string): Promise<SaveRecord | null>;
  listSaves(gameId: string): Promise<SaveSummary[]>;
  close(): Promise<void>;
}
