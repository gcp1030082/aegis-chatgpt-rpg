import { createHash } from "node:crypto";
import { AegisError } from "./errors.js";
import type { JsonObject, JsonValue } from "./types.js";

export const ITEM_CATEGORIES = ["consumable", "equipment", "misc", "special"] as const;
export type ItemCategory = (typeof ITEM_CATEGORIES)[number];

const CATEGORY_ALIASES: Record<string, ItemCategory> = {
  consumable: "consumable",
  food: "consumable",
  drink: "consumable",
  beverage: "consumable",
  potion: "consumable",
  medicine: "consumable",
  "消耗品": "consumable",
  "食物": "consumable",
  "食品": "consumable",
  "飲料": "consumable",
  "飲品": "consumable",
  "藥品": "consumable",
  "藥水": "consumable",
  equipment: "equipment",
  equip: "equipment",
  weapon: "equipment",
  armor: "equipment",
  armour: "equipment",
  "裝備": "equipment",
  "武器": "equipment",
  "防具": "equipment",
  misc: "misc",
  miscellaneous: "misc",
  material: "misc",
  materials: "misc",
  loot: "misc",
  tool: "misc",
  document: "misc",
  "雜物": "misc",
  "素材": "misc",
  "材料": "misc",
  "戰利品": "misc",
  "工具": "misc",
  "文件": "misc",
  special: "special",
  quest: "special",
  quest_item: "special",
  key: "special",
  key_item: "special",
  "特殊": "special",
  "特殊物品": "special",
  "任務道具": "special",
  "關鍵道具": "special",
  "鑰匙": "special",
};

export function categorizeItem(item: JsonObject, strictExplicit = false): ItemCategory {
  const explicit = item.category;
  if (strictExplicit && explicit !== undefined && (typeof explicit !== "string" || !explicit.trim())) {
    throw new AegisError(
      "INVALID_DIFF",
      `物品 ${String(item.name ?? item.id ?? "未命名物品")} 的 category 必須是非空字串。`,
    );
  }
  if (typeof explicit === "string" && explicit.trim()) {
    const category = categoryAlias(explicit);
    if (category) return category;
    if (strictExplicit) {
      throw new AegisError(
        "INVALID_DIFF",
        `物品 ${String(item.name ?? item.id ?? "未命名物品")} 的 category 必須是 consumable、equipment、misc 或 special。`,
      );
    }
  }

  const type = typeof item.type === "string" ? categoryAlias(item.type) : undefined;
  if (type) return type;
  if (hasTruthyFlag(item, [
    "questItem", "keyItem", "criticalItem", "unsellable", "undroppable", "不可出售", "不可丟棄",
  ])) return "special";
  if (hasTruthyFlag(item, ["equippable", "可裝備"]) || present(item.slot) || present(item.equipmentSlot)) {
    return "equipment";
  }
  if (
    hasTruthyFlag(item, ["consumable", "可消耗"]) ||
    ["hungerRestore", "hydrationRestore", "usesRemaining", "maxUses", "剩餘容量"].some(
      (key) => present(item[key]),
    )
  ) return "consumable";
  return "misc";
}

export function normalizeItemCategory(item: JsonObject, strictExplicit = false): JsonObject {
  item.category = categorizeItem(item, strictExplicit);
  return item;
}

export function normalizeInventoryRecords(
  items: JsonObject[],
  seed: string,
  strict = false,
): JsonObject[] {
  const used = new Set<string>();
  const result: JsonObject[] = [];
  items.forEach((raw, index) => {
    const item = normalizeItemCategory({ ...raw }, strict);
    if (strict && (item.location === "equipped" || item.equipped === true)) {
      throw new AegisError(
        "INVALID_DIFF",
        `inventory[${index}] 已標記為裝備中；已裝備物品不得留在背包。`,
      );
    }
    const legacyQuantity = item.quantity ?? item.qty ?? 1;
    if (typeof legacyQuantity !== "number" || !Number.isFinite(legacyQuantity) || legacyQuantity < 0) {
      throw new AegisError("INVALID_DIFF", `inventory[${index}].quantity 必須是非負有限數字。`);
    }
    const physicalEquipment = item.category === "equipment" || isEquippableRecord(item);
    if (physicalEquipment && legacyQuantity > 1000) {
      throw new AegisError("INVALID_STATE", `inventory[${index}] 的舊裝備堆疊數量異常。`);
    }
    delete item.qty;
    const copies = physicalEquipment && !strict && Number.isInteger(legacyQuantity)
      ? Math.max(0, legacyQuantity)
      : 1;
    if (physicalEquipment && strict && legacyQuantity !== 1) {
      throw new AegisError("INVALID_DIFF", `inventory[${index}] 的裝備物品 quantity 必須是 1。`);
    }
    for (let copy = 0; copy < copies; copy += 1) {
      const instance: JsonObject = {
        ...item,
        quantity: physicalEquipment ? 1 : legacyQuantity,
      };
      const requested = copy === 0 && typeof instance.instanceId === "string" ? instance.instanceId.trim() : "";
      if (requested && used.has(requested) && strict) {
        throw new AegisError("INVALID_DIFF", `inventory 中存在重複 instanceId：${requested}。`);
      }
      const instanceId = requested && !used.has(requested)
        ? requested
        : generatedInstanceId(instance, `${seed}:${index}:${copy}`, used);
      used.add(instanceId);
      instance.instanceId = instanceId;
      if (instance.templateId === undefined && instance.id !== undefined) instance.templateId = instance.id;
      instance.location = "inventory";
      delete instance.equipped;
      delete instance.equippedSlot;
      normalizeItemMechanics(instance, `inventory[${index}]`, strict);
      result.push(instance);
    }
  });
  return result;
}

