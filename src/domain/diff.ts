import { cloneState } from "./default-state.js";
import { AegisError } from "./errors.js";
import { categorizeItem, normalizeInventoryRecords } from "./inventory.js";
import type { ApplyDiffResult, GameState, JsonObject, JsonValue } from "./types.js";
import { assertSafeJson, isObject, validateGameState } from "./validation.js";
import { recordAutomaticSave } from "./commit.js";
import { normalizeSkills } from "./skills.js";
import { normalizeKnowledgeState } from "./knowledge.js";

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
  const initializingPlayer = current.player.initialized !== true &&
    isObject(rawDiff.player) && rawDiff.player.initialized === true;

  if (rawDiff.world !== undefined) {
    if (!isObject(rawDiff.world)) throw invalidSection("world", "物件");
    mergeObject(next.world, rawDiff.world, "world", changedPaths);
  }
  if (rawDiff.player !== undefined) {
    if (!isObject(rawDiff.player)) throw invalidSection("player", "物件");
    applyPlayerPatch(next, rawDiff.player, changedPaths);
  }
  if (rawDiff.inventory !== undefined) {
    next.inventory = applyInventoryPatch(
      next.inventory,
      rawDiff.inventory,
      changedPaths,
      options.idempotencyKey,
    );
  }

  for (const key of ["npcs", "compendium", "map", "quests"] as const) {
    if (rawDiff[key] !== undefined) {
      next[key] = applyCollectionPatch(next[key], rawDiff[key], key, changedPaths);
    }
  }

  if (rawDiff.history !== undefined) {
    applyHistoryPatch(next, rawDiff.history, changedPaths);
  }

  normalizeKnowledgeState(next, true);

  ensureAcquisitionRecords(current, next, initializingPlayer, changedPaths);

  if (changedPaths.size === 0) {
    throw new AegisError("NO_STATE_CHANGE", "提交內容沒有造成任何狀態變更。", {
      changedPaths: [],
    });
  }

  next.revision = current.revision + 1;
  next.updatedAt = new Date().toISOString();
  recordAutomaticSave(next, options.idempotencyKey, options.turnSummary, [...changedPaths]);
  trimHistory(next);
  validateGameState(next, options.maxStateBytes);

  return { game: next, changedPaths: [...changedPaths].sort() };
}

function applyPlayerPatch(state: GameState, patch: JsonObject, changed: Set<string>): void {
  const rest = cloneState(patch);
  for (const key of ["equipment", "equippedItems", "activeEquipmentModifiers"] as const) {
    if (rest[key] !== undefined) {
      throw new AegisError(
        "INVALID_DIFF",
        `player.${key} 只能透過 aegis_equip_item 或 aegis_unequip_item 修改。`,
      );
    }
  }
  if (rest.skills !== undefined) {
    if (!Array.isArray(rest.skills)) throw invalidSection("player.skills", "陣列");
    const skills = normalizeSkills(objectsOnly(rest.skills, "player.skills"), true);
    if (!sameJson(state.player.skills, skills)) {
      state.player.skills = skills;
      changed.add("player.skills");
    }
    delete rest.skills;
  }
  mergeObject(state.player, rest, "player", changed);
}

