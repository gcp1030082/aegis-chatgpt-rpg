import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AegisService } from "../src/service.js";
import { FileGameStore } from "../src/storage/file-store.js";
import { defaultGameState, defaultPrivateWorldState, MIGRATION_KEY } from "../src/domain/default-state.js";
import type { JsonObject } from "../src/domain/types.js";

describe("AegisService", () => {
  let directory: string;
  let store: FileGameStore;
  let service: AegisService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "aegis-test-"));
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

  it("creates, commits, retries idempotently, and keeps developer recovery snapshots internal", async () => {
    await service.createGame("main", "測試世界");
    const first = await service.applyDiff(
      "main",
      0,
      "turn-1",
      { player: { name: "洛恩", money: 10 }, history: ["醒來。"] },
      "角色甦醒",
    );
    expect(first.game.revision).toBe(1);
    expect(first.game.engine.autoSave).toMatchObject({ status: "saved", revision: 1 });

    const replay = await service.applyDiff("main", 0, "turn-1", { player: { money: 999 } });
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.game.player.money).toBe(10);

    const save = await service.createSave("main", "起點", "save-1");
    expect(save.sourceRevision).toBe(1);
    const repeatedSave = await service.createSave("main", "起點", "save-1");
    expect(repeatedSave.saveId).toBe(save.saveId);

    await service.applyDiff("main", 1, "turn-2", { player: { money: 3 } });
    const loaded = await service.loadSave("main", save.saveId, 2, "load-1");
    expect(loaded.game.revision).toBe(3);
    expect(loaded.game.player.money).toBe(10);
    expect((await service.listSaves("main"))).toHaveLength(1);
  });

  it("rejects stale writes", async () => {
    await service.createGame("main");
    await service.applyDiff("main", 0, "turn-1", { player: { money: 1 } });
    await expect(
      service.applyDiff("main", 0, "turn-stale", { player: { money: 2 } }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  });

  it("atomically resets all player progress and private NPC state while preserving Aelvia and recovery snapshots", async () => {
    await service.createGame("main", "測試世界");
    const skills = Array.from({ length: 6 }, (_, index) => ({ id: `skill-${index}`, name: `舊技能${index}` }));
    const inventory = Array.from({ length: 6 }, (_, index) => ({
      id: `item-${index}`, name: `舊物品${index}`, quantity: 1, category: "misc",
    }));
    const equipmentItems = Array.from({ length: 8 }, (_, index) => ({
      id: `equip-${index}`,
      instanceId: `equipped-instance-${index}`,
      name: `舊裝備${index}`,
      category: "equipment",
      quantity: 1,
      equipmentSlot: `slot-${index}`,
      modifiers: [{ stat: "defense", operation: "add", value: index + 1 }],
    }));
    const populated = await service.applyDiff("main", 0, "populate-reset-fixture", {
      player: {
        initialized: true,
        name: "舊角色洛恩",
        race: "人類",
        background: "舊角色背景",
        level: 9,
        hp: 88,
        mp: 30,
        sp: 50,
        weather: "晴",
        location: { mapId: "map-1", region: "舊地區", location: "舊城鎮" },
        attributes: { strength: 8 },
        skills,
      },
      inventory: [...inventory, ...equipmentItems],
      quests: [{ id: "quest-1", name: "舊任務一" }, { id: "quest-2", name: "舊任務二" }],
      history: { recent: ["近期一", "近期二", "近期三"], major: ["重大一"], summary: ["舊摘要"] },
      npcs: [{
        npcId: "npc-1", name: "世界居民", familiarity: "trusted", relationship: "摯友",
        location: { mapId: "map-1", name: "舊城鎮", status: "current" },
        knownInformation: [{ infoId: "info-1", text: "舊角色知道的情報", confidence: "high" }],
      }],
      map: [{ mapId: "map-1", name: "舊城鎮", kind: "town", discovery: "visited" }],
      compendium: [{
        entryId: "book-1", name: "舊角色圖鑑", category: "culture", stage: "identified", confidence: "high",
        sources: [{ type: "observation", name: "舊角色觀察" }], relatedMapIds: ["map-1"],
      }],
    });
    expect(populated.game.revision).toBe(1);
    let revision = populated.game.revision;
    for (let index = 0; index < equipmentItems.length; index += 1) {
      const equipped = await service.equipItem(
        "main", revision, `equip-reset-fixture-${index}`, `equipped-instance-${index}`, `slot-${index}`,
      );
      revision = equipped.game.revision;
    }
    const ready = await service.getGame("main");
    expect(ready.inventory).toHaveLength(6);
    expect(Object.keys(ready.player.equipment ?? {})).toHaveLength(8);
    const privateWorld = defaultPrivateWorldState("main", ready.updatedAt);
    privateWorld.npcs["npc-private-old"] = {
      trueIdentity: "舊世界私密身份",
      privateState: { objective: "舊角色專屬目標" },
    };
    await store.putPrivateWorld(privateWorld);
    await service.createSave("main", "重設前快照", "save-before-reset");

    const reset = await service.resetPlayer("main", revision, "reset-player-1");
    expect(reset.game.revision).toBe(revision + 1);
    expect(reset.game.player).toMatchObject({
      initialized: false,
      tick: 0,
      money: 0,
      skills: [],
      equipment: {},
      equippedItems: {},
      activeEquipmentModifiers: [],
      attributes: {},
      survival: { hunger: 100, hydration: 100 },
    });
    expect(reset.game.inventory).toEqual([]);
    expect(reset.game.quests).toEqual([]);
    expect(reset.game.history).toEqual({ recent: [], major: [], summary: [] });
    expect(reset.game.world).toMatchObject({ worldId: "aelvia", name: "艾爾維亞" });
    expect(reset.game.npcs).toEqual([]);
    expect(reset.game.map).toEqual([]);
    expect(reset.game.compendium).toEqual([]);
    expect(JSON.stringify(reset.game)).not.toContain("舊角色洛恩");
    expect(JSON.stringify(reset.game)).not.toContain("舊技能");
    expect(JSON.stringify(reset.game)).not.toContain("舊任務");
    expect(JSON.stringify(reset.game)).not.toContain("舊摘要");
    expect((await service.getPrivateWorldInternal("main")).npcs).toEqual({});
    expect(await service.listSaves("main")).toHaveLength(1);
    expect(reset.game.engine.autoSave).toMatchObject({ status: "saved", revision: revision + 1 });
    expect(reset.game.engine.transactionLog).toHaveLength(1);

    const replay = await service.resetPlayer("main", revision, "reset-player-1");
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.game.revision).toBe(revision + 1);
  });

  it("moves unique item instances atomically when equipping, swapping, and unequipping", async () => {
    await service.createGame("main");
    const added = await service.applyDiff("main", 0, "add-equipment", {
      inventory: [
        {
          id: "bronze-sword", instanceId: "item-bronze", name: "青銅劍", category: "equipment", quantity: 1,
          equipmentSlot: "mainHand", modifiers: [{ stat: "attack", operation: "add", value: 2 }],
          acquisition: { type: "initial_item", sourceName: "角色創建", obtainedAtTick: 0 },
        },
        {
          id: "iron-sword", instanceId: "item-iron", name: "鐵劍", category: "equipment", quantity: 1,
          equipmentSlot: "mainHand", modifiers: [{ stat: "attack", operation: "add", value: 4 }],
          acquisition: { type: "loot", sourceName: "盜匪首領" },
        },
      ],
    });

    await expect(service.equipItem("main", added.game.revision, "equip-wrong-slot", "item-bronze", "feet"))
      .rejects.toMatchObject({ code: "INVALID_DIFF" });
    expect((await service.getGame("main")).revision).toBe(added.game.revision);

    const first = await service.equipItem("main", added.game.revision, "equip-bronze", "item-bronze", "mainHand");
    expect(first.game.player.equipment).toEqual({ mainHand: "item-bronze" });
    expect(first.game.inventory.map((item) => item.instanceId)).toEqual(["item-iron"]);
    expect(first.game.player.equippedItems).toMatchObject({
      "item-bronze": { instanceId: "item-bronze", location: "equipped", equippedSlot: "mainHand" },
    });
    expect(first.game.player.activeEquipmentModifiers).toEqual([
      expect.objectContaining({ stat: "attack", value: 2, sourceInstanceId: "item-bronze" }),
    ]);
    await expect(service.applyDiff("main", first.game.revision, "drop-equipped", {
      inventory: { remove: [{ instanceId: "item-bronze" }] },
    })).rejects.toMatchObject({ code: "NO_STATE_CHANGE" });

    const swapped = await service.equipItem("main", first.game.revision, "equip-iron", "item-iron", "mainHand");
    expect(swapped.game.player.equipment).toEqual({ mainHand: "item-iron" });
    expect(swapped.game.inventory.map((item) => item.instanceId)).toEqual(["item-bronze"]);
    expect(Object.keys(swapped.game.player.equippedItems as object)).toEqual(["item-iron"]);
    expect(new Set([
      ...swapped.game.inventory.map((item) => item.instanceId),
      ...Object.keys(swapped.game.player.equippedItems as object),
    ]).size).toBe(2);

    const replay = await service.equipItem("main", first.game.revision, "equip-iron", "item-iron", "mainHand");
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.game.revision).toBe(swapped.game.revision);

    const removed = await service.unequipItem("main", swapped.game.revision, "unequip-iron", "mainHand");
    expect(removed.game.player.equipment).toEqual({ mainHand: null });
    expect(removed.game.player.equippedItems).toEqual({});
    expect(removed.game.player.activeEquipmentModifiers).toEqual([]);
    expect(removed.game.inventory.map((item) => item.instanceId).sort()).toEqual(["item-bronze", "item-iron"]);
  });

  it("settles time, consumes food and container capacity, and refills safely", async () => {
    await service.createGame("main");
    await service.applyDiff("main", 0, "add-survival-items", {
      player: { initialized: true },
      inventory: [
        { id: "ration", name: "乾糧", category: "consumable", quantity: 2, hungerRestore: 30 },
        {
          id: "water-skin", name: "水袋", category: "consumable", quantity: 1,
          hydrationRestore: 25, usesRemaining: 3, maxUses: 3, refillable: true,
        },
      ],
    });

    const elapsed = await service.advanceTime(
      "main", 1, "time-travel-hot", 2, "travel", "hot", "穿越炎熱道路",
    );
    expect(elapsed.game.revision).toBe(2);
    expect(elapsed.survival).toMatchObject({ hunger: 95, hydration: 88.75, elapsedGameMinutes: 120 });
    expect(elapsed.hungerCost).toBe(5);
    expect(elapsed.hydrationCost).toBe(11.25);
    const elapsedReplay = await service.advanceTime(
      "main", 1, "time-travel-hot", 2, "travel", "hot", "穿越炎熱道路",
    );
    expect(elapsedReplay.idempotentReplay).toBe(true);
    expect(elapsedReplay.game.revision).toBe(2);
    expect(elapsedReplay.survival.elapsedGameMinutes).toBe(120);

    const ate = await service.useItem("main", 2, "use-ration", "ration", false);
    expect(ate.survival.hunger).toBe(100);
    expect(ate.appliedHungerDelta).toBe(5);
    expect(ate.game.inventory.find((item) => item.id === "ration")?.quantity).toBe(1);

    await service.useItem("main", 3, "drink-1", "water-skin", false);
    await service.useItem("main", 4, "drink-2", "water-skin", false);
    const emptied = await service.useItem("main", 5, "drink-3", "water-skin", false);
    const emptyBag = emptied.game.inventory.find((item) => item.id === "water-skin");
    expect(emptyBag).toMatchObject({ usesRemaining: 0, maxUses: 3, state: "empty" });

    const refilled = await service.refillContainer("main", 6, "refill-1", "water-skin", "村莊乾淨水井");
    expect(refilled.game.inventory.find((item) => item.id === "water-skin"))
      .toMatchObject({ usesRemaining: 3, state: "filled" });
    const replay = await service.refillContainer("main", 6, "refill-1", "water-skin", "村莊乾淨水井");
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.game.revision).toBe(7);
  });

  it("atomically settles travel time with location, map, NPC, and compendium discovery", async () => {
    await service.createGame("main");
    const traveled = await service.advanceTime(
      "main", 0, "travel-discovery", 1, "travel", "temperate", "抵達溪谷並首次遇見巡林者",
      0, 0, "群星曆一日", "上午 10:00",
      {
        player: { initialized: true, name: "旅人", location: { mapId: "place-creek", location: "銀溪谷" } },
        map: [{ mapId: "place-creek", name: "銀溪谷", kind: "place", discovery: "visited" }],
        npcs: [{
          npcId: "npc-ranger", name: "巡林者伊芙", identity: "巡林者", familiarity: "met",
          location: { mapId: "place-creek", name: "銀溪谷", status: "current" },
          knownInformation: [{ infoId: "info-warning", text: "她警告夜間有狼群", confidence: "high" }],
          services: ["道路情報"], questIds: [], memories: [],
        }],
        compendium: [{
          entryId: "entry-wolf", name: "灰脊狼", category: "creature", stage: "rumor", confidence: "low",
          sources: [{ type: "npc", name: "巡林者伊芙", npcId: "npc-ranger", mapId: "place-creek" }],
          knownFacts: ["夜間可能在溪谷活動"], relatedMapIds: ["place-creek"], relatedNpcIds: ["npc-ranger"],
        }],
      },
    );
    expect(traveled.game.revision).toBe(1);
    expect(traveled.changedPaths).toEqual(expect.arrayContaining([
      "player.location", "player.survival.hunger", "player.survival.hydration",
      "player.survival.elapsedGameMinutes", "player.clock.minuteOfDay", "player.time", "map", "npcs", "compendium",
    ]));
    expect(traveled.game.player.location).toMatchObject({ mapId: "place-creek" });
    expect(traveled.game.map).toHaveLength(1);
    expect(traveled.game.npcs).toHaveLength(1);
    expect(traveled.game.compendium).toHaveLength(1);
    expect(traveled.game.history.recent).toHaveLength(1);
  });

  it("records survival events, reports threshold changes, and never kills immediately at zero", async () => {
    await service.createGame("main");
    const event = await service.applySurvivalEvent("main", 0, "lost-for-day", -100, -100, "受困且沒有補給");
    expect(event.survival).toMatchObject({ hunger: 0, hydration: 0 });
    expect(event.stageChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: "hunger", to: "critical" }),
      expect.objectContaining({ metric: "hydration", to: "critical" }),
    ]));
    expect(event.game.player.hp).toBeUndefined();
    expect(event.game.history.recent.at(-1)).toMatchObject({ reason: "受困且沒有補給" });
    const noRepeatedNotice = await service.applySurvivalEvent("main", 1, "still-trapped", -1, -1, "繼續受困");
    expect(noRepeatedNotice.stageChanges).toEqual([]);
  });

  it("settles sleep at the reduced resting rate", async () => {
    await service.createGame("main");
    const slept = await service.advanceTime("main", 0, "sleep-8-hours", 8, "sleep", "temperate", "夜間睡眠");
    expect(slept.survival).toMatchObject({ hunger: 89.6, hydration: 84.4, elapsedGameMinutes: 480 });
  });

  it("reads survival decay rates from the immutable Aelvia world balance", async () => {
    await service.createGame("main");
    const elapsed = await service.advanceTime(
      "main", 0, "balanced-hour", 2, "normal", "temperate", "日常活動兩小時",
    );
    expect(elapsed.game.world.survivalBalance).toEqual({ hungerPerGameHour: 2, hydrationPerGameHour: 3 });
    expect(elapsed.survival).toMatchObject({ hunger: 96, hydration: 94, elapsedGameMinutes: 120 });
  });

  it("migrates an old custom calendar before reset so legacy date caches cannot block progress clearing", async () => {
    const legacy = defaultGameState("legacy-reset");
    legacy.schemaVersion = "0.6.0";
    legacy.version = "6.7.7-mcp.6.0";
    delete (legacy.engine.migrations as JsonObject)[MIGRATION_KEY];
    legacy.world = {
      name: "舊世界",
      calendar: {
        calendarId: "old-calendar",
        eraName: "舊曆",
        hoursPerDay: 10,
        minutesPerHour: 100,
        months: [
          { monthId: "old-first", name: "舊首月", days: 2 },
          { monthId: "old-second", name: "舊次月", days: 3 },
        ],
      },
      survivalBalance: { hungerPerGameHour: 1, hydrationPerGameHour: 1 },
    };
    legacy.player.initialized = true;
    legacy.player.name = "待重設角色";
    legacy.player.clock = { year: 12, monthId: "old-second", day: 2, minuteOfDay: 350 };
    legacy.player.date = "舊曆12年・舊次月2日";
    legacy.player.time = "第 3 時 50 分";
    legacy.engine.autoSave = { status: "saved", revision: 0, savedAt: legacy.updatedAt };
    await store.createGame(legacy);

    const reset = await service.resetPlayer("legacy-reset", 0, "legacy-calendar-reset");
    expect(reset.game.world).toMatchObject({ worldId: "aelvia", name: "艾爾維亞" });
    expect(reset.game.player).toMatchObject({
      initialized: false,
      clock: { year: 742, monthId: "sprout", day: 1, minuteOfDay: 480 },
      date: "群星曆742年・芽月1日",
      time: "上午 08:00",
      season: "春季",
    });
  });

  it("does not advance revision when an already empty player is reset", async () => {
    await service.createGame("main");
    await expect(service.resetPlayer("main", 0, "empty-reset"))
      .rejects.toMatchObject({ code: "NO_STATE_CHANGE", details: { changedPaths: [] } });
    expect((await service.getGame("main")).revision).toBe(0);
  });

  it("serializes concurrent reset retries and clears private-only NPC progress", async () => {
    await service.createGame("main");
    const initialized = await service.applyDiff("main", 0, "reset-race-setup", {
      player: { initialized: true, name: "即將重設" },
    });
    const privateWorld = defaultPrivateWorldState("main", initialized.game.updatedAt);
    privateWorld.npcs["npc-private-only"] = { privateState: { objective: "不得殘留" } };
    await store.putPrivateWorld(privateWorld);

    const results = await Promise.all([
      service.resetPlayer("main", initialized.game.revision, "same-reset-key"),
      service.resetPlayer("main", initialized.game.revision, "same-reset-key"),
    ]);
    expect(results.map((result) => result.idempotentReplay).sort()).toEqual([false, true]);
    expect(results.every((result) => result.game.revision === 2)).toBe(true);
    expect((await service.getPrivateWorldInternal("main")).npcs).toEqual({});
    expect((await service.getGame("main")).world).toMatchObject({ worldId: "aelvia", name: "艾爾維亞" });
  });

  it("clears legacy private-world remnants even when visible progress is already empty", async () => {
    await service.createGame("main");
    const privateWorld = defaultPrivateWorldState("main");
    (privateWorld as unknown as JsonObject).legacyWorldState = { sentinel: "OLD_PRIVATE_WORLD" };
    await store.putPrivateWorld(privateWorld);

    const reset = await service.resetPlayer("main", 0, "private-remnant-reset");
    expect(reset.game.revision).toBe(1);
    expect(reset.changedPaths).toContain("npcs");
    expect(JSON.stringify(await service.getPrivateWorldInternal("main"))).not.toContain("OLD_PRIVATE_WORLD");
    expect((await service.getGame("main")).world).toMatchObject({ worldId: "aelvia", name: "艾爾維亞" });
  });

  it("persists turnId locks and atomically permits exactly one dashboard per turn", async () => {
    await service.createGame("main");
    await expect(service.dashboard("main"))
      .rejects.toMatchObject({ code: "TURN_NOT_PREPARED" });
    await expect(service.dashboard("main", "00000000-0000-4000-8000-000000000000"))
      .rejects.toMatchObject({ code: "TURN_NOT_PREPARED" });

    const unchanged = await service.getGame("main");
    const superseded = await service.prepareTurn("main", "先觀察門口");
    const active = await service.prepareTurn("main", "改為觀察窗外");
    expect(active.turnId).not.toBe(superseded.turnId);
    expect((await service.getGame("main"))).toMatchObject({
      revision: unchanged.revision,
      updatedAt: unchanged.updatedAt,
    });
    await expect(service.dashboard("main", superseded.turnId))
      .rejects.toMatchObject({ code: "TURN_SUPERSEDED" });

    const concurrent = await Promise.allSettled([
      service.dashboard("main"),
      service.dashboard("main", active.turnId),
    ]);
    const fulfilled = concurrent.filter((result) => result.status === "fulfilled");
    const rejected = concurrent.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "DASHBOARD_ALREADY_SHOWN",
    });

    const restartedStore = new FileGameStore(directory);
    await restartedStore.initialize();
    const restarted = new AegisService(restartedStore, {
      maxDiffBytes: 512 * 1024,
      maxStateBytes: 2 * 1024 * 1024,
    });
    await expect(restarted.dashboard("main", active.turnId))
      .rejects.toMatchObject({ code: "DASHBOARD_ALREADY_SHOWN" });

    const sameRevisionTurn = await restarted.prepareTurn("main", "再看一次窗外");
    const sameRevisionDashboard = await restarted.dashboard("main");
    expect(sameRevisionDashboard.game.revision).toBe(unchanged.revision);
    expect(sameRevisionDashboard.turnId).toBe(sameRevisionTurn.turnId);
    expect(sameRevisionDashboard.dashboardKey).toBe(
      `main:${sameRevisionTurn.turnId}:${unchanged.revision}`,
    );
    await expect(restarted.dashboard("main", sameRevisionTurn.turnId))
      .rejects.toMatchObject({ code: "DASHBOARD_ALREADY_SHOWN" });
    await restartedStore.close();
  });
});