export function normalizeItemMechanics(item: JsonObject, path: string, strict = false): JsonObject {
  if (item.effects !== undefined) {
    if (!Array.isArray(item.effects) || item.effects.some((effect) => !isObject(effect))) {
      throw new AegisError("INVALID_DIFF", `${path}.effects 必須是物件陣列。`);
    }
    item.effects.forEach((raw, index) => {
      const effect = raw as JsonObject;
      if (typeof effect.type !== "string" || !effect.type.trim()) {
        throw new AegisError("INVALID_DIFF", `${path}.effects[${index}].type 必須是非空字串。`);
      }
      if (effect.value !== undefined && (typeof effect.value !== "number" || !Number.isFinite(effect.value))) {
        throw new AegisError("INVALID_DIFF", `${path}.effects[${index}].value 必須是有限數字。`);
      }
    });
  } else {
    const effects: JsonObject[] = [];
    if (typeof item.hungerRestore === "number") effects.push({ type: "restore_hunger", value: item.hungerRestore });
    if (typeof item.hydrationRestore === "number") effects.push({ type: "restore_hydration", value: item.hydrationRestore });
    if (effects.length) item.effects = effects;
  }
  if (item.modifiers !== undefined && (!Array.isArray(item.modifiers) || item.modifiers.some((modifier) => !isObject(modifier)))) {
    throw new AegisError("INVALID_DIFF", `${path}.modifiers 必須是物件陣列。`);
  }
  if (Array.isArray(item.modifiers)) item.modifiers.forEach((raw, index) => {
    const modifier = raw as JsonObject;
    if (typeof modifier.stat !== "string" || !modifier.stat.trim() || typeof modifier.value !== "number" || !Number.isFinite(modifier.value)) {
      throw new AegisError("INVALID_DIFF", `${path}.modifiers[${index}] 必須包含 stat 與有限數字 value。`);
    }
    if (modifier.operation !== undefined && !["add", "subtract", "multiply"].includes(String(modifier.operation))) {
      throw new AegisError("INVALID_DIFF", `${path}.modifiers[${index}].operation 無效。`);
    }
  });
  if (item.acquisition !== undefined && !isObject(item.acquisition)) {
    throw new AegisError("INVALID_DIFF", `${path}.acquisition 必須是物件。`);
  }
  if (!isObject(item.acquisition) && typeof item.source === "string" && item.source.trim()) {
    const initial = /初始物品|角色創建|角色建立|旅行包/.test(item.source);
    item.acquisition = {
      type: initial ? "initial_item" : "recorded_source",
      sourceName: initial ? "角色創建" : item.source,
      ...(initial ? { obtainedAtTick: 0 } : {}),
    };
  }
  if (isObject(item.acquisition)) {
    if (typeof item.acquisition.type !== "string" || !item.acquisition.type.trim()) {
      if (strict) throw new AegisError("INVALID_DIFF", `${path}.acquisition.type 必須是非空字串。`);
      item.acquisition.type = "recorded_source";
    }
    if (item.acquisition.sourceName !== undefined && typeof item.acquisition.sourceName !== "string") {
      throw new AegisError("INVALID_DIFF", `${path}.acquisition.sourceName 必須是字串。`);
    }
  }
  if (strict && item.category === "all") {
    throw new AegisError("INVALID_DIFF", `${path}.category 不得使用介面分類 all。`);
  }
  return item;
}

export function generatedInstanceId(item: JsonObject, seed: string, used = new Set<string>()): string {
  const identity = [item.templateId, item.id, item.name, item.quality].filter((value) => value !== undefined).join(":");
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const hash = createHash("sha256").update(`${seed}:${identity}:${attempt}`).digest("hex").slice(0, 20);
    const candidate = `item-${hash}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new AegisError("INVALID_STATE", "無法產生唯一物品實例識別碼。");
}

export function isItemCategory(value: JsonValue | undefined): value is ItemCategory {
  return typeof value === "string" && ITEM_CATEGORIES.includes(value as ItemCategory);
}

function categoryAlias(value: string): ItemCategory | undefined {
  return CATEGORY_ALIASES[value.trim().toLowerCase()];
}

function hasTruthyFlag(item: JsonObject, keys: string[]): boolean {
  return keys.some((key) => item[key] === true);
}

function isEquippableRecord(item: JsonObject): boolean {
  return item.equippable === true || present(item.slot) || present(item.equipmentSlot) || present(item.equipmentSlots);
}

function present(value: JsonValue | undefined): boolean {
  return value !== undefined && value !== null && value !== "";
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
