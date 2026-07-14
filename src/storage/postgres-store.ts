import { Pool, type PoolClient } from "pg";
import { AegisError } from "../domain/errors.js";
import type {
  DashboardClaim,
  GameState,
  SaveRecord,
  SaveSummary,
  TurnRecord,
} from "../domain/types.js";
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
      CREATE TABLE IF NOT EXISTS aegis_turns (
        game_id TEXT PRIMARY KEY REFERENCES aegis_games(game_id) ON DELETE CASCADE,
        turn_id UUID NOT NULL UNIQUE,
        prepared_revision INTEGER NOT NULL CHECK (prepared_revision >= 0),
        prepared_at TIMESTAMPTZ NOT NULL,
        dashboard_revision INTEGER CHECK (dashboard_revision >= 0),
        dashboard_shown_at TIMESTAMPTZ
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

  async beginTurn(turn: TurnRecord): Promise<TurnRecord> {
    return this.transaction(async (client) => {
      const gameResult = await client.query<{ revision: number }>(
        "SELECT revision FROM aegis_games WHERE game_id = $1 FOR UPDATE",
        [turn.gameId],
      );
      const game = gameResult.rows[0];
      if (!game) throw new AegisError("GAME_NOT_FOUND", `找不到遊戲 ${turn.gameId}。`);
      if (game.revision !== turn.preparedRevision) {
        throw new AegisError("REVISION_CONFLICT", "遊戲狀態已更新，請重新準備回合。", {
          expectedRevision: turn.preparedRevision,
          actualRevision: game.revision,
        });
      }

      const result = await client.query<TurnRow>(
        `INSERT INTO aegis_turns (
           game_id, turn_id, prepared_revision, prepared_at, dashboard_revision, dashboard_shown_at
         ) VALUES ($1, $2, $3, $4, NULL, NULL)
         ON CONFLICT (game_id) DO UPDATE SET
           turn_id = EXCLUDED.turn_id,
           prepared_revision = EXCLUDED.prepared_revision,
           prepared_at = EXCLUDED.prepared_at,
           dashboard_revision = NULL,
           dashboard_shown_at = NULL
         RETURNING game_id, turn_id, prepared_revision, prepared_at,
                   dashboard_revision, dashboard_shown_at`,
        [turn.gameId, turn.turnId, turn.preparedRevision, turn.preparedAt],
      );
      const row = result.rows[0];
      if (!row) throw new AegisError("STORAGE_ERROR", "建立回合鎖失敗。");
      return toTurnRecord(row);
    });
  }

  async claimDashboard(gameId: string, turnId?: string): Promise<DashboardClaim> {
    return this.transaction(async (client) => {
      const gameResult = await client.query<{ state: GameState }>(
        "SELECT state FROM aegis_games WHERE game_id = $1 FOR UPDATE",
        [gameId],
      );
      const game = gameResult.rows[0]?.state;
      if (!game) throw new AegisError("GAME_NOT_FOUND", `找不到遊戲 ${gameId}。`);

      const turnResult = await client.query<TurnRow>(
        `SELECT game_id, turn_id, prepared_revision, prepared_at,
                dashboard_revision, dashboard_shown_at
         FROM aegis_turns WHERE game_id = $1 FOR UPDATE`,
        [gameId],
      );
      const row = turnResult.rows[0];
      if (!row) {
        throw new AegisError("TURN_NOT_PREPARED", "尚未準備可顯示面板的回合，請先呼叫 aegis_prepare_turn。");
      }
      const turn = toTurnRecord(row);
      if (turnId !== undefined && turn.turnId !== turnId) {
        throw new AegisError("TURN_SUPERSEDED", "此回合已被較新的回合取代，請使用最新的 turn_id。");
      }
      if (turn.dashboardShownAt !== null) {
        throw new AegisError("DASHBOARD_ALREADY_SHOWN", "本回合已顯示過 AEGIS 面板，不得再次顯示。", {
          dashboardRevision: turn.dashboardRevision,
        });
      }

      const activeTurnId = turn.turnId;
      const shownAt = new Date().toISOString();
      const claimedResult = await client.query<TurnRow>(
        `UPDATE aegis_turns
         SET dashboard_revision = $3, dashboard_shown_at = $4
         WHERE game_id = $1 AND turn_id = $2 AND dashboard_shown_at IS NULL
         RETURNING game_id, turn_id, prepared_revision, prepared_at,
                   dashboard_revision, dashboard_shown_at`,
        [gameId, activeTurnId, game.revision, shownAt],
      );
      const claimed = claimedResult.rows[0];
      if (!claimed) {
        throw new AegisError("DASHBOARD_ALREADY_SHOWN", "本回合已顯示過 AEGIS 面板，不得再次顯示。");
      }
      return { game, turn: toTurnRecord(claimed) };
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

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

interface TurnRow {
  game_id: string;
  turn_id: string;
  prepared_revision: number;
  prepared_at: Date | string;
  dashboard_revision: number | null;
  dashboard_shown_at: Date | string | null;
}

function toTurnRecord(row: TurnRow): TurnRecord {
  return {
    turnId: row.turn_id,
    gameId: row.game_id,
    preparedRevision: row.prepared_revision,
    preparedAt: toIsoString(row.prepared_at),
    dashboardRevision: row.dashboard_revision,
    dashboardShownAt: row.dashboard_shown_at === null ? null : toIsoString(row.dashboard_shown_at),
  };
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
