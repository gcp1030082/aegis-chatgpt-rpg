import { asObject, cloneState, toGameView } from "./default-state.js";
import { formatHistoryEvent } from "./history.js";
import type { DashboardGameView, GameState, JsonObject, JsonValue } from "./types.js";

export const DASHBOARD_LIMITS = {
  mapNodes: 40,
  npcs: 60,
  compendiumEntries: 60,
  npcInformation: 8,
  npcServices: 8,
  npcMemories: 6,
  compendiumFacts: 8,
  historyEvents: 20,
  inventoryItems: 160,
  quests: 100,
  skills: 100,
  textLength: 500,
} as const;

export function toDashboardView(state: GameState): DashboardGameView {
  const base = toGameView(state);
  const references = buildReferenceIndexes(state);
  const local = localMapSlice(state);
  const includedMapIds = new Set(local.map((entry) => String(entry.mapId)));
  const map = local.map((entry) => mapDashboardEntry(entry, references, includedMapIds));
  const npcs = prioritizedNpcs(state, includedMapIds).slice(0, DASHBOARD_LIMITS.npcs)
    .map((npc) => npcDashboardEntry(npc, references));
  const compendium = state.compendium.slice(0, DASHBOARD_LIMITS.compendiumEntries)
    .map((entry) => compendiumDashboardEntry(entry, references));
  const historyEvents = state.history.recent.slice(-DASHBOARD_LIMITS.historyEvents).map((raw) => {
    const event = isObject(raw) ? boundedObject(raw, 0) : { type: "general", summary: String(raw) };
    event.displayText = formatHistoryEvent(raw);
    return event;
  });
  const player = boundedObject(base.player, 0);
  if (Array.isArray(player.skills)) player.skills = player.skills.slice(0, DASHBOARD_LIMITS.skills);
  const currentMapId = String(asObject(state.player.location).mapId ?? "");
  const currentPath = deriveMapPath(state.map, currentMapId).map((entry) => ({
    mapId: String(entry.mapId),
    name: String(entry.name),
  }));

  return {
    gameId: base.gameId,
    title: truncate(base.title, 100),
    revision: base.revision,
    updatedAt: base.updatedAt,
    world: boundedObject(base.world, 0),
    player,
    inventory: base.inventory.slice(0, DASHBOARD_LIMITS.inventoryItems).map((item) => boundedObject(item, 0)),
    quests: base.quests.slice(0, DASHBOARD_LIMITS.quests).map((quest) => boundedObject(quest, 0)),
    map,
    npcs,
    compendium,
    recentHistory: cloneState(historyEvents),
    autoSave: boundedObject(base.autoSave, 0),
    mapIndex: {
      currentMapId,
      currentPath,
      totalKnownNodes: state.map.length,
      visibleNodes: map.length,
      maxVisibleNodes: DASHBOARD_LIMITS.mapNodes,
      truncated: state.map.length > map.length,
    },
    referenceIndex: {
      maps: objectIndex(references.maps),
      npcs: objectIndex(references.npcs),
      quests: objectIndex(references.quests),
      compendium: objectIndex(references.compendium),
    },
    historyEvents,
    payloadLimits: {
      mapNodes: DASHBOARD_LIMITS.mapNodes,
      npcs: DASHBOARD_LIMITS.npcs,
      compendiumEntries: DASHBOARD_LIMITS.compendiumEntries,
      historyEvents: DASHBOARD_LIMITS.historyEvents,
    },
  };
}

export function dashboardPayloadBytes(state: GameState): number {
  return Buffer.byteLength(JSON.stringify(toDashboardView(state)), "utf8");
}

