import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AegisService } from "../src/service.js";
import { FileGameStore } from "../src/storage/file-store.js";

describe("aegis_advance_time v0.7 atomic transaction", () => {
  let directory: string;
  let store: FileGameStore;
  let service: AegisService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "aegis-time-v7-"));
    store = new FileGameStore(directory);
    await store.initialize();
    service = new AegisService(store, {
      maxDiffBytes: 512 * 1024,
      maxStateBytes: 2 * 1024 * 1024,
    });
    await service.createGame("main");
  });

  afterEach(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("accepts integer minutes, keeps elapsed_hours compatibility, and rejects ambiguous input", async () => {
    const minutes = await service.advanceTime(
      "main", 0, "minutes-75", undefined, "normal", "temperate", "整理營地", 0, 0,
      undefined, undefined, undefined, 75,
    );
    expect(minutes.game).toMatchObject({
      revision: 1,
      player: {
        clock: { year: 742, monthId: "sprout", day: 1, minuteOfDay: 555 },
        time: "上午 09:15",
        survival: { elapsedGameMinutes: 75 },
      },
    });
    expect(minutes.game.history.recent).toEqual([
      expect.objectContaining({ type: "time_elapsed", elapsedMinutes: 75, revision: 1 }),
    ]);

    const hours = await service.advanceTime(
      "main", 1, "hours-point-one", 0.1, "rest", "temperate", "短暫休息",
    );
    expect(hours.game.player).toMatchObject({
      clock: { minuteOfDay: 561 },
      survival: { elapsedGameMinutes: 81 },
    });

    await expect(service.advanceTime(
      "main", 2, "ambiguous-time", 1, "normal", "temperate", "錯誤輸入", 0, 0,
      undefined, undefined, undefined, 60,
    )).rejects.toMatchObject({ code: "INVALID_DIFF" });
    await expect(service.advanceTime(
      "main", 2, "missing-time", undefined, "normal", "temperate", "錯誤輸入",
    )).rejects.toMatchObject({ code: "INVALID_DIFF" });
    expect((await service.getGame("main")).revision).toBe(2);
  });

  it("commits travel time, survival, location, route, NPC, quest, compendium, and history once", async () => {
    const setup = await service.applyDiff("main", 0, "travel-setup", {
      player: { location: { mapId: "map-town" } },
      map: [{ mapId: "map-town", name: "白樺渡鎮", kind: "town", discovery: "visited" }],
      npcs: [{
        npcId: "npc-guide", name: "嚮導布蘭", familiarity: "met",
        location: { mapId: "map-town", status: "current" },
      }],
    });

    const traveled = await service.advanceTime(
      "main", setup.game.revision, "travel-town-valley", undefined, "travel", "temperate",
      "沿北門道路抵達淺谷入口", 0, 0, undefined, undefined,
      {
        player: { location: { mapId: "map-valley" } },
        map: { upsert: [
          {
            mapId: "map-town",
            routes: [{
              routeId: "route-town-valley", toMapId: "map-valley", estimatedMinutes: 90,
              travelMode: "walk", danger: "moderate", knowledgeStatus: "verified",
            }],
          },
          {
            mapId: "map-valley", name: "淺谷入口", kind: "place", discovery: "visited",
            knownDangers: [{ dangerId: "danger-wolves", name: "狼群足跡", severity: "moderate" }],
          },
        ] },
        quests: { upsert: [{ questId: "quest-herb", name: "銀脈草採集", status: "active" }] },
        npcs: { upsert: [{
          npcId: "npc-guide",
          knownInformation: [{
            infoId: "info-valley", content: "淺谷東側較安全", confidence: "high",
            sourceType: "observation", sourceId: "map-valley",
          }],
          services: [{ serviceId: "service-guide", name: "道路指引" }],
          memories: [{ memoryId: "memory-guided", summary: "曾引導玩家抵達淺谷", importance: "important" }],
          questIds: ["quest-herb"],
        }] },
        compendium: { upsert: [{
          entryId: "entry-herb", name: "銀脈草", category: "plant", categoryLabel: "植物",
          stage: "observed", relatedMapIds: ["map-valley"], questIds: ["quest-herb"],
          facts: [{
            factId: "fact-herb-glow", text: "葉脈在陰影中泛銀光", confidence: "medium",
            sources: [{ sourceType: "observation", sourceId: "map-valley", description: "親眼觀察" }],
          }],
        }] },
        history: { append: [{ type: "location_discovered", mapName: "淺谷入口" }] },
      },
      90,
    );

    expect(traveled.game.revision).toBe(2);
    expect(traveled.game.player).toMatchObject({
      location: { mapId: "map-valley" },
      clock: { minuteOfDay: 570 },
      survival: { hunger: 96.25, hydration: 94.37, elapsedGameMinutes: 90 },
    });
    expect(traveled.game.map.find((entry) => entry.mapId === "map-town")?.routes).toEqual([
      expect.objectContaining({ routeId: "route-town-valley", toMapId: "map-valley", knowledgeStatus: "verified" }),
    ]);
    expect(traveled.game.map.find((entry) => entry.mapId === "map-valley")?.knownDangers).toEqual([
      expect.objectContaining({ dangerId: "danger-wolves" }),
    ]);
    expect(traveled.game.npcs[0]).toMatchObject({
      location: { mapId: "map-town", status: "last_known", observedAtRevision: 2 },
      questIds: ["quest-herb"],
    });
    expect(traveled.game.compendium[0]).toMatchObject({
      entryId: "entry-herb", stage: "observed",
      facts: [expect.objectContaining({ factId: "fact-herb-glow", firstLearnedAtRevision: 2 })],
    });
    expect(traveled.game.history.recent).toHaveLength(2);
    expect(traveled.game.history.recent).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "travel", fromMapId: "map-town", toMapId: "map-valley", revision: 2 }),
      expect.objectContaining({ type: "location_discovered", mapName: "淺谷入口", revision: 2 }),
    ]));
    expect(new Set(traveled.game.history.recent.map((event) => (event as { eventId: string }).eventId)).size).toBe(2);

    const replay = await service.advanceTime(
      "main", setup.game.revision, "travel-town-valley", undefined, "travel", "temperate",
      "沿北門道路抵達淺谷入口", 0, 0, undefined, undefined, undefined, 90,
    );
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.game.revision).toBe(2);
    expect(replay.game.player.clock).toEqual(traveled.game.player.clock);
    expect(replay.game.history.recent).toHaveLength(2);
  });

  it("rolls back the whole time transaction when outcome validation fails or repeats the main event", async () => {
    const setup = await service.applyDiff("main", 0, "invalid-travel-setup", {
      player: { location: { mapId: "map-a" } },
      map: [{ mapId: "map-a", name: "甲地", kind: "place", discovery: "visited" }],
    });
    const before = await service.getGame("main");

    await expect(service.advanceTime(
      "main", setup.game.revision, "invalid-destination", undefined, "travel", "temperate", "走向未知地點",
      0, 0, undefined, undefined, { player: { location: { mapId: "missing" } } }, 30,
    )).rejects.toMatchObject({ code: "INVALID_DIFF" });
    await expect(service.advanceTime(
      "main", setup.game.revision, "duplicate-main-event", undefined, "travel", "temperate", "重複事件",
      0, 0, undefined, undefined,
      { history: { append: [{ type: "travel", summary: "重複主要旅行事件" }] } }, 30,
    )).rejects.toMatchObject({ code: "INVALID_DIFF" });
    await expect(service.advanceTime(
      "main", setup.game.revision, "private-outcome", undefined, "normal", "temperate", "私密欄位測試",
      0, 0, undefined, undefined, { world: { privateState: { leaked: true } } }, 30,
    )).rejects.toMatchObject({ code: "INVALID_DIFF" });
    await expect(service.advanceTime(
      "main", setup.game.revision, "world-outcome", undefined, "normal", "temperate", "固定世界測試",
      0, 0, undefined, undefined, { world: { name: "其他世界" } }, 30,
    )).rejects.toThrow(/固定世界艾爾維亞/);

    expect(await service.getGame("main")).toEqual(before);
  });
});
