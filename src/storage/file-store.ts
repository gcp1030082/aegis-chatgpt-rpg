import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cloneState, needsGameMigration } from "../domain/default-state.js";
import { AegisError } from "../domain/errors.js";
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
import { KeyMutex } from "./mutex.js";

export class FileGameStore implements GameStore {
  private readonly mutex = new KeyMutex();
  private readonly gamesDir: string;
  private readonly savesDir: string;
  private readonly turnsDir: string;
  private readonly privateWorldDir: string;
  private readonly migrationBackupsDir: string;

  constructor(private readonly dataDir: string) {
    this.gamesDir = join(dataDir, "games");
    this.savesDir = join(dataDir, "saves");
    this.turnsDir = join(dataDir, "turns");
    this.privateWorldDir = join(dataDir, "private-world");
    this.migrationBackupsDir = join(dataDir, "migration-backups");
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.gamesDir, { recursive: true }),
      mkdir(this.savesDir, { recursive: true }),
      mkdir(this.turnsDir, { recursive: true }),
      mkdir(this.privateWorldDir, { recursive: true }),
      mkdir(this.migrationBackupsDir, { recursive: true }),
    ]);
  }

  async createGame(state: GameState): Promise<GameState> {
    return this.mutex.run(state.gameId, async () => {
      const path = this.gamePath(state.gameId);
      try {
        await writeFile(path, serialize(state), { encoding: "utf8", flag: "wx" });
      } catch (error) {
        if (isNodeError(error, "EEXIST")) {
          throw new AegisError("GAME_ALREADY_EXISTS", `遊戲 ${state.gameId} 已存在。`);
        }
        throw error;
      }
      return cloneState(state);
    });
  }

  async getGame(gameId: string): Promise<GameState | null> {
    try {
      return JSON.parse(await readFile(this.gamePath(gameId), "utf8")) as GameState;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    }
  }

  async compareAndSwap(gameId: string, expectedRevision: number, next: GameState): Promise<GameState> {
    return this.mutex.run(gameId, async () => {
      const current = await this.getGame(gameId);
      if (!current) throw new AegisError("GAME_NOT_FOUND", `找不到遊戲 ${gameId}。`);
      if (current.revision !== expectedRevision) {
        throw new AegisError("REVISION_CONFLICT", "遊戲狀態已被其他回合更新，請重新讀取。", {
          expectedRevision,
          actualRevision: current.revision,
        });
      }
      await atomicWrite(this.gamePath(gameId), next);
      return cloneState(next);
    });
  }

  async resetProgress(reset: ProgressResetCommit): Promise<ProgressResetResult> {
    return this.mutex.run(reset.game.gameId, async () => {
      const gameId = reset.game.gameId;
      const current = await this.getGame(gameId);
      if (!current) throw new AegisError("GAME_NOT_FOUND", `找不到遊戲 ${gameId}。`);
      if (hasIdempotencyKey(current, reset.idempotencyKey)) {
        return { game: cloneState(current), idempotentReplay: true };
      }
      if (current.revision !== reset.expectedRevision) {
        throw new AegisError("REVISION_CONFLICT", "遊戲狀態已被其他回合更新，請重新讀取。", {
          expectedRevision: reset.expectedRevision,
          actualRevision: current.revision,
        });
      }

      const previousPrivateWorld = await this.getPrivateWorld(gameId);
      try {
        await atomicWrite(this.privateWorldPath(gameId), reset.privateWorld);
        await atomicWrite(this.gamePath(gameId), reset.game);
      } catch (error) {
        if (previousPrivateWorld) {
          await atomicWrite(this.privateWorldPath(gameId), previousPrivateWorld).catch(() => undefined);
        } else {
          await unlink(this.privateWorldPath(gameId)).catch(() => undefined);
        }
        await atomicWrite(this.gamePath(gameId), current).catch(() => undefined);
        throw error;
      }
      return { game: cloneState(reset.game), idempotentReplay: false };
    });
  }

  async createMigrationBackup(backup: MigrationBackup): Promise<MigrationBackup> {
    return this.mutex.run(backup.gameId, async () => {
      const directory = join(this.migrationBackupsDir, backup.gameId);
      await mkdir(directory, { recursive: true });
      await atomicWrite(join(directory, `${backup.backupId}.json`), backup);
      await this.cleanupMigrationBackups(backup.gameId, 3);
      return cloneState(backup);
    });
  }

  async commitMigration(migration: MigrationCommit): Promise<GameState> {
    return this.mutex.run(migration.game.gameId, async () => {
      const gameId = migration.game.gameId;
      const current = await this.getGame(gameId);
      if (!current) throw new AegisError("GAME_NOT_FOUND", `找不到遊戲 ${gameId}。`);
      if (!needsGameMigration(current)) return cloneState(current);
      if (current.revision !== migration.expectedRevision) {
        throw new AegisError("REVISION_CONFLICT", "遷移期間遊戲狀態已更新，請重新讀取。", {
          expectedRevision: migration.expectedRevision,
          actualRevision: current.revision,
        });
      }
      const backupDirectory = join(this.migrationBackupsDir, gameId);
      await mkdir(backupDirectory, { recursive: true });
      await atomicWrite(join(backupDirectory, `${migration.backup.backupId}.json`), migration.backup);
      const previousPrivateWorld = await this.getPrivateWorld(gameId);
      try {
        await atomicWrite(this.privateWorldPath(gameId), migration.privateWorld);
        await atomicWrite(this.gamePath(gameId), migration.game);
      } catch (error) {
        if (previousPrivateWorld) {
          await atomicWrite(this.privateWorldPath(gameId), previousPrivateWorld).catch(() => undefined);
        } else {
          await unlink(this.privateWorldPath(gameId)).catch(() => undefined);
        }
        await atomicWrite(this.gamePath(gameId), current).catch(() => undefined);
        throw error;
      }
      await this.cleanupMigrationBackups(gameId, 3).catch(() => undefined);
      return cloneState(migration.game);
    });
  }

  async getPrivateWorld(gameId: string): Promise<PrivateWorldState | null> {
    try {
      return JSON.parse(await readFile(this.privateWorldPath(gameId), "utf8")) as PrivateWorldState;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    }
  }

  async putPrivateWorld(state: PrivateWorldState): Promise<PrivateWorldState> {
    return this.mutex.run(state.gameId, async () => {
      if (!await this.getGame(state.gameId)) throw new AegisError("GAME_NOT_FOUND", `找不到遊戲 ${state.gameId}。`);
      await atomicWrite(this.privateWorldPath(state.gameId), state);
      return cloneState(state);
    });
  }

  async listMigrationBackups(gameId: string): Promise<MigrationBackup[]> {
    const directory = join(this.migrationBackupsDir, gameId);
    let files: string[];
    try {
      files = await readdir(directory);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return [];
      throw error;
    }
    const backups = await Promise.all(files.filter((file) => file.endsWith(".json")).map(async (file) =>
      JSON.parse(await readFile(join(directory, file), "utf8")) as MigrationBackup));
    return backups.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async beginTurn(turn: TurnRecord): Promise<TurnRecord> {
    return this.mutex.run(turn.gameId, async () => {
      const current = await this.getGame(turn.gameId);
      if (!current) throw new AegisError("GAME_NOT_FOUND", `找不到遊戲 ${turn.gameId}。`);
      if (current.revision !== turn.preparedRevision) {
        throw new AegisError("REVISION_CONFLICT", "遊戲狀態已更新，請重新準備回合。", {
          expectedRevision: turn.preparedRevision,
          actualRevision: current.revision,
        });
      }
      await atomicWrite(this.turnPath(turn.gameId), turn);
      return cloneState(turn);
    });
  }

  async claimDashboard(gameId: string, turnId: string): Promise<DashboardClaim> {
    return this.mutex.run(gameId, async () => {
      const game = await this.getGame(gameId);
      if (!game) throw new AegisError("GAME_NOT_FOUND", `找不到遊戲 ${gameId}。`);
      const turn = await this.getTurn(gameId);
      assertDashboardTurn(turn, turnId);
      const claimed: TurnRecord = {
        ...turn,
        dashboardRevision: game.revision,
        dashboardShownAt: new Date().toISOString(),
      };
      await atomicWrite(this.turnPath(gameId), claimed);
      return { game: cloneState(game), turn: cloneState(claimed) };
    });
  }

  async claimOrCreatePresentationDashboard(
    gameId: string,
    presentationTurnId: string,
    presentedAt: string,
  ): Promise<DashboardClaim> {
    return this.mutex.run(gameId, async () => {
      const game = await this.getGame(gameId);
      if (!game) throw new AegisError("GAME_NOT_FOUND", `找不到遊戲 ${gameId}。`);
      const activeTurn = await this.getTurn(gameId);
      const claimed: TurnRecord = activeTurn?.dashboardShownAt === null
        ? {
            ...activeTurn,
            dashboardRevision: game.revision,
            dashboardShownAt: presentedAt,
          }
        : {
            turnId: presentationTurnId,
            gameId,
            preparedRevision: game.revision,
            preparedAt: presentedAt,
            dashboardRevision: game.revision,
            dashboardShownAt: presentedAt,
          };
      await atomicWrite(this.turnPath(gameId), claimed);
      return { game: cloneState(game), turn: cloneState(claimed) };
    });
  }

  async createSave(save: SaveRecord): Promise<SaveRecord> {
    const directory = join(this.savesDir, save.gameId);
    await mkdir(directory, { recursive: true });
    await atomicWrite(join(directory, `${save.saveId}.json`), save);
    return cloneState(save);
  }

  async getSave(gameId: string, saveId: string): Promise<SaveRecord | null> {
    try {
      return JSON.parse(await readFile(join(this.savesDir, gameId, `${saveId}.json`), "utf8")) as SaveRecord;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    }
  }

  async listSaves(gameId: string): Promise<SaveSummary[]> {
    const directory = join(this.savesDir, gameId);
    let files: string[];
    try {
      files = await readdir(directory);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return [];
      throw error;
    }
    const saves = await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map(async (file) => JSON.parse(await readFile(join(directory, file), "utf8")) as SaveRecord),
    );
    return saves
      .map(({ saveId, gameId: id, name, sourceRevision, createdAt }) => ({
        saveId,
        gameId: id,
        name,
        sourceRevision,
        createdAt,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async close(): Promise<void> {}

  static newSaveId(): string {
    return randomUUID();
  }

  private gamePath(gameId: string): string {
    return join(this.gamesDir, `${gameId}.json`);
  }

  private turnPath(gameId: string): string {
    return join(this.turnsDir, `${gameId}.json`);
  }

  private privateWorldPath(gameId: string): string {
    return join(this.privateWorldDir, `${gameId}.json`);
  }

  private async cleanupMigrationBackups(gameId: string, retain: number): Promise<void> {
    const backups = await this.listMigrationBackups(gameId);
    await Promise.all(backups.slice(retain).map((backup) =>
      unlink(join(this.migrationBackupsDir, gameId, `${backup.backupId}.json`)).catch(() => undefined)));
  }

  private async getTurn(gameId: string): Promise<TurnRecord | null> {
    try {
      return JSON.parse(await readFile(this.turnPath(gameId), "utf8")) as TurnRecord;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    }
  }
}

function assertDashboardTurn(turn: TurnRecord | null, turnId: string): asserts turn is TurnRecord {
  if (!turn) {
    throw new AegisError("TURN_NOT_PREPARED", "尚未準備可顯示面板的回合，請先呼叫 aegis_prepare_turn。");
  }
  if (turn.turnId !== turnId) {
    throw new AegisError("TURN_SUPERSEDED", "此回合已被較新的回合取代，請使用最新的 turn_id。");
  }
  if (turn.dashboardShownAt !== null) {
    throw new AegisError("DASHBOARD_ALREADY_SHOWN", "本回合已顯示過 AEGIS 面板，不得再次顯示。", {
      dashboardRevision: turn.dashboardRevision,
    });
  }
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, serialize(value), "utf8");
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function hasIdempotencyKey(state: GameState, key: string): boolean {
  const keys = state.engine.idempotencyKeys;
  return Array.isArray(keys) && keys.includes(key);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
