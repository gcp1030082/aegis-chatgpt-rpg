import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { AegisService } from "../src/service.js";
import { PostgresGameStore } from "../src/storage/postgres-store.js";

const connectionString = process.env.AEGIS_POSTGRES_E2E_URL?.trim();
if (!connectionString) {
  throw new Error("請先設定 AEGIS_POSTGRES_E2E_URL；驗收只會建立並清除自己的隨機測試遊戲。");
}

const ssl = process.env.AEGIS_POSTGRES_E2E_SSL === "true";
const gameId = `postgres-e2e-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
const config = {
  maxDiffBytes: 512 * 1024,
  maxStateBytes: 2 * 1024 * 1024,
};

let store: PostgresGameStore | null = new PostgresGameStore(connectionString, ssl);
let restartedStore: PostgresGameStore | null = null;
let gameCreated = false;

try {
  await store.initialize();
  const service = new AegisService(store, config);
  await service.createGame(gameId, "PostgreSQL 端到端驗收");
  gameCreated = true;
  const turn = await service.prepareTurn(gameId, "建立測試角色並顯示面板");
  const committed = await service.applyDiff(
    gameId,
    turn.revision,
    `postgres-e2e-write-${randomUUID()}`,
    { player: { initialized: true, name: "資料庫驗收者", money: 17 } },
    "PostgreSQL persistence verification",
  );
  assert.equal(committed.game.revision, 1);
  await service.createSave(gameId, "驗收快照", `postgres-e2e-save-${randomUUID()}`);

  const claims = await Promise.allSettled([
    service.dashboard(gameId, turn.turnId),
    service.dashboard(gameId, turn.turnId),
  ]);
  assert.equal(claims.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = claims.find((result) => result.status === "rejected") as PromiseRejectedResult | undefined;
  assert.equal(rejected?.reason?.code, "DASHBOARD_ALREADY_SHOWN");

  await store.close();
  store = null;
  restartedStore = new PostgresGameStore(connectionString, ssl);
  await restartedStore.initialize();
  const restarted = new AegisService(restartedStore, config);
  const persisted = await restarted.getGame(gameId);
  assert.equal(persisted.player.name, "資料庫驗收者");
  assert.equal(persisted.player.money, 17);
  assert.equal((await restarted.listSaves(gameId)).length, 1);
  await assert.rejects(
    restarted.dashboard(gameId, turn.turnId),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error &&
      error.code === "DASHBOARD_ALREADY_SHOWN"),
  );

  const noWriteTurn = await restarted.prepareTurn(gameId, "只查看狀態，不修改資料");
  const dashboard = await restarted.dashboard(gameId);
  assert.equal(dashboard.game.revision, 1);
  assert.equal(dashboard.turnId, noWriteTurn.turnId);
  assert.equal(dashboard.dashboardKey, `${gameId}:${noWriteTurn.turnId}:1`);
  await assert.rejects(
    restarted.dashboard(gameId, noWriteTurn.turnId),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error &&
      error.code === "DASHBOARD_ALREADY_SHOWN"),
  );
  console.log("PostgreSQL 端到端驗收通過：狀態、快照、重啟持久性、舊 schema 相容與單回合面板鎖均正常。");
} finally {
  await store?.close().catch(() => undefined);
  await restartedStore?.close().catch(() => undefined);
  if (gameCreated) {
    const cleanup = new Pool({
      connectionString,
      ssl: ssl ? { rejectUnauthorized: false } : undefined,
      max: 1,
    });
    try {
      await cleanup.query("DELETE FROM aegis_saves WHERE game_id = $1", [gameId]);
      await cleanup.query("DELETE FROM aegis_games WHERE game_id = $1", [gameId]);
    } finally {
      await cleanup.end();
    }
  }
}
