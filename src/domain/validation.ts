import { AegisError } from "./errors.js";
import type { GameState, JsonObject, JsonValue } from "./types.js";
import { isItemCategory } from "./inventory.js";
import { collectEquipmentModifiers } from "./equipment.js";
import { validateKnowledgeState } from "./knowledge.js";
import { validateClockState, calendarOf } from "./clock.js";
import { validateHistoryState } from "./history.js";
import { validateQuestReferences, validateQuestState } from "./quests.js";
import { SCHEMA_VERSION } from "./default-state.js";
import { assertNoPrivateStateFields } from "./metadata.js";

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

  if (state.schemaVersion !== SCHEMA_VERSION) {
    throw new AegisError("INVALID_STATE", `schemaVersion 必須是 ${SCHEMA_VERSION}。`);
  }
  try {
    assertNoPrivateStateFields(state, "GameState");
  } catch (error) {
    if (error instanceof AegisError) {
      throw new AegisError("INVALID_STATE", error.message);
    }
    throw error;
  }
  for (const forbidden of ["privateWorld", "privateState", "npcPrivateState", "secrets"] as const) {
    if (forbidden in (state as unknown as Record<string, unknown>)) {
      throw new AegisError("INVALID_STATE", `玩家 GameState 不得包含私密欄位 ${forbidden}。`);
    }
  }

  if (!Number.isInteger(state.revision) || state.revision < 0) {
    throw new AegisError("INVALID_STATE", "revision 必須是非負整數。");
  }
  const autoSave = state.engine.autoSave;
  if (!isObject(autoSave) || autoSave.status !== "saved") {
    throw new AegisError("INVALID_STATE", "engine.autoSave 必須記錄已保存狀態。");
  }
  if (autoSave.revision !== state.revision || typeof autoSave.savedAt !== "string") {
    throw new AegisError("INVALID_STATE", "engine.autoSave 必須與目前 revision 及保存時間一致。");
  }
  for (const [key, value] of [["world", state.world], ["player", state.player], ["history", state.history], ["engine", state.engine]] as const) {
    if (!isObject(value)) throw new AegisError("INVALID_STATE", `${key} 必須是物件。`);
  }
  if (state.world.survivalBalance !== undefined) {
    if (!isObject(state.world.survivalBalance)) {
      throw new AegisError("INVALID_STATE", "world.survivalBalance 必須是物件。");
    }
    for (const key of ["hungerPerGameHour", "hydrationPerGameHour"] as const) {
      const value = state.world.survivalBalance[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
        throw new AegisError("INVALID_STATE", `world.survivalBalance.${key} 必須是 0～100 的有限數字。`);
      }
    }
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
  validateClockState(state);
  validateQuestState(state);
  validateKnowledgeState(state);
  validateQuestReferences(state);
  validateHistoryState(state);
  validateServerMetadata(state);

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
  if (typeof state.player.initialized !== "boolean") {
    throw new AegisError("INVALID_STATE", "player.initialized 必須是布林值。");
  }
  state.player.skills.forEach((skill, index) => {
    if (!isObject(skill)) throw new AegisError("INVALID_STATE", `player.skills[${index}] 必須是物件。`);
    if (typeof skill.category !== "string" || !skill.category || typeof skill.categoryLabel !== "string" || !skill.categoryLabel) {
      throw new AegisError("INVALID_STATE", `player.skills[${index}] 必須有單一主要分類與繁體中文標籤。`);
    }
    if (skill.effects !== undefined && (!Array.isArray(skill.effects) || skill.effects.some((effect) => !isObject(effect)))) {
      throw new AegisError("INVALID_STATE", `player.skills[${index}].effects 必須是物件陣列。`);
    }
    if (Array.isArray(skill.effects)) skill.effects.forEach((effect, effectIndex) => validateEffect(effect, `player.skills[${index}].effects[${effectIndex}]`));
    if (skill.tags !== undefined && (!Array.isArray(skill.tags) || skill.tags.some((tag) => typeof tag !== "string"))) {
      throw new AegisError("INVALID_STATE", `player.skills[${index}].tags 必須是字串陣列。`);
    }
    validateAcquisition(skill.acquisition, `player.skills[${index}].acquisition`);
    if (skill.category === "unique" && (typeof skill.uniqueScope !== "string" || typeof skill.uniqueHolderId !== "string")) {
      throw new AegisError("INVALID_STATE", `player.skills[${index}] 的唯一技能依據不完整。`);
    }
  });
  if (!isObject(state.player.equipment)) {
    throw new AegisError("INVALID_STATE", "player.equipment 必須是物件。");
  }
  if (!isObject(state.player.equippedItems)) {
    throw new AegisError("INVALID_STATE", "player.equippedItems 必須是物件。");
  }
  if (!Array.isArray(state.player.activeEquipmentModifiers)) {
    throw new AegisError("INVALID_STATE", "player.activeEquipmentModifiers 必須是陣列。");
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
    if (typeof item.instanceId !== "string" || !item.instanceId) {
      throw new AegisError("INVALID_STATE", `inventory[${index}].instanceId 必須是非空字串。`);
    }
    if (item.location !== "inventory") {
      throw new AegisError("INVALID_STATE", `inventory[${index}].location 必須是 inventory。`);
    }
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
    if (item.effects !== undefined && (!Array.isArray(item.effects) || item.effects.some((effect) => !isObject(effect)))) {
      throw new AegisError("INVALID_STATE", `inventory[${index}].effects 必須是物件陣列。`);
    }
    if (Array.isArray(item.effects)) item.effects.forEach((effect, effectIndex) => validateEffect(effect, `inventory[${index}].effects[${effectIndex}]`));
    if (item.modifiers !== undefined && (!Array.isArray(item.modifiers) || item.modifiers.some((modifier) => !isObject(modifier)))) {
      throw new AegisError("INVALID_STATE", `inventory[${index}].modifiers 必須是物件陣列。`);
    }
    if (Array.isArray(item.modifiers)) item.modifiers.forEach((modifier, modifierIndex) => validateModifier(modifier, `inventory[${index}].modifiers[${modifierIndex}]`));
    validateAcquisition(item.acquisition, `inventory[${index}].acquisition`);
  }

  const inventoryIds = new Set<string>();
  for (const [index, item] of state.inventory.entries()) {
    const id = String(item.instanceId);
    if (inventoryIds.has(id)) throw new AegisError("INVALID_STATE", `inventory 中存在重複 instanceId：${id}。`);
    inventoryIds.add(id);
    if (
      (item.category === "equipment" || item.equippable === true || item.slot !== undefined || item.equipmentSlot !== undefined || item.equipmentSlots !== undefined) &&
      item.quantity !== 1
    ) {
      throw new AegisError("INVALID_STATE", `inventory[${index}] 的裝備物品 quantity 必須是 1。`);
    }
  }

  const registry = state.player.equippedItems;
  const referenced = new Set<string>();
  for (const [slot, ref] of Object.entries(state.player.equipment)) {
    if (ref === null || ref === "") continue;
    if (typeof ref !== "string") {
      throw new AegisError("INVALID_STATE", `player.equipment.${slot} 必須是 instanceId 字串或 null。`);
    }
    if (referenced.has(ref)) throw new AegisError("INVALID_STATE", `裝備實例 ${ref} 被多個欄位引用。`);
    referenced.add(ref);
    const rawItem = registry[ref];
    if (!isObject(rawItem)) throw new AegisError("INVALID_STATE", `player.equipment.${slot} 引用了不存在的物品 ${ref}。`);
    if (rawItem.instanceId !== ref || rawItem.location !== "equipped" || rawItem.equippedSlot !== slot) {
      throw new AegisError("INVALID_STATE", `已裝備物品 ${ref} 的位置資料與欄位 ${slot} 不一致。`);
    }
    if (inventoryIds.has(ref)) throw new AegisError("INVALID_STATE", `物品實例 ${ref} 同時存在於背包與裝備欄。`);
  }
  for (const [instanceId, rawItem] of Object.entries(registry)) {
    if (!isObject(rawItem)) throw new AegisError("INVALID_STATE", `player.equippedItems.${instanceId} 必須是物件。`);
    if (!referenced.has(instanceId)) throw new AegisError("INVALID_STATE", `已裝備物品 ${instanceId} 沒有裝備欄引用。`);
    if (!isItemCategory(rawItem.category)) {
      throw new AegisError("INVALID_STATE", `player.equippedItems.${instanceId}.category 不是有效的主要分類。`);
    }
    if (rawItem.quantity !== 1) {
      throw new AegisError("INVALID_STATE", `player.equippedItems.${instanceId}.quantity 必須是 1。`);
    }
    if (Array.isArray(rawItem.effects)) rawItem.effects.forEach((effect, index) => validateEffect(effect, `player.equippedItems.${instanceId}.effects[${index}]`));
    if (rawItem.effects !== undefined && !Array.isArray(rawItem.effects)) {
      throw new AegisError("INVALID_STATE", `player.equippedItems.${instanceId}.effects 必須是陣列。`);
    }
    if (Array.isArray(rawItem.modifiers)) rawItem.modifiers.forEach((modifier, index) => validateModifier(modifier, `player.equippedItems.${instanceId}.modifiers[${index}]`));
    if (rawItem.modifiers !== undefined && !Array.isArray(rawItem.modifiers)) {
      throw new AegisError("INVALID_STATE", `player.equippedItems.${instanceId}.modifiers 必須是陣列。`);
    }
    validateAcquisition(rawItem.acquisition, `player.equippedItems.${instanceId}.acquisition`);
  }
  const expectedModifiers = collectEquipmentModifiers(state.player.equipment, registry);
  if (JSON.stringify(expectedModifiers) !== JSON.stringify(state.player.activeEquipmentModifiers)) {
    throw new AegisError("INVALID_STATE", "player.activeEquipmentModifiers 與目前裝備狀態不一致。");
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

function validateServerMetadata(state: GameState): void {
  const calendar = calendarOf(state);
  const revisionKeys = /^(firstLearnedAt|lastUpdatedAt|lastVerifiedAt|learnedAt|createdAt|observedAt)Revision$/u;
  const gameTimeKeys = /^(firstLearnedAt|lastUpdatedAt|lastVerifiedAt|learnedAt|createdAt|observedAt)GameTime$/u;
  const walk = (value: JsonValue, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => walk(child, `${path}[${index}]`));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (revisionKeys.test(key)) {
        if (typeof child !== "number" || !Number.isInteger(child) || child < 0 || child > state.revision) {
          throw new AegisError("INVALID_STATE", `${childPath} 必須是有效的伺服器 revision。`);
        }
      } else if (gameTimeKeys.test(key)) {
        validateGameTimeSnapshot(child, childPath, calendar);
      }
      walk(child, childPath);
    }
  };
  walk(state as unknown as JsonValue, "game");
}

