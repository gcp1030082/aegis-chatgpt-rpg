import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildGameMigration,
  createMigrationBackup,
  defaultGameState,
  MIGRATION_KEY,
  SCHEMA_VERSION,
} from "../src/domain/default-state.js";
import type { GameState, JsonObject } from "../src/domain/types.js";
import { AegisService } from "../src/service.js";
import { FileGameStore } from "../src/storage/file-store.js";

describe("v0.6 safe migration", () => {
  let directory: string;
  let store: FileGameStore;
  let service: AegisService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "aegis-migration-v6-"));
    store = new FileGameStore(directory);
    await store.initialize();
    service = new AegisService(store, {
      maxDiffBytes: 512 * 1024,
      maxStateBytes: 2 * 1024 * 1024,
    });
  });

  afterEach(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("backs up and migrates the curated main hierarchy, structured routes, IDs, clock, and private NPC state once", async () => {
    const legacy = legacyMainState();
    await store.createGame(legacy);

    const migrated = await service.getGame("main");
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
    expect((migrated.engine.migrations as JsonObject)[MIGRATION_KEY]).toMatchObject({
      sourceVersion: "6.7.7-mcp.5.2", targetVersion: "0.6.0",
    });
    expect(migrated.player).toMatchObject({
      location: {
        mapId: "map-birch-hollow-entrance-001",
        region: "洛薩邊境",
        location: "北岸白樺淺谷",
        sublocation: "淺谷入口",
      },
      clock: { year: 744, monthId: "frost", day: 17, minuteOfDay: 15 * 60 + 5 },
      date: "群星曆744年・霜月17日",
      time: "下午 03:05",
      season: "秋季",
    });

    const byName = new Map(migrated.map.map((entry) => [entry.name, entry]));
    expect(byName.get("白樺渡鎮")).toMatchObject({ mapId: "map-white-birch-town-001", parentMapId: "map-lothar-border-001", kind: "town" });
    expect(byName.get("北岸白樺淺谷")).toMatchObject({ mapId: "map-north-birch-valley-001", parentMapId: "map-lothar-border-001", kind: "place" });
    expect(byName.get("淺谷入口")).toMatchObject({ mapId: "map-birch-hollow-entrance-001", parentMapId: "map-north-birch-valley-001", kind: "subplace" });
    expect(byName.get("北岸白樺淺谷")?.parentMapId).not.toBe("map-white-birch-town-001");
    expect(byName.get("白樺渡鎮")?.routes).toEqual([
      expect.objectContaining({
        toMapId: "map-north-birch-valley-001", estimatedMinutes: 55, knowledgeStatus: "verified",
      }),
    ]);
    expect(migrated.map.flatMap((entry) => Array.isArray(entry.routes) ? entry.routes : [])).toHaveLength(1);
    expect(byName.get("北岸白樺淺谷")?.facilities).toEqual([
      expect.objectContaining({ facilityId: expect.stringMatching(/^facility-/), name: "採集點" }),
    ]);
    expect(byName.get("北岸白樺淺谷")?.knownDangers).toEqual([
      expect.objectContaining({ dangerId: expect.stringMatching(/^danger-/), name: "狼群" }),
    ]);

    const questId = String(migrated.quests[0]?.questId);
    expect(questId).toMatch(/^quest-/);
    expect(migrated.npcs[0]).toMatchObject({
      npcId: "legacy-npc-bran", relationship: { label: "既有關係紀錄 3" },
      location: { name: "白樺渡鎮", status: "last_known" }, questIds: [questId],
    });
    expect(migrated.compendium[0]).toMatchObject({
      entryId: "legacy-entry-herb", categoryLabel: "植物", stage: "identified", questIds: [questId],
      facts: [expect.objectContaining({ factId: expect.stringMatching(/^fact-/), sources: [expect.any(Object)] })],
    });
    expect(migrated.history.recent.every((event) => typeof event === "object" && event !== null && "eventId" in event)).toBe(true);

    const backups = await store.listMigrationBackups("main");
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatchObject({ sourceVersion: "6.7.7-mcp.5.2", sourceRevision: 17 });
    expect(backups[0]?.state.schemaVersion).toBe("6.7.7-mcp.5.2");
    const privateWorld = await service.getPrivateWorldInternal("main");
    expect(privateWorld.npcs["legacy-npc-bran"]).toMatchObject({
      trueIdentity: "流亡貴族", trueLocation: "灰葉藥鋪後室", privateState: { objective: "隱瞞身份" },
    });
    expect(JSON.stringify(migrated)).not.toContain("流亡貴族");
    expect(JSON.stringify(migrated)).not.toContain("灰葉藥鋪後室");

    const again = await service.getGame("main");
    expect(again).toEqual(migrated);
    expect(await store.listMigrationBackups("main")).toHaveLength(1);
    expect(again.map).toHaveLength(migrated.map.length);
    expect(again.quests[0]?.questId).toBe(questId);
  });

  it("is deterministic when the same legacy source is migrated repeatedly", () => {
    const legacy = legacyMainState();
    const left = buildGameMigration(legacy).game;
    const right = buildGameMigration(legacy).game;
    expect(left.map).toEqual(right.map);
    expect(left.quests).toEqual(right.quests);
    expect(left.npcs).toEqual(right.npcs);
    expect(left.compendium).toEqual(right.compendium);
    expect(left.history).toEqual(right.history);
  });

  it("commits a missing migration marker even when schemaVersion already says 0.6.0", async () => {
    const partial = defaultGameState("missing-marker");
    delete (partial.engine.migrations as JsonObject)[MIGRATION_KEY];
    await store.createGame(partial);
    const migrated = await service.getGame("missing-marker");
    expect((migrated.engine.migrations as JsonObject)[MIGRATION_KEY]).toMatchObject({
      sourceVersion: SCHEMA_VERSION,
      targetVersion: SCHEMA_VERSION,
    });
    expect(await store.listMigrationBackups("missing-marker")).toHaveLength(1);
    await service.getGame("missing-marker");
    expect(await store.listMigrationBackups("missing-marker")).toHaveLength(1);
  });

  it("recovers a sparse legacy file whose optional collections and core records are missing", async () => {
    const sparse = defaultGameState("sparse-legacy");
    markLegacy(sparse);
    const raw = sparse as unknown as Record<string, unknown>;
    delete raw.npcs;
    delete raw.map;
    delete raw.compendium;
    delete raw.quests;
    delete raw.inventory;
    delete raw.history;
    delete raw.player;
    delete raw.world;
    delete raw.engine;
    delete raw.revision;
    delete raw.createdAt;
    delete raw.updatedAt;
    await store.createGame(sparse);

    const migrated = await service.getGame("sparse-legacy");
    expect(migrated).toMatchObject({
      schemaVersion: SCHEMA_VERSION,
      revision: 0,
      inventory: [],
      npcs: [],
      map: [],
      compendium: [],
      quests: [],
      history: { recent: [], major: [], summary: [] },
      player: { initialized: false, clock: { monthId: "sprout" } },
      world: { calendar: { calendarId: "eldra-stars-calendar" } },
    });
    expect(await store.listMigrationBackups("sparse-legacy")).toHaveLength(1);
  });

  it("preserves the original schema and state when migration validation fails, while retaining a recovery backup", async () => {
    const broken = defaultGameState("broken-migration");
    markLegacy(broken);
    broken.map = [{
      mapId: "map-broken", name: "破損地點", kind: "place", discovery: "known",
      routes: [{ routeId: "route-broken", toMapId: "map-missing" }],
    }];
    const original = structuredClone(broken);
    await store.createGame(broken);

    await expect(service.getGame("broken-migration")).rejects.toMatchObject({
      code: expect.stringMatching(/INVALID_(STATE|DIFF)/),
    });
    expect(await store.getGame("broken-migration")).toEqual(original);
    expect((await store.getGame("broken-migration"))?.schemaVersion).toBe("6.7.7-mcp.5.2");
    const backups = await store.listMigrationBackups("broken-migration");
    expect(backups).toHaveLength(1);
    expect(backups[0]?.state).toEqual(original);
  });

  it("keeps only the three newest internal migration backups", async () => {
    const state = defaultGameState("backup-retention");
    await store.createGame(state);
    for (let revision = 0; revision < 5; revision += 1) {
      const source = structuredClone(state);
      source.revision = revision;
      const backup = createMigrationBackup(source, `legacy-${revision}`, new Date(2026, 0, revision + 1).toISOString());
      await store.createMigrationBackup(backup);
    }
    const backups = await store.listMigrationBackups("backup-retention");
    expect(backups).toHaveLength(3);
    expect(backups.map((backup) => backup.sourceRevision)).toEqual([4, 3, 2]);
  });
});

