import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { defaultGameState, MIGRATION_KEY, SCHEMA_VERSION } from "../src/domain/default-state.js";
import type { JsonObject } from "../src/domain/types.js";
import { AegisService } from "../src/service.js";
import { PostgresGameStore } from "../src/storage/postgres-store.js";

const connectionString = process.env.AEGIS_POSTGRES_E2E_URL?.trim();
if (!connectionString) {
  throw new Error("請先設定 AEGIS_POSTGRES_E2E_URL；驗收只會建立並清除自己的隨機測試遊戲。");
}

const ssl = process.env.AEGIS_POSTGRES_E2E_SSL === "true";
const gameId = `postgres-e2e-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
const legacyGameId = `postgres-legacy-${randomUUID().replaceAll("-", "").slice(0, 18)}`;
const config = {
  maxDiffBytes: 512 * 1024,
  maxStateBytes: 2 * 1024 * 1024,
};

let store: PostgresGameStore | null = new PostgresGameStore(connectionString, ssl);
let restartedStore: PostgresGameStore | null = null;
const createdGameIds = new Set<string>();

try {
  await store.initialize();
  const service = new AegisService(store, config);
  await service.createGame(gameId, "PostgreSQL 端到端驗收");
  createdGameIds.add(gameId);
  const turn = await service.prepareTurn(gameId, "建立測試角色並顯示面板");
  const initialized = await service.applyDiff(
    gameId,
    turn.revision,
    `postgres-e2e-write-${randomUUID()}`,
    {
      player: { initialized: true, name: "資料庫驗收者", money: 17, location: { mapId: "map-db-a" } },
      map: [{ mapId: "map-db-a", name: "資料庫起點", kind: "place", discovery: "visited" }],
      npcs: [{
        npcId: "npc-db-guide", name: "資料庫嚮導", familiarity: "met",
        location: { mapId: "map-db-a", status: "current" },
      }],
    },
    "PostgreSQL persistence verification",
  );
  assert.equal(initialized.game.revision, 1);
  const travelKey = `postgres-e2e-travel-${randomUUID()}`;
  const traveled = await service.advanceTime(
    gameId, 1, travelKey, undefined, "travel", "temperate", "前往資料庫終點",
    0, 0, undefined, undefined,
    {
      player: { location: { mapId: "map-db-b" } },
      map: { upsert: [
        {
          mapId: "map-db-a",
          routes: [{ routeId: "route-db-a-b", toMapId: "map-db-b", estimatedMinutes: 60, knowledgeStatus: "verified" }],
        },
        { mapId: "map-db-b", name: "資料庫終點", kind: "place", discovery: "visited" },
      ] },
      quests: { upsert: [{ questId: "quest-db", name: "資料庫驗收任務", status: "active" }] },
      npcs: { upsert: [{ npcId: "npc-db-guide", questIds: ["quest-db"] }] },
      compendium: { upsert: [{
        entryId: "entry-db", name: "資料庫苔蘚", category: "plant", categoryLabel: "植物", stage: "observed",
        relatedMapIds: ["map-db-b"],
        facts: [{
          factId: "fact-db", text: "只在驗收資料中存在", confidence: "medium",
          sources: [{ sourceType: "observation", sourceId: "map-db-b", description: "端到端驗收" }],
        }],
      }] },
      history: { append: [{ type: "location_discovered", mapName: "資料庫終點" }] },
    },
    60,
  );
  assert.equal(traveled.game.revision, 2);
  assert.equal(traveled.game.player.location?.mapId, "map-db-b");
  assert.equal(traveled.game.history.recent.filter((event) =>
    typeof event === "object" && event !== null && !Array.isArray(event) && event.type === "travel").length, 1);
  const replay = await service.advanceTime(
    gameId, 1, travelKey, undefined, "travel", "temperate", "前往資料庫終點",
    0, 0, undefined, undefined, undefined, 60,
  );
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.game.revision, 2);
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
  assert.equal((persisted.player.location as JsonObject).mapId, "map-db-b");
  assert.equal((persisted.player.clock as JsonObject).minuteOfDay, 540);
  assert.equal((persisted.npcs[0]?.location as JsonObject).status, "last_known");
  assert.equal(persisted.history.recent.filter((event) =>
    typeof event === "object" && event !== null && !Array.isArray(event) && event.type === "travel").length, 1);
  assert.equal((await restarted.getPrivateWorldInternal(gameId)).gameId, gameId);
  assert.equal((await restarted.listSaves(gameId)).length, 1);
  await assert.rejects(
    restarted.dashboard(gameId, turn.turnId),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error &&
      error.code === "DASHBOARD_ALREADY_SHOWN"),
  );

  const noWriteTurn = await restarted.prepareTurn(gameId, "只查看狀態，不修改資料");
  const dashboard = await restarted.dashboard(gameId);
  assert.equal(dashboard.game.revision, 2);
  assert.equal(dashboard.turnId, noWriteTurn.turnId);
  assert.equal(dashboard.dashboardKey, `${gameId}:${noWriteTurn.turnId}:2`);
  assert.equal(JSON.stringify(dashboard).includes("privateState"), false);
  await assert.rejects(
    restarted.dashboard(gameId, noWriteTurn.turnId),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error &&
      error.code === "DASHBOARD_ALREADY_SHOWN"),
  );

  const legacy = defaultGameState(legacyGameId, "舊 Schema 遷移驗收");
  legacy.schemaVersion = "6.7.7-mcp.5.2";
  legacy.version = "6.7.7-mcp.5.2";
  delete (legacy.engine.migrations as JsonObject)[MIGRATION_KEY];
  legacy.player.location = { region: "舊區域", location: "舊地點" };
  legacy.npcs = [{
    id: "legacy-db-npc", name: "舊人物", familiarity: "met", location: "舊地點",
    trueIdentity: "POSTGRES_PRIVATE_SENTINEL", privateState: { objective: "不得公開" },
  }];
  await restartedStore.createGame(legacy);
  createdGameIds.add(legacyGameId);
  const migrated = await restarted.getGame(legacyGameId);
  assert.equal(migrated.schemaVersion, SCHEMA_VERSION);
  assert.equal(JSON.stringify(migrated).includes("POSTGRES_PRIVATE_SENTINEL"), false);
  assert.equal((await restarted.getPrivateWorldInternal(legacyGameId)).npcs["legacy-db-npc"]?.trueIdentity, "POSTGRES_PRIVATE_SENTINEL");
  assert.equal((await restartedStore.listMigrationBackups(legacyGameId)).length, 1);

  console.log("PostgreSQL 端到端驗收通過：v0.6 旅行原子交易、時鐘、知識、冪等重試、私密狀態、遷移備份、重啟持久性與單回合面板鎖均正常。");
} finally {
  await store?.close().catch(() => undefined);
  await restartedStore?.close().catch(() => undefined);
  if (createdGameIds.size) {
    const cleanup = new Pool({
      connectionString,
      ssl: ssl ? { rejectUnauthorized: false } : undefined,
      max: 1,
    });
    try {
      for (const createdGameId of createdGameIds) {
        await cleanup.query("DELETE FROM aegis_saves WHERE game_id = $1", [createdGameId]);
        await cleanup.query("DELETE FROM aegis_games WHERE game_id = $1", [createdGameId]);
      }
    } finally {
      await cleanup.end();
    }
  }
}
