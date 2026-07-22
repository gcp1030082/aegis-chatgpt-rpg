import { Pool, type PoolClient } from "pg";
import { AegisError } from "../domain/errors.js";
import { needsGameMigration } from "../domain/default-state.js";
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
      CREATE TABLE IF NOT EXISTS aegis_private_world (
        game_id TEXT PRIMARY KEY REFERENCES aegis_games(game_id) ON DELETE CASCADE,
        state JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS aegis_migration_backups (
        backup_id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL REFERENCES aegis_games(game_id) ON DELETE CASCADE,
        migration_key TEXT NOT NULL,
        source_version TEXT NOT NULL,
        source_revision INTEGER NOT NULL,
        state JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS aegis_saves_game_created_idx
        ON aegis_saves (game_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS aegis_migration_backups_game_created_idx
        ON aegis_migration_backups (game_id, created_at DESC);
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

  async resetProgress(reset: ProgressResetCommit): Promise<ProgressResetResult> {
    return this.transaction(async (client) => {
      const gameId = reset.game.gameId;
      const result = await client.query<{ revision: number; state: GameState }>(
        "SELECT revision, state FROM aegis_games WHERE game_id = $1 FOR UPDATE",
        [gameId],
      );
      const current = result.rows[0];
      if (!current) throw new AegisError("GAME_NOT_FOUND", `找不到遊戲 ${gameId}。`);
      if (hasIdempotencyKey(current.state, reset.idempotencyKey)) {
        return { game: current.state, idempotentReplay: true };
      }
      if (current.revision !== reset.expectedRevision) {
        throw new AegisError("REVISION_CONFLICT", "遊戲狀態已被其他回合更新，請重新讀取。", {
          expectedRevision: reset.expectedRevision,
          actualRevision: current.revision,
        });
      }

      await client.query(
        `INSERT INTO aegis_private_world (game_id, state, updated_at)
         VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (game_id) DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at`,
        [gameId, JSON.stringify(reset.privateWorld), reset.privateWorld.updatedAt],
      );
      const updated = await client.query<{ state: GameState }>(
        `UPDATE aegis_games
         SET revision = $2, state = $3::jsonb, updated_at = $4
         WHERE game_id = $1
         RETURNING state`,
        [gameId, reset.game.revision, JSON.stringify(reset.game), reset.game.updatedAt],
      );
      const row = updated.rows[0];
      if (!row) throw new AegisError("STORAGE_ERROR", "重設玩家進度失敗。");
      return { game: row.state, idempotentReplay: false };
    });
  }

  async createMigrationBackup(backup: MigrationBackup): Promise<MigrationBackup> {
    await this.pool.query(
      `INSERT INTO aegis_migration_backups (
         backup_id, game_id, migration_key, source_version, source_revision, state, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT (backup_id) DO NOTHING`,
      [backup.backupId, backup.gameId, backup.migrationKey, backup.sourceVersion,
        backup.sourceRevision, JSON.stringify(backup.state), backup.createdAt],
    );
    await this.pool.query(
      `DELETE FROM aegis_migration_backups
       WHERE game_id = $1 AND backup_id NOT IN (
         SELECT backup_id FROM aegis_migration_backups WHERE game_id = $1 ORDER BY created_at DESC LIMIT 3
       )`,
      [backup.gameId],
    );
    return backup;
  }

  async commitMigration(migration: MigrationCommit): Promise<GameState> {
    return this.transaction(async (client) => {
      const gameId = migration.game.gameId;
      const result = await client.query<{ revision: number; state: GameState }>(
        "SELECT revision, state FROM aegis_games WHERE game_id = $1 FOR UPDATE",
        [gameId],
      );
      const current = result.rows[0];
      if (!current) throw new AegisError("GAME_NOT_FOUND", `找不到遊戲 ${gameId}。`);
      if (!needsGameMigration(current.state)) return current.state;
      if (current.revision !== migration.expectedRevision) {
        throw new AegisError("REVISION_CONFLICT", "遷移期間遊戲狀態已更新，請重新讀取。", {
          expectedRevision: migration.expectedRevision,
          actualRevision: current.revision,
        });
      }
      await client.query(
        `INSERT INTO aegis_migration_backups (
           backup_id, game_id, migration_key, source_version, source_revision, state, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         ON CONFLICT (backup_id) DO NOTHING`,
        [
          migration.backup.backupId,
          gameId,
          migration.backup.migrationKey,
          migration.backup.sourceVersion,
          migration.backup.sourceRevision,
          JSON.stringify(migration.backup.state),
          migration.backup.createdAt,
        ],
      );
      await client.query(
        `INSERT INTO aegis_private_world (game_id, state, updated_at)
         VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (game_id) DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at`,
        [gameId, JSON.stringify(migration.privateWorld), migration.privateWorld.updatedAt],
      );
      const updated = await client.query<{ state: GameState }>(
        `UPDATE aegis_games SET revision = $2, state = $3::jsonb, updated_at = $4
         WHERE game_id = $1 RETURNING state`,
        [gameId, migration.game.revision, JSON.stringify(migration.game), migration.game.updatedAt],
      );
      await client.query(
        `DELETE FROM aegis_migration_backups
         WHERE game_id = $1 AND backup_id NOT IN (
           SELECT backup_id FROM aegis_migration_backups
           WHERE game_id = $1 ORDER BY created_at DESC LIMIT 3
         )`,
        [gameId],
      );
      const row = updated.rows[0];
      if (!row) throw new AegisError("STORAGE_ERROR", "提交遊戲遷移失敗。");
      return row.state;
    });
  }

  async getPrivateWorld(gameId: string): Promise<PrivateWorldState | null> {
    const result = await this.pool.query<{ state: PrivateWorldState }>(
      "SELECT state FROM aegis_private_world WHERE game_id = $1",
      [gameId],
    );
    return result.rows[0]?.state ?? null;
  }

  async putPrivateWorld(state: PrivateWorldState): Promise<PrivateWorldState> {
    const result = await this.pool.query<{ state: PrivateWorldState }>(
      `INSERT INTO aegis_private_world (game_id, state, updated_at)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (game_id) DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at
       RETURNING state`,
      [state.gameId, JSON.stringify(state), state.updatedAt],
    );
    const row = result.rows[0];
    if (!row) throw new AegisError("GAME_NOT_FOUND", `找不到遊戲 ${state.gameId}。`);
    return row.state;
  }

  async listMigrationBackups(gameId: string): Promise<MigrationBackup[]> {
    const result = await this.pool.query<{
      backup_id: string;
      game_id: string;
      migration_key: string;
      source_version: string;
      source_revision: number;
      created_at: Date | string;
      state: GameState;
    }>(
      `SELECT backup_id, game_id, migration_key, source_version, source_revision, created_at, state
       FROM aegis_migration_backups WHERE game_id = $1 ORDER BY created_at DESC`,
      [gameId],
    );
    return result.rows.map((row) => ({
      backupId: row.backup_id,
      gameId: row.game_id,
      migrationKey: row.migration_key,
      sourceVersion: row.source_version,
      sourceRevision: row.source_revision,
      createdAt: toIsoString(row.created_at),
      state: row.state,
    }));
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

  async claimDashboard(gameId: string, turnId: string): Promise<DashboardClaim> {
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
      if (turn.turnId !== turnId) {
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

  async claimOrCreatePresentationDashboard(
    gameId: string,
    presentationTurnId: string,
    presentedAt: string,
  ): Promise<DashboardClaim> {
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
      const activeTurn = turnResult.rows[0];
      if (activeTurn?.dashboard_shown_at === null) {
        const claimedResult = await client.query<TurnRow>(
          `UPDATE aegis_turns
           SET dashboard_revision = $2, dashboard_shown_at = $3
           WHERE game_id = $1 AND dashboard_shown_at IS NULL
           RETURNING game_id, turn_id, prepared_revision, prepared_at,
                     dashboard_revision, dashboard_shown_at`,
          [gameId, game.revision, presentedAt],
        );
        const claimed = claimedResult.rows[0];
        if (!claimed) {
          throw new AegisError("DASHBOARD_ALREADY_SHOWN", "本回合已顯示過 AEGIS 面板，不得再次顯示。");
        }
        return { game, turn: toTurnRecord(claimed) };
      }

      const presentationResult = await client.query<TurnRow>(
        `INSERT INTO aegis_turns (
           game_id, turn_id, prepared_revision, prepared_at, dashboard_revision, dashboard_shown_at
         ) VALUES ($1, $2, $3, $4, $3, $4)
         ON CONFLICT (game_id) DO UPDATE SET
           turn_id = EXCLUDED.turn_id,
           prepared_revision = EXCLUDED.prepared_revision,
           prepared_at = EXCLUDED.prepared_at,
           dashboard_revision = EXCLUDED.dashboard_revision,
           dashboard_shown_at = EXCLUDED.dashboard_shown_at
         RETURNING game_id, turn_id, prepared_revision, prepared_at,
                   dashboard_revision, dashboard_shown_at`,
        [gameId, presentationTurnId, game.revision, presentedAt],
      );
      const presentation = presentationResult.rows[0];
      if (!presentation) throw new AegisError("STORAGE_ERROR", "建立面板展示回合失敗。");
      return { game, turn: toTurnRecord(presentation) };
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

function hasIdempotencyKey(state: GameState, key: string): boolean {
  const keys = state.engine.idempotencyKeys;
  return Array.isArray(keys) && keys.includes(key);
}
