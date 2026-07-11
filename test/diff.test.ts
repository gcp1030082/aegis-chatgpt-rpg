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
          skills: [{ name: "基礎劍術", level: 1 }],
        },
        inventory: { add: [{ name: "乾糧", qty: 2 }] },
        history: ["角色建立完成。"],
      },
      options,
    );

    expect(result.game.revision).toBe(1);
    expect(result.game.world.name).toBe("阿斯特");
    expect(result.game.player.name).toBe("洛恩");
    expect(result.game.inventory).toEqual([{ name: "乾糧", qty: 2 }]);
    expect(result.game.history.recent).toEqual(["角色建立完成。"]) ;
    expect(result.changedPaths).toContain("inventory");
  });

  it("rejects removing more inventory than the player owns", () => {
    const state = defaultGameState("main");
    state.inventory = [{ name: "藥草", qty: 1 }];
    expect(() =>
      applyStateDiff(state, { inventory: { remove: [{ name: "藥草", qty: 2 }] } }, options),
    ).toThrow(/超過持有量/);
  });

  it("rejects protected and unknown top-level fields", () => {
    const state = defaultGameState("main");
    expect(() => applyStateDiff(state, { revision: 99 }, options)).toThrow(/不允許/);
    const dangerous = JSON.parse('{"player":{"__proto__":{"admin":true}}}');
    expect(() => applyStateDiff(state, dangerous, options)).toThrow(/禁止欄位/);
  });
});
