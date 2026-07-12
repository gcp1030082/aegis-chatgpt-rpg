import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AegisService } from "../src/service.js";
import { FileGameStore } from "../src/storage/file-store.js";

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

  it("creates, commits, retries idempotently, saves, and restores", async () => {
    await service.createGame("main", "測試世界");
    const first = await service.applyDiff(
      "main",
      0,
      "turn-1",
      { player: { name: "洛恩", money: 10 }, history: ["醒來。"] },
      "角色甦醒",
    );
    expect(first.game.revision).toBe(1);

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

  it("atomically resets player-owned data while preserving world and saves", async () => {
    await service.createGame("main", "測試世界");
    const skills = Array.from({ length: 6 }, (_, index) => ({ id: `skill-${index}`, name: `舊技能${index}` }));
    const inventory = Array.from({ length: 6 }, (_, index) => ({
      id: `item-${index}`, name: `舊物品${index}`, quantity: 1, category: "misc",
    }));
    const equipment = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [
      `slot-${index}`, { id: `equip-${index}`, name: `舊裝備${index}` },
    ]));
    const populated = await service.applyDiff("main", 0, "populate-reset-fixture", {
      world: { name: "保留世界", rules: ["世界規則"] },
      player: {
        initialized: true,
        name: "舊角色洛恩",
        race: "人類",
        background: "舊角色背景",
        level: 9,
        hp: 88,
        mp: 30,
        sp: 50,
        date: "舊日期",
        time: "舊時間",
        season: "春",
        weather: "晴",
        location: { region: "舊地區", location: "舊城鎮" },
        attributes: { strength: 8 },
        skills,
        equipment,
      },
      inventory,
      quests: [{ id: "quest-1", name: "舊任務一" }, { id: "quest-2", name: "舊任務二" }],
      history: { recent: ["近期一", "近期二", "近期三"], major: ["重大一"], summary: ["舊摘要"] },
      npcs: [{ id: "npc-1", name: "世界居民", relationship: "摯友", affinity: 99 }],
      map: [{ id: "map-1", name: "世界地圖", visited: true, progress: 80 }],
      compendium: [{ id: "book-1", name: "世界圖鑑", unlocked: true, playerNotes: "舊角色筆記" }],
    });
    expect(populated.game.revision).toBe(1);
    await service.createSave("main", "重設前快照", "save-before-reset");

    const reset = await service.resetPlayer("main", 1, "reset-player-1");
    expect(reset.game.revision).toBe(2);
    expect(reset.game.player).toMatchObject({
      initialized: false,
      tick: 0,
      money: 0,
      skills: [],
      equipment: {},
      attributes: {},
      survival: { hunger: 100, hydration: 100 },
    });
    expect(reset.game.inventory).toEqual([]);
    expect(reset.game.quests).toEqual([]);
    expect(reset.game.history).toEqual({ recent: [], major: [], summary: [] });
    expect(reset.game.world).toMatchObject({ name: "保留世界", rules: ["世界規則"] });
    expect(reset.game.npcs[0]).toEqual({ id: "npc-1", name: "世界居民" });
    expect(reset.game.map[0]).toEqual({ id: "map-1", name: "世界地圖" });
    expect(reset.game.compendium[0]).toEqual({ id: "book-1", name: "世界圖鑑" });
    expect(JSON.stringify(reset.game)).not.toContain("舊角色洛恩");
    expect(JSON.stringify(reset.game)).not.toContain("舊技能");
    expect(JSON.stringify(reset.game)).not.toContain("舊任務");
    expect(JSON.stringify(reset.game)).not.toContain("舊摘要");
    expect(await service.listSaves("main")).toHaveLength(1);

    const replay = await service.resetPlayer("main", 1, "reset-player-1");
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.game.revision).toBe(2);
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

  it("does not advance revision when an already empty player is reset", async () => {
    await service.createGame("main");
    await expect(service.resetPlayer("main", 0, "empty-reset"))
      .rejects.toMatchObject({ code: "NO_STATE_CHANGE", details: { changedPaths: [] } });
    expect((await service.getGame("main")).revision).toBe(0);
  });
});