function validateGameTimeSnapshot(
  value: JsonValue,
  path: string,
  calendar: ReturnType<typeof calendarOf>,
): void {
  if (!isObject(value)) throw new AegisError("INVALID_STATE", `${path} 必須是遊戲時間快照。`);
  const month = calendar.months.find((candidate) => candidate.monthId === value.monthId);
  if (typeof value.year !== "number" || !Number.isInteger(value.year) || value.year < 0 ||
    !month || typeof value.day !== "number" || !Number.isInteger(value.day) || value.day < 1 || value.day > month.days ||
    typeof value.minuteOfDay !== "number" || !Number.isInteger(value.minuteOfDay) || value.minuteOfDay < 0 ||
    value.minuteOfDay >= calendar.hoursPerDay * calendar.minutesPerHour) {
    throw new AegisError("INVALID_STATE", `${path} 不是有效的遊戲時間快照。`);
  }
}

export function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateEffect(value: JsonValue, path: string): void {
  if (!isObject(value) || typeof value.type !== "string" || !value.type.trim()) {
    throw new AegisError("INVALID_STATE", `${path}.type 必須是非空字串。`);
  }
  if (value.value !== undefined && (typeof value.value !== "number" || !Number.isFinite(value.value))) {
    throw new AegisError("INVALID_STATE", `${path}.value 必須是有限數字。`);
  }
}