export function stableMapNodePosition(mapId: string, depth: number): { x: number; y: number } {
  let hash = 2_166_136_261;
  for (let index = 0; index < mapId.length; index += 1) {
    hash ^= mapId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  const unsigned = hash >>> 0;
  return {
    x: 70 + Math.max(0, depth) * 185 + ((unsigned >>> 8) % 3) * 25,
    y: 55 + (unsigned % 19) * 76,
  };
}

function localMapSlice(state: GameState): JsonObject[] {
  if (state.map.length <= DASHBOARD_LIMITS.mapNodes) return cloneState(state.map);
  const byId = new Map(state.map.map((entry) => [String(entry.mapId), entry]));
  const currentMapId = String(asObject(state.player.location).mapId ?? "");
  const priority = new Map<string, number>();
  const add = (id: string, score: number) => {
    if (!id || !byId.has(id)) return;
    priority.set(id, Math.min(priority.get(id) ?? Number.POSITIVE_INFINITY, score));
  };
  add(currentMapId, 0);
  let cursor = byId.get(currentMapId);
  let depth = 0;
  while (cursor && typeof cursor.parentMapId === "string") {
    add(cursor.parentMapId, 1 + depth);
    cursor = byId.get(cursor.parentMapId);
    depth += 1;
  }
  const current = byId.get(currentMapId);
  const parentId = typeof current?.parentMapId === "string" ? current.parentMapId : "";
  for (const entry of state.map) {
    const id = String(entry.mapId);
    if (entry.parentMapId === currentMapId) add(id, 2);
    if (parentId && entry.parentMapId === parentId) add(id, 3);
  }
  for (const source of state.map) {
    const sourceId = String(source.mapId);
    for (const route of objects(source.routes)) {
      const destination = String(route.toMapId ?? "");
      if (sourceId === currentMapId) add(destination, 2);
      if (destination === currentMapId) add(sourceId, 2);
    }
  }
  if (priority.size < DASHBOARD_LIMITS.mapNodes) {
    for (const entry of state.map) {
      if (entry.parentMapId === undefined) add(String(entry.mapId), 8);
    }
  }
  return [...state.map]
    .sort((left, right) => {
      const leftId = String(left.mapId);
      const rightId = String(right.mapId);
      return (priority.get(leftId) ?? 99) - (priority.get(rightId) ?? 99) || leftId.localeCompare(rightId);
    })
    .slice(0, DASHBOARD_LIMITS.mapNodes)
    .map((entry) => cloneState(entry));
}

function mapDashboardEntry(
  raw: JsonObject,
  refs: ReferenceIndexes,
  includedMapIds: Set<string>,
): JsonObject {
  const entry = boundedObject(raw, 0);
  if (Array.isArray(entry.routes)) {
    entry.routes = entry.routes
      .filter((route) => isObject(route) && includedMapIds.has(String(route.toMapId ?? "")))
      .slice(0, 12);
  }
  if (Array.isArray(entry.facilities)) entry.facilities = entry.facilities.slice(0, 20);
  if (Array.isArray(entry.knownDangers)) entry.knownDangers = entry.knownDangers.slice(0, 20);
  const references = asObject(entry.references);
  entry.referenceLabels = {
    npcs: resolveNames(references.npcIds, refs.npcs),
    quests: resolveNames(references.questIds, refs.quests),
    compendium: resolveNames(references.compendiumIds, refs.compendium),
  };
  return entry;
}

function prioritizedNpcs(state: GameState, includedMapIds: Set<string>): JsonObject[] {
  return [...state.npcs].sort((left, right) => {
    const leftLocal = includedMapIds.has(String(asObject(left.location).mapId ?? "")) ? 0 : 1;
    const rightLocal = includedMapIds.has(String(asObject(right.location).mapId ?? "")) ? 0 : 1;
    return leftLocal - rightLocal || String(left.npcId).localeCompare(String(right.npcId));
  });
}

function npcDashboardEntry(raw: JsonObject, refs: ReferenceIndexes): JsonObject {
  const npc = boundedObject(raw, 0);
  if (Array.isArray(npc.knownInformation)) npc.knownInformation = npc.knownInformation.slice(-DASHBOARD_LIMITS.npcInformation);
  if (Array.isArray(npc.services)) npc.services = npc.services.slice(0, DASHBOARD_LIMITS.npcServices);
  if (Array.isArray(npc.memories)) npc.memories = npc.memories.slice(-DASHBOARD_LIMITS.npcMemories);
  const location = asObject(npc.location);
  npc.locationSummary = typeof location.mapId === "string"
    ? refs.maps.get(location.mapId) ?? String(location.name ?? "位置未知")
    : String(location.name ?? "位置未知");
  npc.relationshipLabel = String(asObject(npc.relationship).label ?? "尚無明確關係");
  npc.questNames = resolveNames(npc.questIds, refs.quests);
  return npc;
}

function compendiumDashboardEntry(raw: JsonObject, refs: ReferenceIndexes): JsonObject {
  const entry = boundedObject(raw, 0);
  if (Array.isArray(entry.facts)) {
    const stageLimit = { rumor: 1, observed: 2, identified: 4, verified: 6, researched: 8 }[String(entry.stage)] ?? 1;
    entry.facts = entry.facts.slice(0, Math.min(stageLimit, DASHBOARD_LIMITS.compendiumFacts));
  }
  entry.relatedNames = {
    maps: resolveNames(entry.relatedMapIds, refs.maps),
    npcs: resolveNames(entry.relatedNpcIds, refs.npcs),
    quests: resolveNames(entry.questIds, refs.quests),
  };
  return entry;
}

function buildReferenceIndexes(state: GameState): ReferenceIndexes {
  return {
    maps: new Map(state.map.map((entry) => [String(entry.mapId), truncate(String(entry.name), 100)])),
    npcs: new Map(state.npcs.map((npc) => [String(npc.npcId), truncate(String(npc.name), 100)])),
    quests: new Map(state.quests.map((quest) => [String(quest.questId), truncate(String(quest.name), 100)])),
    compendium: new Map(state.compendium.map((entry) => [String(entry.entryId), truncate(String(entry.name), 100)])),
  };
}

function deriveMapPath(entries: JsonObject[], mapId: string): JsonObject[] {
  const byId = new Map(entries.map((entry) => [String(entry.mapId), entry]));
  const path: JsonObject[] = [];
  const seen = new Set<string>();
  let cursor = byId.get(mapId);
  while (cursor) {
    const id = String(cursor.mapId);
    if (seen.has(id)) break;
    seen.add(id);
    path.unshift(cursor);
    cursor = typeof cursor.parentMapId === "string" ? byId.get(cursor.parentMapId) : undefined;
  }
  return path;
}

function boundedObject(raw: JsonObject, depth: number): JsonObject {
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(raw).slice(0, 80)) result[key] = bounded(value, depth + 1);
  return result;
}

function bounded(value: JsonValue, depth: number): JsonValue {
  if (typeof value === "string") return truncate(value, DASHBOARD_LIMITS.textLength);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 8) return "資料已精簡";
  if (Array.isArray(value)) return value.slice(0, 160).map((item) => bounded(item, depth + 1));
  return boundedObject(value, depth);
}

function resolveNames(raw: JsonValue | undefined, index: Map<string, string>): JsonValue[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 30).map((id) => ({ id: String(id), name: index.get(String(id)) ?? "未知項目" }));
}

function objectIndex(index: Map<string, string>): JsonObject {
  return Object.fromEntries([...index.entries()].slice(0, 300)) as JsonObject;
}

function objects(raw: JsonValue | undefined): JsonObject[] {
  return Array.isArray(raw) ? raw.filter(isObject) : [];
}

function isObject(value: JsonValue): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

interface ReferenceIndexes {
  maps: Map<string, string>;
  npcs: Map<string, string>;
  quests: Map<string, string>;
  compendium: Map<string, string>;
}
