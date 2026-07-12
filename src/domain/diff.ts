import { cloneState } from "./default-state.js";
import { AegisError } from "./errors.js";
import type { ApplyDiffResult, GameState, JsonObject, JsonValue } from "./types.js";
import { assertSafeJson, isObject, validateGameState } from "./validation.js";

const ALLOWED_TOP_LEVEL = new Set([
  "world",
  "player",
  "inventory",
  "npcs",
  "compendium",
  "map",
  "quests",
  "history",
]);

interface ApplyDiffOptions {
  maxDiffBytes: number;
  maxStateBytes: number;
  idempotencyKey: string;
  turnSummary?: string | undefined;
}

export function applyStateDiff(
  current: GameState,
  rawDiff: unknown,
  options: ApplyDiffOptions,
): ApplyDiffResult {
  assertSafeJson(rawDiff, "state diff", options.maxDiffBytes);
  if (!isObject(rawDiff)) {
    throw new AegisError("INVALID_DIFF", "State Diff 必須是 JSON 物件。");
  }

  const unknownKeys = Object.keys(rawDiff).filter((key) => !ALLOWED_TOP_LEVEL.has(key));
  if (unknownKeys.length > 0) {
    throw new AegisError("INVALID_DIFF", `State Diff 含有不允許的頂層欄位：${unknownKeys.join(", ")}`);
  }

  const next = cloneState(current);
  const changedPaths = new Set<string>();

  if (rawDiff.world !== undefined) {
    if (!isObject(rawDiff.world)) throw invalidSection("world", "物件");
    mergeObject(next.world, rawDiff.world, "world", changedPaths);
  }
  if (rawDiff.player !== undefined) {
    if (!isObject(rawDiff.player)) throw invalidSection("player", "物件");
    applyPlayerPatch(next, rawDiff.player, changedPaths);
  }
  if (rawDiff.inventory !== undefined) {
    next.inventory = applyInventoryPatch(next.inventory, rawDiff.inventory, changedPaths);
  }

  for (const key of ["npcs", "compendium", "map", "quests"] as const) {
    if (rawDiff[key] !== undefined) {
      next[key] = applyCollectionPatch(next[key], rawDiff[key], key, changedPaths);
    }
  }

  if (rawDiff.history !== undefined) {
    applyHistoryPatch(next, rawDiff.history, changedPaths);
  }

  next.revision = current.revision + 1;
  next.updatedAt = new Date().toISOString();
  appendTransaction(next, options.idempotencyKey, options.turnSummary, [...changedPaths]);
  trimHistory(next);
  validateGameState(next, options.maxStateBytes);

  return { game: next, changedPaths: [...changedPaths].sort() };
}

function applyPlayerPatch(state: GameState, patch: JsonObject, changed: Set<string>): void {
  const rest = cloneState(patch);
  if (Array.isArray(rest.skills)) {
    const currentSkills = Array.isArray(state.player.skills) ? state.player.skills : [];
    state.player.skills = upsertObjects(currentSkills, rest.skills, "player.skills", changed);
    delete rest.skills;
  }
  if (isObject(rest.equipment)) {
    const currentEquipment = isObject(state.player.equipment) ? state.player.equipment : {};
    mergeObject(currentEquipment, rest.equipment, "player.equipment", changed);
    state.player.equipment = currentEquipment;
    delete rest.equipment;
  }
  mergeObject(state.player, rest, "player", changed);
}

