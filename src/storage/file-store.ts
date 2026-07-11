import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cloneState } from "../domain/default-state.js";
import { AegisError } from "../domain/errors.js";
import type { GameState, SaveRecord, SaveSummary } from "../domain/types.js";
import type { GameStore } from "./store.js";
import { KeyMutex } from "./mutex.js";

export class FileGameStore implements GameStore {
  private readonly mutex = new KeyMutex();
  private readonly gamesDir: string;
  private readonly savesDir: string;

  constructor(private readonly dataDir: string) {
    this.gamesDir = join(dataDir, "games");
    this.savesDir = join(dataDir, "saves");
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.gamesDir, { recursive: true }),
      mkdir(this.savesDir, { recursive: true }),
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

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
