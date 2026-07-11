import { AegisError } from "./errors.js";
import type { GameState, JsonObject, JsonValue } from "./types.js";

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
    const qty = item.qty;
    if (typeof qty === "number" && (!Number.isFinite(qty) || qty < 0)) {
      throw new AegisError("INVALID_STATE", `inventory[${index}].qty 不得小於 0。`);
    }
  });

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
