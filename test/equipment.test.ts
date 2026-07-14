import { describe, expect, it } from "vitest";
import { defaultGameState, migrateGameState, MIGRATION_KEY } from "../src/domain/default-state.js";
import type { JsonObject } from "../src/domain/types.js";
import { validateGameState } from "../src/domain/validation.js";

describe("equipment state migration", () => {
  it("removes legacy equipped duplicates from inventory and preserves one authoritative instance", () => {
    const legacy = defaultGameState("main");
    markLegacy(legacy);
    legacy.player.equipment = {
      mainHand: { id: "staff", name: "銅芯修補杖", category: "equipment", attack: 3 },
    };
    legacy.inventory = [
      { id: "staff", name: "銅芯修補杖", category: "equipment", quantity: 1, equipped: true },
      { id: "bread", name: "乾麵包", category: "consumable", quantity: 2 },
    ];

    const migrated = migrateGameState(legacy);
    validateGameState(migrated, 2 * 1024 * 1024);

    expect(migrated.inventory.map((item) => item.name)).toEqual(["乾麵包"]);
    const equipment = migrated.player.equipment as JsonObject;
    const registry = migrated.player.equippedItems as JsonObject;
    const ref = equipment.mainHand;
    expect(typeof ref).toBe("string");
    expect(registry[String(ref)]).toMatchObject({
      id: "staff",
      name: "銅芯修補杖",
      category: "equipment",
      location: "equipped",
      equippedSlot: "mainHand",
    });
  });

  it("splits a legacy equipment stack into distinct physical instances", () => {
    const legacy = defaultGameState("main");
    markLegacy(legacy);
    legacy.inventory = [{ id: "ring", name: "銅戒", category: "equipment", quantity: 2 }];

    const migrated = migrateGameState(legacy);
    expect(migrated.inventory).toHaveLength(2);
    expect(new Set(migrated.inventory.map((item) => item.instanceId)).size).toBe(2);
    expect(migrated.inventory.every((item) => item.quantity === 1 && item.location === "inventory")).toBe(true);
  });
});

function markLegacy(state: ReturnType<typeof defaultGameState>): void {
  state.schemaVersion = "6.7.7-mcp.5.2";
  state.version = "6.7.7-mcp.5.2";
  delete (state.engine.migrations as Record<string, unknown>)[MIGRATION_KEY];
}
