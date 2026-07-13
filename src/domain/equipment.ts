import type { GameState, JsonObject, JsonValue } from "./types.js";
import {
  categorizeItem,
  generatedInstanceId,
  normalizeInventoryRecords,
  normalizeItemCategory,
  normalizeItemMechanics,
} from "./inventory.js";
import { AegisError } from "./errors.js";

const cloneState = <T>(value: T): T => structuredClone(value);
const isObject = (value: unknown): value is JsonObject => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const asObject = (value: unknown): JsonObject => isObject(value) ? value : {};

const DEFAULT_SLOTS = new Set([
  "mainHand", "offHand", "head", "body", "hands", "legs", "feet", "accessory",
  "ring", "necklace", "cloak",
]);

const SLOT_ALIASES: Record<string, string> = {
  mainhand: "mainHand", main_hand: "mainHand", weapon: "mainHand", "主手": "mainHand", "武器": "mainHand",
  offhand: "offHand", off_hand: "offHand", shield: "offHand", "副手": "offHand",
  head: "head", helmet: "head", "頭部": "head", "頭盔": "head",
  body: "body", chest: "body", armor: "body", armour: "body", "身體": "body", "上身": "body", "護甲": "body",
  hands: "hands", gloves: "hands", "手部": "hands", "手套": "hands",
  legs: "legs", pants: "legs", "腿部": "legs", "褲子": "legs",
  feet: "feet", boots: "feet", "足部": "feet", "鞋子": "feet",
  accessory: "accessory", accessories: "accessory", "飾品": "accessory",
  ring: "ring", "戒指": "ring", necklace: "necklace", "項鍊": "necklace",
  cloak: "cloak", "披風": "cloak",
};

export function migrateEquipmentState(state: GameState): GameState {
  const migrated = cloneState(state);
  const player = migrated.player;
  const equipment = asObject(player.equipment);
  const rawRegistry = asObject(player.equippedItems);
  const registry: JsonObject = {};
  const used = new Set<string>();
  const legacyEquippedInventory = migrated.inventory.filter((item) => item.equipped === true);
  const inventory = normalizeInventoryRecords(migrated.inventory, `${state.gameId}:migration`, false);

  for (const [key, raw] of Object.entries(rawRegistry)) {
    if (!isObject(raw)) continue;
    const hadCategory = raw.category !== undefined || raw.type !== undefined;
    const item = normalizeItemCategory(cloneState(raw));
    if (!hadCategory) item.category = "equipment";
    normalizeItemMechanics(item, `player.equippedItems.${key}`);
    const requested = typeof item.instanceId === "string" && item.instanceId ? item.instanceId : key;
    const instanceId = requested && !used.has(requested)
      ? requested
      : generatedInstanceId(item, `${state.gameId}:equipped:${key}`, used);
    used.add(instanceId);
    item.instanceId = instanceId;
    item.quantity = 1;
    registry[instanceId] = item;
  }

  for (const [rawSlot, rawValue] of Object.entries(equipment)) {
    const slot = normalizeEquipmentSlot(rawSlot);
    if (rawValue === null || rawValue === "" || rawValue === "無" || rawValue === "未裝備") {
      equipment[slot] = null;
      if (slot !== rawSlot) delete equipment[rawSlot];
      continue;
    }
    let item: JsonObject | undefined;
    if (typeof rawValue === "string" && isObject(registry[rawValue])) {
      item = cloneState(registry[rawValue] as JsonObject);
    } else if (isObject(rawValue)) {
      item = cloneState(rawValue);
    } else if (typeof rawValue === "string") {
      const found = inventory.find((candidate) =>
        candidate.instanceId === rawValue || candidate.id === rawValue || candidate.name === rawValue,
      );
      item = found ? cloneState(found) : { name: rawValue, category: "equipment" };
    }
    if (!item) continue;
    const hadCategory = item.category !== undefined || item.type !== undefined;
    normalizeItemCategory(item);
    if (!hadCategory) item.category = "equipment";
    normalizeItemMechanics(item, `player.equipment.${slot}`);
    const requested = typeof item.instanceId === "string" ? item.instanceId : "";
    const instanceId = requested && (!used.has(requested) || isObject(registry[requested]))
      ? requested
      : generatedInstanceId(item, `${state.gameId}:slot:${slot}`, used);
    used.add(instanceId);
    item.instanceId = instanceId;
    if (item.templateId === undefined && item.id !== undefined) item.templateId = item.id;
    item.quantity = 1;
    item.location = "equipped";
    item.equippedSlot = slot;
    delete item.equipped;
    registry[instanceId] = item;
    equipment[slot] = instanceId;
    if (slot !== rawSlot) delete equipment[rawSlot];
  }

  const equippedIds = new Set(
    Object.values(equipment).filter((value): value is string => typeof value === "string" && value.length > 0),
  );
  const equippedItems = [...equippedIds]
    .map((id) => registry[id])
    .filter((value): value is JsonObject => isObject(value));
  migrated.inventory = inventory.filter((item) => {
    if (equippedIds.has(String(item.instanceId ?? ""))) return false;
    if (
      legacyEquippedInventory.some((legacy) =>
        sameLegacyItem(legacy, item) && equippedItems.some((equipped) => sameLegacyItem(legacy, equipped)),
      )
    ) return false;
    return true;
  });
  player.equipment = equipment;
  player.equippedItems = Object.fromEntries(
    [...equippedIds].flatMap((id) => isObject(registry[id]) ? [[id, registry[id]]] : []),
  );
  player.activeEquipmentModifiers = collectEquipmentModifiers(equipment, asObject(player.equippedItems));
  return migrated;
}