function validateModifier(value: JsonValue, path: string): void {
  if (!isObject(value) || typeof value.stat !== "string" || !value.stat.trim()) {
    throw new AegisError("INVALID_STATE", `${path}.stat 必須是非空字串。`);
  }
  if (!(["add", "subtract", "multiply"] as JsonValue[]).includes(value.operation ?? "add")) {
    throw new AegisError("INVALID_STATE", `${path}.operation 必須是 add、subtract 或 multiply。`);
  }
  if (typeof value.value !== "number" || !Number.isFinite(value.value)) {
    throw new AegisError("INVALID_STATE", `${path}.value 必須是有限數字。`);
  }
}

function validateAcquisition(value: JsonValue | undefined, path: string): void {
  if (value === undefined) return;
  if (!isObject(value) || typeof value.type !== "string" || !value.type.trim()) {
    throw new AegisError("INVALID_STATE", `${path}.type 必須是非空字串。`);
  }
  if (value.sourceName !== undefined && typeof value.sourceName !== "string") {
    throw new AegisError("INVALID_STATE", `${path}.sourceName 必須是字串。`);
  }
  if (value.obtainedAtTick !== undefined && (typeof value.obtainedAtTick !== "number" || !Number.isInteger(value.obtainedAtTick) || value.obtainedAtTick < 0)) {
    throw new AegisError("INVALID_STATE", `${path}.obtainedAtTick 必須是非負整數。`);
  }
}
