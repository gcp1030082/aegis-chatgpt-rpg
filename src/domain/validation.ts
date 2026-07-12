import { AegisError } from "./errors.js";
import type { GameState, JsonObject, JsonValue } from "./types.js";
import { isItemCategory } from "./inventory.js";

const GAME_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function assertGameId(gameId: string): void {
  if (!GAME_ID_PATTERN.test(gameId)) {
    throw new AegisError(
      "INVALID_GAME_ID",
      "game_id 必須是 1–64 字元的小寫英數、連字號或底線，且以英數開頭。",
    );
  }
}

export function assertSafeJson(value: unknown, label: string, maxBytes: number): asserts value is JsonValue {
  walkJson(value, label, 0);
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > maxBytes) {
    throw new AegisError("PAYLOAD_TOO_LARGE", `${label} 超過大小限制。`, {
      bytes,
      maxBytes,
    });
  }
}

function walkJson(value: unknown, path: string, depth: number): void {
  if (depth > 64) {
    throw new AegisError("INVALID_STATE", `${path} 巢狀層級過深。`);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new AegisError("INVALID_STATE", `${path} 包含非有限數字。`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkJson(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!value || typeof value !== "object") {
    throw new AegisError("INVALID_STATE", `${path} 不是合法 JSON 值。`);
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new AegisError("INVALID_STATE", `${path} 含有禁止欄位 ${key}。`);
    }
    walkJson(child, `${path}.${key}`, depth + 1);
  }
}

export function validateGameState(state: GameState, maxBytes: number): void {
  assertGameId(state.gameId);
  assertSafeJson(state as unknown, "game state", maxBytes);

  if (!Number.isInteger(state.revision) || state.revision < 0) {
    throw new AegisError("INVALID_STATE", "revision 必須是非負整數。");
  }
  for (const [key, value] of [["world", state.world], ["player", state.player], ["history", state.history], ["engine", state.engine]] as const) {
    if (!isObject(value)) throw new AegisError("INVALID_STATE", `${key} 必須是物件。`);
  }
  for (const key of ["inventory", "npcs", "compendium", "map", "quests"] as const) {
    if (!Array.isArray(state[key])) {
      throw new AegisError("INVALID_STATE", `${key} 必須是陣列。`);
    }
  }
  for (const key of ["recent", "major", "summary"] as const) {
    if (!Array.isArray(state.history[key])) {
      throw new AegisError("INVALID_STATE", `history.${key} 必須是陣列。`);
    }
  }

  state.inventory.forEach((item, index) => {
    if (!isObject(item)) throw new AegisError("INVALID_STATE", `inventory[${index}] 必須是物件。`);
    if (!isItemCategory(item.category)) {
      throw new AegisError("INVALID_STATE", `inventory[${index}].category 不是有效的主要分類。`);
    }
    for (const key of ["quantity", "qty"] as const) {
      const quantity = item[key];
      if (typeof quantity === "number" && (!Number.isFinite(quantity) || quantity < 0)) {
        throw new AegisError("INVALID_STATE", `inventory[${index}].${key} 不得小於 0。`);
      }
    }
    if (
      typeof item.quantity === "number" &&
      typeof item.qty === "number" &&
      item.quantity !== item.qty
    ) {
      throw new AegisError("INVALID_STATE", `inventory[${index}] 的 quantity 與 qty 不可互相矛盾。`);
    }
  });

  if (!Array.isArray(state.player.skills)) {
    throw new AegisError("INVALID_STATE", "player.skills 必須是陣列。");
  }
  if (!isObject(state.player.equipment)) {
    throw new AegisError("INVALID_STATE", "player.equipment 必須是物件。");
  }
  if (!isObject(state.player.attributes)) {
    throw new AegisError("INVALID_STATE", "player.attributes 必須是物件。");
  }
  const survival = state.player.survival;
  if (!isObject(survival)) throw new AegisError("INVALID_STATE", "player.survival 必須是物件。");
  for (const key of ["hunger", "hydration"] as const) {
    const value = survival[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
      throw new AegisError("INVALID_STATE", `player.survival.${key} 必須是 0～100 的有限數字。`);
    }
  }
  const elapsed = survival.elapsedGameMinutes;
  if (typeof elapsed !== "number" || !Number.isInteger(elapsed) || elapsed < 0) {
    throw new AegisError("INVALID_STATE", "player.survival.elapsedGameMinutes 必須是非負整數。");
  }
  if (!Array.isArray(survival.modifiers)) {
    throw new AegisError("INVALID_STATE", "player.survival.modifiers 必須是陣列。");
  }
  survival.modifiers.forEach((raw, index) => {
    if (!isObject(raw)) {
      throw new AegisError("INVALID_STATE", `player.survival.modifiers[${index}] 必須是物件。`);
    }
    for (const key of ["hungerRateMultiplier", "hydrationRateMultiplier"] as const) {
      const value = raw[key];
      if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 5)) {
        throw new AegisError("INVALID_STATE", `player.survival.modifiers[${index}].${key} 必須是 0～5 的有限數字。`);
      }
    }
  });

  for (const [index, item] of state.inventory.entries()) {
    for (const key of ["hungerRestore", "hydrationRestore"] as const) {
      const value = item[key];
      if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
        throw new AegisError("INVALID_STATE", `inventory[${index}].${key} 必須是非負有限數字。`);
      }
    }
    for (const key of ["usesRemaining", "maxUses"] as const) {
      const value = item[key];
      if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 0)) {
        throw new AegisError("INVALID_STATE", `inventory[${index}].${key} 必須是非負整數。`);
      }
    }
    if (
      typeof item.usesRemaining === "number" &&
      typeof item.maxUses === "number" &&
      item.usesRemaining > item.maxUses
    ) {
      throw new AegisError("INVALID_STATE", `inventory[${index}] 的剩餘容量不得超過最大容量。`);
    }
  }

  const money = state.player.money;
  if (typeof money === "number" && !Number.isFinite(money)) {
    throw new AegisError("INVALID_STATE", "player.money 必須是有限數字。");
  }
  const tick = state.player.tick;
  if (typeof tick === "number" && (!Number.isInteger(tick) || tick < 0)) {
    throw new AegisError("INVALID_STATE", "player.tick 必須是非負整數。");
  }

  const equipment = state.player.equipment;
  if (isObject(equipment)) {
    for (const [slot, raw] of Object.entries(equipment)) {
      if (!isObject(raw)) continue;
      const durability = raw.durability;
      const maxDurability = raw.maxDurability;
      if (
        typeof durability === "number" &&
        typeof maxDurability === "number" &&
        (durability < 0 || durability > maxDurability)
      ) {
        throw new AegisError("INVALID_STATE", `player.equipment.${slot} 耐久度超出範圍。`);
      }
    }
  }
}

export function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