export function equipInventoryItem(
  state: GameState,
  instanceId: string,
  requestedSlot: string,
): { next: GameState; changedPaths: string[]; equipped: JsonObject; unequipped?: JsonObject } {
  const next = cloneState(state);
  const slot = normalizeEquipmentSlot(requestedSlot);
  const index = next.inventory.findIndex((item) => item.instanceId === instanceId);
  const incoming = next.inventory[index];
  if (index < 0 || !incoming) throw new AegisError("INVALID_DIFF", `背包中找不到物品實例 ${instanceId}。`);
  const allowed = allowedSlots(incoming);
  if (!isEquippable(incoming) || (allowed.size > 0 ? !allowed.has(slot) : !DEFAULT_SLOTS.has(slot))) {
    throw new AegisError("INVALID_DIFF", `${String(incoming.name ?? instanceId)} 無法裝備至 ${slot}。`);
  }
  const equipment = asObject(next.player.equipment);
  const registry = asObject(next.player.equippedItems);
  let unequipped: JsonObject | undefined;
  const previousRef = equipment[slot];
  if (typeof previousRef === "string" && isObject(registry[previousRef])) {
    unequipped = cloneState(registry[previousRef] as JsonObject);
    unequipped.location = "inventory";
    delete unequipped.equippedSlot;
    next.inventory.push(unequipped);
    delete registry[previousRef];
  }
  next.inventory.splice(index, 1);
  const equipped = cloneState(incoming);
  equipped.quantity = 1;
  equipped.location = "equipped";
  equipped.equippedSlot = slot;
  delete equipped.equipped;
  registry[instanceId] = equipped;
  equipment[slot] = instanceId;
  next.player.equipment = equipment;
  next.player.equippedItems = registry;
  next.player.activeEquipmentModifiers = collectEquipmentModifiers(equipment, registry);
  return {
    next,
    changedPaths: ["inventory", `player.equipment.${slot}`, "player.equippedItems", "player.activeEquipmentModifiers"],
    equipped,
    ...(unequipped ? { unequipped } : {}),
  };
}

export function unequipInventoryItem(
  state: GameState,
  requestedSlot: string,
): { next: GameState; changedPaths: string[]; unequipped: JsonObject } {
  const next = cloneState(state);
  const slot = normalizeEquipmentSlot(requestedSlot);
  const equipment = asObject(next.player.equipment);
  const registry = asObject(next.player.equippedItems);
  const ref = equipment[slot];
  if (typeof ref !== "string" || !isObject(registry[ref])) {
    throw new AegisError("NO_STATE_CHANGE", `裝備欄位 ${slot} 目前沒有可卸除物品。`, { changedPaths: [] });
  }
  const unequipped = cloneState(registry[ref] as JsonObject);
  unequipped.location = "inventory";
  delete unequipped.equippedSlot;
  equipment[slot] = null;
  delete registry[ref];
  if (next.inventory.some((item) => item.instanceId === ref)) {
    throw new AegisError("INVALID_STATE", `物品實例 ${ref} 同時存在於背包與裝備欄。`);
  }
  next.inventory.push(unequipped);
  next.player.equipment = equipment;
  next.player.equippedItems = registry;
  next.player.activeEquipmentModifiers = collectEquipmentModifiers(equipment, registry);
  return {
    next,
    changedPaths: ["inventory", `player.equipment.${slot}`, "player.equippedItems", "player.activeEquipmentModifiers"],
    unequipped,
  };
}

export function collectEquipmentModifiers(equipment: JsonObject, registry: JsonObject): JsonObject[] {
  const modifiers: JsonObject[] = [];
  for (const ref of Object.values(equipment)) {
    if (typeof ref !== "string") continue;
    const item = registry[ref];
    if (!isObject(item) || !Array.isArray(item.modifiers)) continue;
    for (const raw of item.modifiers) {
      if (!isObject(raw)) continue;
      modifiers.push({
        ...cloneState(raw),
        sourceInstanceId: ref,
        sourceName: item.name ?? "未命名裝備",
      });
    }
  }
  return modifiers;
}

export function normalizeEquipmentSlot(value: string): string {
  const trimmed = value.trim();
  return SLOT_ALIASES[trimmed.toLowerCase()] ?? SLOT_ALIASES[trimmed] ?? trimmed;
}

function isEquippable(item: JsonObject): boolean {
  return categorizeItem(item) === "equipment" || item.equippable === true || allowedSlots(item).size > 0;
}

function allowedSlots(item: JsonObject): Set<string> {
  const raw = item.equipmentSlots ?? item.equipmentSlot ?? item.slot;
  const values: JsonValue[] = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return new Set(values.filter((value): value is string => typeof value === "string").map(normalizeEquipmentSlot));
}

function sameLegacyItem(left: JsonObject, right: JsonObject): boolean {
  if (left.instanceId && right.instanceId) return left.instanceId === right.instanceId;
  if (left.id && right.id) return left.id === right.id;
  return Boolean(left.name && right.name && left.name === right.name);
}