function applyInventoryPatch(
  current: JsonObject[],
  patch: JsonValue,
  changed: Set<string>,
  seed: string,
): JsonObject[] {
  if (Array.isArray(patch)) {
    const replacement = normalizeInventory(objectsOnly(patch, "inventory"), "inventory", true, seed);
    if (sameJson(current, replacement)) return cloneState(current);
    changed.add("inventory");
    return replacement;
  }
  if (!isObject(patch)) throw invalidSection("inventory", "陣列或物件");

  let result = cloneState(current);
  if (patch.replace !== undefined) {
    if (!Array.isArray(patch.replace)) throw invalidSection("inventory.replace", "陣列");
    const replacement = normalizeInventory(
      objectsOnly(patch.replace, "inventory.replace"),
      "inventory.replace",
      true,
      seed,
    );
    if (!sameJson(result, replacement)) {
      result = replacement;
      changed.add("inventory");
    }
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
      const equipmentWithoutInstance = item.instanceId === undefined && (
        normalizeCategoryForAdd(item) === "equipment" || item.equippable === true ||
        item.slot !== undefined || item.equipmentSlot !== undefined || item.equipmentSlots !== undefined
      );
      const index = equipmentWithoutInstance ? -1 : findEntityIndex(result, item);
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
  return normalizeInventory(result, "inventory", true, seed).filter((item) => item.quantity !== 0);
}

function applyCollectionPatch(
  current: JsonObject[],
  patch: JsonValue,
  path: string,
  changed: Set<string>,
): JsonObject[] {
  if (Array.isArray(patch)) {
    const replacement = objectsOnly(patch, path);
    if (sameJson(current, replacement)) return cloneState(current);
    changed.add(path);
    return replacement;
  }
  if (!isObject(patch)) throw invalidSection(path, "陣列或物件");
  const unknown = Object.keys(patch).filter((key) => !["replace", "upsert", "remove"].includes(key));
  if (unknown.length) throw new AegisError("INVALID_DIFF", `${path} 含有未知操作：${unknown.join(", ")}`);
  let result = cloneState(current);
  if (patch.replace !== undefined) {
    if (!Array.isArray(patch.replace)) throw invalidSection(`${path}.replace`, "陣列");
    const replacement = objectsOnly(patch.replace, `${path}.replace`);
    if (!sameJson(result, replacement)) {
      result = replacement;
      changed.add(path);
    }
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
  const unknown = Object.keys(patch).filter((key) => !["recent", "major", "summary", "append"].includes(key));
  if (unknown.length) throw new AegisError("INVALID_DIFF", `history 含有未知操作：${unknown.join(", ")}`);
  for (const key of ["recent", "major", "summary"] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (!Array.isArray(value)) throw invalidSection(`history.${key}`, "陣列");
    if (!sameJson(state.history[key], value)) {
      state.history[key] = cloneState(value);
      changed.add(`history.${key}`);
    }
  }
  if (patch.append !== undefined && !Array.isArray(patch.append)) {
    throw invalidSection("history.append", "陣列");
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
      changed.add(path);
    }
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
  if (value.instanceId !== undefined && value.instanceId !== "") return `instance:${String(value.instanceId)}`;
  if (value.mapId !== undefined && value.mapId !== "") return `map:${String(value.mapId)}`;
  if (value.npcId !== undefined && value.npcId !== "") return `npc:${String(value.npcId)}`;
  if (value.entryId !== undefined && value.entryId !== "") return `entry:${String(value.entryId)}`;
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

function normalizeInventory(
  items: JsonObject[],
  path: string,
  strictCategory = false,
  seed = path,
): JsonObject[] {
  const normalized = items.map((raw, index) => {
    const item = cloneState(raw);
    item.quantity = inventoryQuantity(item, 1, `${path}[${index}].quantity`);
    delete item.qty;
    return item;
  });
  return normalizeInventoryRecords(normalized, seed, strictCategory);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function ensureAcquisitionRecords(
  current: GameState,
  next: GameState,
  initializingPlayer: boolean,
  changed: Set<string>,
): void {
  for (const item of next.inventory) {
    const existed = current.inventory.some((candidate) => samePersistentEntity(candidate, item));
    if (existed || isObject(item.acquisition)) continue;
    if (!initializingPlayer) {
      throw new AegisError(
        "INVALID_DIFF",
        `新物品 ${String(item.name ?? item.id ?? item.instanceId ?? "未命名物品")} 必須記錄 acquisition 取得來源。`,
      );
    }
    item.acquisition = { type: "initial_item", sourceName: "角色創建", obtainedAtTick: 0 };
    changed.add("inventory");
  }

  const currentSkills = Array.isArray(current.player.skills)
    ? current.player.skills.filter(isObject)
    : [];
  const nextSkills = Array.isArray(next.player.skills)
    ? next.player.skills.filter(isObject)
    : [];
  for (const skill of nextSkills) {
    const existed = currentSkills.some((candidate) => samePersistentEntity(candidate, skill));
    if (existed || isObject(skill.acquisition)) continue;
    if (!initializingPlayer) {
      throw new AegisError(
        "INVALID_DIFF",
        `新技能 ${String(skill.name ?? skill.id ?? "未命名技能")} 必須記錄 acquisition 取得來源。`,
      );
    }
    skill.acquisition = { type: "initial_skill", sourceName: "角色創建" };
    changed.add("player.skills");
  }
}

function samePersistentEntity(left: JsonObject, right: JsonObject): boolean {
  if (left.instanceId && right.instanceId) return left.instanceId === right.instanceId;
  if (left.id && right.id) return left.id === right.id;
  return Boolean(left.name && right.name && left.name === right.name && left.quality === right.quality);
}

function withoutQuantity(object: JsonObject): JsonObject {
  const result = cloneState(object);
  delete result.quantity;
  delete result.qty;
  return result;
}

function normalizeCategoryForAdd(item: JsonObject): string {
  return categorizeItem(item, true);
}

function invalidSection(path: string, expected: string): AegisError {
  return new AegisError("INVALID_DIFF", `${path} 必須是${expected}。`);
}
