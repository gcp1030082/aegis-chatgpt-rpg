import { describe, expect, it } from "vitest";
import { defaultGameState } from "../src/domain/default-state.js";
import { applyStateDiff } from "../src/domain/diff.js";

const options = {
  maxDiffBytes: 512 * 1024,
  maxStateBytes: 2 * 1024 * 1024,
  idempotencyKey: "turn-1",
  turnSummary: "角色建立",
};

describe("applyStateDiff", () => {
  it("merges character creation data and inventory atomically", () => {
    const state = defaultGameState("main");
    const result = applyStateDiff(
      state,
      {
        world: { name: "阿斯特", currency: "銀幣" },
        player: {
          name: "洛恩",
          initialized: true,
          attributes: { strength: 8 },
          skills: [{
            id: "basic-sword", name: "基礎劍術", level: 1, category: "combat",
            description: "基礎持劍技巧。", effects: [{ type: "unlock_action", action: "basic_sword_attack", label: "解鎖基礎持劍攻擊" }],
            acquisition: { type: "initial_skill", sourceName: "角色創建" },
          }],
        },
        inventory: {
          add: [{
            id: "ration", name: "乾糧", quantity: 2, category: "食物", description: "便於攜帶的乾糧。",
            effects: [{ type: "restore_hunger", value: 30 }], source: "旅行包",
          }],
        },
        history: ["角色建立完成。"],
      },
      options,
    );

    expect(result.game.revision).toBe(1);
    expect(result.game.world.name).toBe("阿斯特");
    expect(result.game.player.name).toBe("洛恩");
    expect(result.game.inventory).toEqual([
      expect.objectContaining({
        id: "ration", name: "乾糧", quantity: 2, category: "consumable", location: "inventory",
        instanceId: expect.stringMatching(/^item-/), effects: [{ type: "restore_hunger", value: 30 }],
        acquisition: { type: "initial_item", sourceName: "角色創建", obtainedAtTick: 0 },
      }),
    ]);
    expect(result.game.player.skills).toEqual([
      expect.objectContaining({ id: "basic-sword", name: "基礎劍術", category: "combat", categoryLabel: "戰鬥" }),
    ]);
    expect(result.game.player.equipment).toEqual({});
    expect(result.game.history.recent).toEqual(["角色建立完成。"]) ;
    expect(result.changedPaths).toContain("inventory");
  });

  it("rejects removing more inventory than the player owns", () => {
    const state = defaultGameState("main");
    state.inventory = [{ name: "藥草", quantity: 1 }];
    expect(() =>
      applyStateDiff(state, { inventory: { remove: [{ name: "藥草", quantity: 2 }] } }, options),
    ).toThrow(/超過持有量/);
  });

  it("accepts legacy qty while storing one canonical quantity field", () => {
    const state = defaultGameState("main");
    state.inventory = [{ name: "水袋", qty: 1 }];
    const result = applyStateDiff(
      state,
      { inventory: { add: [{ name: "水袋", quantity: 2, description: "裝水用。" }] } },
      options,
    );

    expect(result.game.inventory).toEqual([
      expect.objectContaining({
        name: "水袋", quantity: 3, description: "裝水用。", category: "misc",
        instanceId: expect.stringMatching(/^item-/), location: "inventory",
      }),
    ]);
  });

  it("treats direct arrays as complete replacements, including empty arrays", () => {
    const state = defaultGameState("main");
    state.player.skills = [{ id: "skill-1", name: "舊技能" }];
    state.inventory = [{ id: "item-1", name: "舊物品", quantity: 1, category: "misc" }];
    state.quests = [{ id: "quest-1", name: "舊任務" }];
    state.history = { recent: ["近期"], major: ["重大"], summary: ["摘要"] };

    const result = applyStateDiff(
      state,
      {
        player: { skills: [] },
        inventory: [],
        quests: [],
        history: { recent: [], major: [], summary: [] },
      },
      options,
    );

    expect(result.game.player.skills).toEqual([]);
    expect(result.game.inventory).toEqual([]);
    expect(result.game.quests).toEqual([]);
    expect(result.game.history).toEqual({ recent: [], major: [], summary: [] });
    expect(result.changedPaths).toEqual([
      "history.major", "history.recent", "history.summary", "inventory", "player.skills", "quests",
    ]);
  });

  it("rejects invalid fixed array types and no-op diffs", () => {
    const state = defaultGameState("main");
    expect(() => applyStateDiff(state, { player: { skills: { remove: ["舊技能"] } } }, options))
      .toThrow(/player\.skills 必須是陣列/);
    expect(() => applyStateDiff(state, { quests: [], inventory: [] }, options))
      .toThrowError(expect.objectContaining({ code: "NO_STATE_CHANGE" }));
  });

  it("rejects protected and unknown top-level fields", () => {
    const state = defaultGameState("main");
    expect(() => applyStateDiff(state, { revision: 99 }, options)).toThrow(/不允許/);
    const dangerous = JSON.parse('{"player":{"__proto__":{"admin":true}}}');
    expect(() => applyStateDiff(state, dangerous, options)).toThrow(/禁止欄位/);
  });

  it("rejects direct equipment mutation and unique skills without authority", () => {
    const state = defaultGameState("main");
    expect(() => applyStateDiff(state, { player: { equipment: { mainHand: "item-1" } } }, options))
      .toThrow(/只能透過 aegis_equip_item/);
    expect(() => applyStateDiff(state, {
      player: { skills: [{ id: "echo", name: "灰燼回響", category: "unique" }] },
    }, options)).toThrow(/uniqueScope 與 uniqueHolderId/);
  });

  it("records initial acquisition automatically and rejects unexplained later gains", () => {
    const state = defaultGameState("main");
    const initialized = applyStateDiff(state, {
      player: {
        initialized: true,
        skills: [{ id: "forage", name: "野外採集", category: "survival" }],
      },
      inventory: [{ id: "ration", name: "旅行乾糧", category: "consumable", quantity: 1 }],
    }, options);
    expect(initialized.game.inventory[0]?.acquisition).toEqual({
      type: "initial_item", sourceName: "角色創建", obtainedAtTick: 0,
    });
    expect((initialized.game.player.skills as Array<Record<string, unknown>>)[0]?.acquisition)
      .toEqual({ type: "initial_skill", sourceName: "角色創建" });

    expect(() => applyStateDiff(defaultGameState("main"), {
      inventory: [{ id: "coin", name: "不明硬幣", category: "misc", quantity: 1 }],
    }, options)).toThrow(/必須記錄 acquisition 取得來源/);
  });

  it("stores one dynamic skill category, secondary tags, structured effects, and authoritative uniqueness", () => {
    const state = defaultGameState("main");
    const result = applyStateDiff(state, {
      player: {
        initialized: true,
        skills: [
          {
            id: "alchemy", name: "邊境煉金", category: "alchemy", categoryLabel: "煉金術",
            tags: ["knowledge"], description: "使用邊境素材調製藥劑。",
            effects: [{ type: "unlock_action", action: "brew_border_tonic", label: "解鎖邊境藥劑調製" }],
          },
          {
            id: "world-echo", name: "世界回聲", category: "unique", uniqueScope: "world",
            uniqueHolderId: "player-main", effects: [{ type: "unlock_action", action: "hear_world_echo", label: "解鎖聆聽世界回聲" }],
          },
        ],
      },
    }, options);
    expect(result.game.player.skills).toEqual([
      expect.objectContaining({ category: "alchemy", categoryLabel: "煉金術", tags: ["knowledge"] }),
      expect.objectContaining({ category: "unique", categoryLabel: "唯一", uniqueHolderId: "player-main" }),
    ]);
  });

  it("stores exactly one canonical primary category per inventory item", () => {
    const state = defaultGameState("main");
    const result = applyStateDiff(state, {
      inventory: [
        { id: "food", name: "麵包", category: "食物", acquisition: { type: "loot", sourceName: "補給箱" } },
        { id: "sword", name: "劍", category: "裝備", acquisition: { type: "loot", sourceName: "補給箱" } },
        { id: "ore", name: "礦石", category: "素材", acquisition: { type: "gathering", sourceName: "礦區" } },
        { id: "key", name: "古鑰匙", category: "任務道具", acquisition: { type: "quest_reward", sourceName: "守門人" } },
      ],
    }, options);
    expect(result.game.inventory.map((item) => item.category)).toEqual([
      "consumable", "equipment", "misc", "special",
    ]);
    expect(() => applyStateDiff(state, {
      inventory: [{ id: "bad", name: "不明物", category: "多重分類", acquisition: { type: "loot" } }],
    }, options)).toThrow(/category 必須是/);
  });
});
