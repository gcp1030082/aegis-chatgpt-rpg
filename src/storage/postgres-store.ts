import { Pool } from "pg";
import { AegisError } from "../domain/errors.js";
import type { GameState, SaveRecord, SaveSummary } from "../domain/types.js";
import type { GameStore } from "./store.js";

export class PostgresGameStore implements GameStore {
  private readonly pool: Pool;

  constructor(connectionString: string, ssl: boolean) {
    this.pool = new Pool({
      connectionString,
      ssl: ssl ? { rejectUnauthorized: false } : undefined,
      max: 10,
    });
  }

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS aegis_games (
        game_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL CHECK (revision >= 0),
        state JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS aegis_saves (
        save_id UUID PRIMARY KEY,
        game_id TEXT NOT NULL,
        name TEXT NOT NULL,
        source_revision INTEGER NOT NULL,
        state JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS aegis_saves_game_created_idx
        ON aegis_saves (game_id, created_at DESC);
    `);
  }

  async createGame(state: GameState): Promise<GameState> {
    const result = await this.pool.query<{ state: GameState }>(
      `INSERT INTO aegis_games (game_id, revision, state, created_at, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       ON CONFLICT (game_id) DO NOTHING
       RETURNING state`,
      [state.gameId, state.revision, JSON.stringify(state), state.createdAt, state.updatedAt],
    );
    const row = result.rows[0];
    if (!row) throw new AegisError("GAME_ALREADY_EXISTS", `遊戲 ${state.gameId} 已存在。`);
    return row.state;
  }

  async getGame(gameId: string): Promise<GameState | null> {
    const result = await this.pool.query<{ state: GameState }>(
      "SELECT state FROM aegis_games WHERE game_id = $1",
      [gameId],
    );
    return result.rows[0]?.state ?? null;
  }

  async compareAndSwap(gameId: string, expectedRevision: number, next: GameState): Promise<GameState> {
    const result = await this.pool.query<{ state: GameState }>(
      `UPDATE aegis_games
       SET revision = $3, state = $4::jsonb, updated_at = $5
       WHERE game_id = $1 AND revision = $2
       RETURNING state`,
      [gameId, expectedRevision, next.revision, JSON.stringify(next), next.updatedAt],
    );
    const row = result.rows[0];
    if (row) return row.state;

    const current = await this.getGame(gameId);
    if (!current) throw new AegisError("GAME_NOT_FOUND", `找不到遊戲 ${gameId}。`);
    throw new AegisError("REVISION_CONFLICT", "遊戲狀態已被其他回合更新，請重新讀取。", {
      expectedRevision,
      actualRevision: current.revision,
    });
  }

  async createSave(save: SaveRecord): Promise<SaveRecord> {
    const result = await this.pool.query<{ save_id: string; created_at: Date }>(
      `INSERT INTO aegis_saves (save_id, game_id, name, source_revision, state, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (save_id) DO NOTHING
       RETURNING save_id, created_at`,
      [save.saveId, save.gameId, save.name, save.sourceRevision, JSON.stringify(save.state), save.createdAt],
    );
    const row = result.rows[0];
    if (row) return save;
    const existing = await this.getSave(save.gameId, save.saveId);
    if (!existing) throw new AegisError("STORAGE_ERROR", "建立存檔失敗。");
    return existing;
  }

  async getSave(gameId: string, saveId: string): Promise<SaveRecord | null> {
    const result = await this.pool.query<{
      save_id: string;
      game_id: string;
      name: string;
      source_revision: number;
      created_at: Date;
      state: GameState;
    }>(
      `SELECT save_id, game_id, name, source_revision, created_at, state
       FROM aegis_saves WHERE game_id = $1 AND save_id = $2`,
      [gameId, saveId],
    );
    const row = result.rows[0];
    return row
      ? {
          saveId: row.save_id,
          gameId: row.game_id,
          name: row.name,
          sourceRevision: row.source_revision,
          createdAt: row.created_at.toISOString(),
          state: row.state,
        }
      : null;
  }

  async listSaves(gameId: string): Promise<SaveSummary[]> {
    const result = await this.pool.query<{
      save_id: string;
      game_id: string;
      name: string;
      source_revision: number;
      created_at: Date;
    }>(
      `SELECT save_id, game_id, name, source_revision, created_at
       FROM aegis_saves WHERE game_id = $1 ORDER BY created_at DESC`,
      [gameId],
    );
    return result.rows.map((row) => ({
      saveId: row.save_id,
      gameId: row.game_id,
      name: row.name,
      sourceRevision: row.source_revision,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
