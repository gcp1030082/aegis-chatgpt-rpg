import { resolve } from "node:path";
import type { AppConfig } from "../config.js";
import { AegisError } from "../domain/errors.js";
import { FileGameStore } from "./file-store.js";
import { PostgresGameStore } from "./postgres-store.js";
import type { GameStore } from "./store.js";

export function createStore(config: AppConfig): GameStore {
  if (config.storageDriver === "file") return new FileGameStore(resolve(config.dataDir));
  if (!config.databaseUrl) {
    throw new AegisError("STORAGE_ERROR", "使用 postgres 儲存時必須設定 DATABASE_URL。");
  }
  return new PostgresGameStore(config.databaseUrl, config.databaseSsl);
}