function legacyMainState(): GameState {
  const state = defaultGameState("main");
  markLegacy(state);
  state.revision = 17;
  state.engine.autoSave = { status: "saved", revision: 17, savedAt: state.updatedAt };
  delete state.world.calendar;
  delete state.player.clock;
  state.player.date = "群星曆744年・霜月17日";
  state.player.time = "下午 03:05";
  state.player.season = "舊錯誤季節";
  state.player.location = {
    region: "洛薩邊境", location: "北岸白樺淺谷", sublocation: "淺谷入口",
  };
  state.map = [
    { mapId: "legacy-map-region", name: "洛薩邊境", kind: "region", discovery: "known" },
    { mapId: "legacy-map-town", name: "白樺渡鎮", kind: "town", discovery: "visited", parentMapId: "legacy-map-region" },
    {
      mapId: "legacy-map-valley", name: "北岸白樺淺谷", kind: "place", discovery: "known",
      parentMapId: "legacy-map-town", facilities: ["採集點"], dangers: ["狼群"],
    },
  ];
  state.quests = [{ title: "銀脈草採集", status: "active" }];
  state.npcs = [{
    id: "legacy-npc-bran", name: "布蘭", familiarity: "met", relationship: 3, location: "白樺渡鎮",
    knownInformation: ["淺谷有銀脈草"], services: ["道路指引"],
    memories: [{ text: "曾提供採集建議" }], questIds: ["銀脈草採集"],
    trueIdentity: "流亡貴族", trueLocation: "灰葉藥鋪後室", privateState: { objective: "隱瞞身份" },
  }];
  state.compendium = [{
    id: "legacy-entry-herb", name: "銀脈草", category: "plant", identified: true,
    knownFacts: ["葉脈會泛銀光"], sources: ["布蘭的說法"], confidence: "high",
    relatedMapIds: ["legacy-map-valley"], relatedNpcIds: ["legacy-npc-bran"], questIds: ["銀脈草採集"],
  }];
  state.history.recent = [
    {
      type: "travel", fromMapId: "legacy-map-town", toMapId: "legacy-map-valley",
      actualTravelMinutes: 55, summary: "從白樺渡鎮前往淺谷",
    },
    "曾聽說酒館能走到廢棄瞭望塔，但沒有正式路線資料",
  ];
  return state;
}

function markLegacy(state: GameState): void {
  state.schemaVersion = "6.7.7-mcp.5.2";
  state.version = "6.7.7-mcp.5.2";
  delete (state.engine.migrations as JsonObject)[MIGRATION_KEY];
}