function applyInventoryPatch(
  current: JsonObject[],
  patch: JsonValue,
  changed: Set<string>,
): JsonObject[] {
  if (Array.isArray(patch)) {
    changed.add("inventory");
    return normalizeInventory(objectsOnly(patch, "inventory"), "inventory");
  }
  if (!isObject(patch)) throw invalidSection("inventory", "陣列或物件");

  let result = cloneState(current);
  if (patch.replace !== undefined) {
    if (!Array.isArray(patch.replace)) throw invalidSection("inventory.replace", "陣列");
    result = normalizeInventory(objectsOnly(patch.replace, "inventory.replace"), "inventory.replace");
    changed.add("inventory");
  }
  if (patch.upsert !== undefined) {
    if (!Array.isArray(patch.upsert)) throw invalidSection("inventory.upsert", "陣列");
    result = upsertObjects(result, patch.upsert, "inventory", changed);
  }
  if (patch.add !== undefined) {
    if (!Array.isArray(patch.add)) throw invalidSection("inventory.add", "陣列");
    for (const raw of patch.add) {
      if (!isObject(raw)) throw invalidSection("inventory.add[]", "物件");
      const item = cloneState(raw);
      const quantity = inventoryQuantity(item, 1, "inventory.add[].quantity");
      const index = findEntityIndex(result, item);
      if (index >= 0) {
        const existing = result[index];
        if (!existing) continue;
        existing.quantity = inventoryQuantity(existing, 1, `inventory[${index}].quantity`) + quantity;
        delete existing.qty;
        mergeObject(existing, withoutQuantity(item), `inventory[${index}]`, changed);
      } else {
        item.quantity = quantity;
        delete item.qty;
        result.push(item);
      }
      changed.add("inventory");
    }
  }
  if (patch.remove !== undefined) {
    if (!Array.isArray(patch.remove)) throw invalidSection("inventory.remove", "陣列");
    for (const raw of patch.remove) {
      if (!isObject(raw)) throw invalidSection("inventory.remove[]", "物件");
      const index = findEntityIndex(result, raw);
      if (index < 0) continue;
      const existing = result[index];
      if (!existing) continue;
      if (!hasInventoryQuantity(raw)) {
        result.splice(index, 1);
      } else {
        const remaining =
          inventoryQuantity(existing, 1, `inventory[${index}].quantity`) -
          inventoryQuantity(raw, 0, "inventory.remove[].quantity");
        if (remaining < 0) {
          throw new AegisError("INVALID_DIFF", `移除的 ${String(raw.name ?? "物品")} 數量超過持有量。`);
        }
        if (remaining === 0) result.splice(index, 1);
        else {
          existing.quantity = remaining;
          delete existing.qty;
        }
      }
      changed.add("inventory");
    }
  }
  return normalizeInventory(result, "inventory").filter((item) => item.quantity !== 0);
}

function applyCollectionPatch(
  current: JsonObject[],
  patch: JsonValue,
  path: string,
  changed: Set<string>,
): JsonObject[] {
  if (Array.isArray(patch)) return upsertObjects(current, patch, path, changed);
  if (!isObject(patch)) throw invalidSection(path, "陣列或物件");
  let result = cloneState(current);
  if (patch.replace !== undefined) {
    if (!Array.isArray(patch.replace)) throw invalidSection(`${path}.replace`, "陣列");
    result = objectsOnly(patch.replace, `${path}.replace`);
    changed.add(path);
  }
  if (patch.upsert !== undefined) {
    if (!Array.isArray(patch.upsert)) throw invalidSection(`${path}.upsert`, "陣列");
    result = upsertObjects(result, patch.upsert, path, changed);
  }
  if (patch.remove !== undefined) {
    if (!Array.isArray(patch.remove)) throw invalidSection(`${path}.remove`, "陣列");
    const removeKeys = new Set(patch.remove.map(entityKey).filter(Boolean));
    const before = result.length;
    result = result.filter((item) => !removeKeys.has(entityKey(item)));
    if (before !== result.length) changed.add(path);
  }
  return result;
}

function applyHistoryPatch(state: GameState, patch: JsonValue, changed: Set<string>): void {
  if (Array.isArray(patch)) {
    state.history.recent.push(...cloneState(patch));
    if (patch.length) changed.add("history.recent");
    return;
  }
  if (!isObject(patch)) throw invalidSection("history", "陣列或物件");
  for (const key of ["recent", "major", "summary"] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (!Array.isArray(value)) throw invalidSection(`history.${key}`, "陣列");
    state.history[key].push(...cloneState(value));
    if (value.length) changed.add(`history.${key}`);
  }
  if (Array.isArray(patch.append)) {
    state.history.recent.push(...cloneState(patch.append));
    if (patch.append.length) changed.add("history.recent");
  }
}

function upsertObjects(
  current: JsonValue[],
  incoming: JsonValue[],
  path: string,
  changed: Set<string>,
): JsonObject[] {
  const result = objectsOnly(current, path);
  for (const raw of incoming) {
    if (!isObject(raw)) throw invalidSection(`${path}[]`, "物件");
    const item = cloneState(raw);
    const index = findEntityIndex(result, item);
    if (index >= 0) {
      const existing = result[index];
      if (existing) mergeObject(existing, item, `${path}[${index}]`, changed);
    } else {
      result.push(item);
    }
    changed.add(path);
  }
  return result;
}

