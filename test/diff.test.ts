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
          skills: [{ id: "basic-sword", name: "基礎劍術", level: 1, description: "基礎持劍技巧。", source: "村莊教官" }],
          equipment: {
            mainHand: { id: "old-sword", name: "舊鐵劍", attack: 3, source: "村莊教官" },
          },
        },
        inventory: {
          add: [{ id: "ration", name: "乾糧", quantity: 2, category: "食物", effect: "充飢", source: "旅行包" }],
        },
        history: ["角色建立完成。"],
      },
      options,
    );

    expect(result.game.revision).toBe(1);
    expect(result.game.world.name).toBe("阿斯特");
    expect(result.game.player.name).toBe("洛恩");
    expect(result.game.inventory).toEqual([
      { id: "ration", name: "乾糧", quantity: 2, category: "食物", effect: "充飢", source: "旅行包" },
    ]);
    expect(result.game.player.skills).toEqual([
      { id: "basic-sword", name: "基礎劍術", level: 1, description: "基礎持劍技巧。", source: "村莊教官" },
    ]);
    expect(result.game.player.equipment).toMatchObject({ mainHand: { name: "舊鐵劍", attack: 3 } });
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

    expect(result.game.inventory).toEqual([{ name: "水袋", quantity: 3, description: "裝水用。" }]);
  });

  it("rejects protected and unknown top-level fields", () => {
    const state = defaultGameState("main");
    expect(() => applyStateDiff(state, { revision: 99 }, options)).toThrow(/不允許/);
    const dangerous = JSON.parse('{"player":{"__proto__":{"admin":true}}}');
    expect(() => applyStateDiff(state, dangerous, options)).toThrow(/禁止欄位/);
  });
});
