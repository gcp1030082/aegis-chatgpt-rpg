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

export function isItemCategory(value: JsonValue | undefined): value is ItemCategory {
  return typeof value === "string" && ITEM_CATEGORIES.includes(value as ItemCategory);
}

function categoryAlias(value: string): ItemCategory | undefined {
  return CATEGORY_ALIASES[value.trim().toLowerCase()];
}

function hasTruthyFlag(item: JsonObject, keys: string[]): boolean {
  return keys.some((key) => item[key] === true);
}

function present(value: JsonValue | undefined): boolean {
  return value !== undefined && value !== null && value !== "";
}