function findEntityIndex(items: JsonObject[], candidate: JsonObject): number {
  const key = entityKey(candidate);
  return key ? items.findIndex((item) => entityKey(item) === key) : -1;
}

function entityKey(value: JsonValue): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (!isObject(value)) return "";
  if (value.id !== undefined && value.id !== "") return `id:${String(value.id)}`;
  if (value.name !== undefined && value.name !== "") {
    const quality = value.quality === undefined ? "" : `:${String(value.quality)}`;
    return `name:${String(value.name)}${quality}`;
  }
  if (value.slot !== undefined && value.slot !== "") return `slot:${String(value.slot)}`;
  return "";
}

function mergeObject(target: JsonObject, patch: JsonObject, path: string, changed: Set<string>): void {
  for (const [key, value] of Object.entries(patch)) {
    const childPath = `${path}.${key}`;
    const existing = target[key];
    if (isObject(existing) && isObject(value)) {
      mergeObject(existing, value, childPath, changed);
    } else if (JSON.stringify(existing) !== JSON.stringify(value)) {
      target[key] = cloneState(value);
      changed.add(childPath);
    }
  }
}

function appendTransaction(
  state: GameState,
  idempotencyKey: string,
  summary: string | undefined,
  changedPaths: string[],
): void {
  const keys = Array.isArray(state.engine.idempotencyKeys) ? state.engine.idempotencyKeys : [];
  keys.push(idempotencyKey);
  state.engine.idempotencyKeys = keys.slice(-100);

  const log = Array.isArray(state.engine.transactionLog) ? state.engine.transactionLog : [];
  log.push({
    idempotencyKey,
    revision: state.revision,
    time: state.updatedAt,
    summary: summary ?? "",
    changedPaths,
  });
  state.engine.transactionLog = log.slice(-100);
}

function trimHistory(state: GameState): void {
  const rawLimit = state.engine.historyLimit;
  const limit = typeof rawLimit === "number" && Number.isInteger(rawLimit) ? Math.max(20, Math.min(500, rawLimit)) : 100;
  state.history.recent = state.history.recent.slice(-limit);
  state.history.major = state.history.major.slice(-limit);
  state.history.summary = state.history.summary.slice(-Math.min(limit, 50));
}

function objectsOnly(values: JsonValue[], path: string): JsonObject[] {
  return values.map((value, index) => {
    if (!isObject(value)) throw invalidSection(`${path}[${index}]`, "物件");
    return cloneState(value);
  });
}

function numericQty(value: JsonValue | undefined, fallback: number, path: string): number {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new AegisError("INVALID_DIFF", `${path} 必須是非負數。`);
  }
  return number;
}

function hasInventoryQuantity(item: JsonObject): boolean {
  return quantityProvided(item.quantity) || quantityProvided(item.qty);
}

function inventoryQuantity(item: JsonObject, fallback: number, path: string): number {
  const longValue = item.quantity;
  const shortValue = item.qty;
  if (quantityProvided(longValue) && quantityProvided(shortValue)) {
    const longQuantity = numericQty(longValue, fallback, path);
    const shortQuantity = numericQty(shortValue, fallback, path.replace("quantity", "qty"));
    if (longQuantity !== shortQuantity) {
      throw new AegisError("INVALID_DIFF", `${path} 與 qty 不可互相矛盾。`);
    }
    return longQuantity;
  }
  return numericQty(quantityProvided(longValue) ? longValue : shortValue, fallback, path);
}

function quantityProvided(value: JsonValue | undefined): boolean {
  return value !== undefined && value !== null && value !== "";
}

function normalizeInventory(items: JsonObject[], path: string): JsonObject[] {
  return items.map((raw, index) => {
    const item = cloneState(raw);
    item.quantity = inventoryQuantity(item, 1, `${path}[${index}].quantity`);
    delete item.qty;
    return item;
  });
}

function withoutQuantity(object: JsonObject): JsonObject {
  const result = cloneState(object);
  delete result.quantity;
  delete result.qty;
  return result;
}

function invalidSection(path: string, expected: string): AegisError {
  return new AegisError("INVALID_DIFF", `${path} 必須是${expected}。`);
}
