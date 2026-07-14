import { createHash } from "node:crypto";
import { AegisError } from "./errors.js";
import { clockSnapshot, snapshotObject } from "./clock.js";
import type { GameState, JsonObject, JsonValue } from "./types.js";

const MAP_KINDS = new Set(["region", "town", "place", "subplace"]);
const DISCOVERY_STAGES = new Set(["heard", "known", "visited", "surveyed"]);
const DANGER_LEVELS = new Set(["unknown", "low", "moderate", "high", "extreme"]);
const ROUTE_MODES = new Set(["walk", "ride", "boat", "other"]);
const ESTIMATE_CONFIDENCE = new Set(["rough", "normal", "confirmed"]);
const ROUTE_KNOWLEDGE = new Set(["heard", "known", "verified"]);
const FAMILIARITY_STAGES = new Set(["heard", "met", "acquainted", "familiar", "trusted"]);
const LOCATION_STATUSES = new Set(["current", "last_known", "unknown"]);
const KNOWLEDGE_STAGES = new Set(["rumor", "observed", "identified", "verified", "researched"]);
const CONFIDENCE_LEVELS = new Set(["low", "medium", "high", "confirmed"]);
const SOURCE_TYPES = new Set(["rumor", "npc", "observation", "skill", "book", "document", "experiment", "quest", "other"]);
const MEMORY_IMPORTANCE = new Set(["minor", "important", "major"]);

const MAP_META = ["firstLearnedAtRevision", "firstLearnedAtGameTime", "lastUpdatedAtRevision", "lastUpdatedAtGameTime"] as const;
const ROUTE_META = ["firstLearnedAtRevision", "firstLearnedAtGameTime", "lastVerifiedAtRevision", "lastVerifiedAtGameTime"] as const;
const INFO_META = ["learnedAtRevision", "learnedAtGameTime"] as const;
const LOCATION_META = ["observedAtRevision", "observedAtGameTime"] as const;
const MEMORY_META = ["createdAtRevision", "createdAtGameTime"] as const;
const FACT_META = MAP_META;

const MAP_KEYS = set([
  "mapId", "name", "kind", "parentMapId", "discovery", "description", "routes", "facilities",
  "knownDangers", "references", ...MAP_META,
]);
const ROUTE_KEYS = set([
  "routeId", "toMapId", "estimatedMinutes", "travelMode", "estimateConfidence", "danger", "conditions",
  "requirements", "notes", "knowledgeStatus", "sourceType", "sourceId", "estimatedTravel", "travelTime", ...ROUTE_META,
]);
const FACILITY_KEYS = set(["facilityId", "name", "type", "availability"]);
const DANGER_KEYS = set(["dangerId", "name", "severity", "description", "confirmed", "sourceType", "sourceId"]);
const REFERENCE_KEYS = set(["npcIds", "questIds", "compendiumIds"]);
const NPC_KEYS = set([
  "npcId", "name", "identity", "familiarity", "relationship", "location", "knownInformation", "services",
  "memories", "questIds",
]);
const RELATIONSHIP_KEYS = set(["label", "tags"]);
const NPC_LOCATION_KEYS = set(["mapId", "name", "status", "observedAtTick", ...LOCATION_META]);
const INFORMATION_KEYS = set(["infoId", "content", "text", "source", "sourceType", "sourceId", "confidence", "learnedAtTick", ...INFO_META]);
const SERVICE_KEYS = set(["serviceId", "name", "type", "conditions", "availability"]);
const MEMORY_KEYS = set(["memoryId", "id", "summary", "text", "importance", "tick", ...MEMORY_META]);
const COMPENDIUM_KEYS = set([
  "entryId", "name", "category", "categoryLabel", "stage", "summary", "facts", "relatedMapIds",
  "relatedNpcIds", "questIds", "tags", "description", "knownFacts", "sources", "confidence", ...MAP_META,
]);
const FACT_KEYS = set(["factId", "text", "sources", "confidence", ...FACT_META]);
const SOURCE_KEYS = set([
  "sourceType", "sourceId", "description", "type", "name", "sourceName", "obtainedAtTick", "mapId", "npcId", "eventId",
]);
const SECRET_KEYS = new Set([
  "secret", "secrets", "internalSecret", "internalSecrets", "privateState", "privateNotes", "hiddenInfo",
  "hiddenInformation", "gmNotes", "agenda", "trueIdentity", "dialogueTranscript", "transcript",
  "dialogueHistory", "fullTranscript", "reasoning", "chainOfThought",
]);

const CATEGORY_LABELS: Record<string, string> = {
  creature: "生物",
  plant: "植物",
  material: "素材",
  magical_phenomenon: "魔法現象",
  faction: "勢力",
  culture: "文化",
  other: "其他",
};

export function normalizeKnowledgeState(state: GameState, strict: boolean): void {
  state.map = normalizeMap(state, strict);
  state.npcs = normalizeNpcs(state, strict);
  state.compendium = normalizeCompendium(state, strict);
  synchronizePlayerLocation(state, strict);
  validateKnowledgeReferences(state, strict ? "INVALID_DIFF" : "INVALID_STATE");
}

export function validateKnowledgeState(state: GameState): void {
  normalizeMap(state, true, "INVALID_STATE");
  normalizeNpcs(state, true, "INVALID_STATE");
  normalizeCompendium(state, true, "INVALID_STATE");
  validateHierarchy(state.map, "INVALID_STATE");
  validateKnowledgeReferences(state, "INVALID_STATE");
  const copy = structuredClone(state);
  synchronizePlayerLocation(copy, true);
  if (!same(copy.player.location, state.player.location)) {
    throw new AegisError("INVALID_STATE", "玩家位置文字快取與權威 mapId 不一致。");
  }
}

export function playerKnowledgeView(state: GameState) {
  return {
    map: structuredClone(state.map),
    npcs: structuredClone(state.npcs),
    compendium: structuredClone(state.compendium),
  };
}

export function synchronizePlayerLocation(state: GameState, strict: boolean): void {
  const location = objectOrEmpty(state.player.location);
  if (Object.keys(location).length === 0) return;
  let mapId = text(location.mapId);
  if (!mapId && !strict) mapId = resolveLegacyPlayerMapId(state.map, location);
  if (!mapId) throw issue(strict ? "INVALID_DIFF" : "INVALID_STATE", "player.location.mapId 是唯一權威位置，必須存在。");
  const index = new Map(state.map.map((entry) => [text(entry.mapId), entry]));
  const entry = index.get(mapId);
  if (!entry) throw issue(strict ? "INVALID_DIFF" : "INVALID_STATE", `玩家目前位置 mapId ${mapId} 尚未寫入已知地圖。`);
  const path = locationPath(entry, index);
  const normalized: JsonObject = { mapId };
  const region = path.find((candidate) => candidate.kind === "region");
  if (region) normalized.region = String(region.name);
  if (path.length > 1) normalized.location = String(path[1]?.name ?? entry.name);
  if (path.length > 2) normalized.sublocation = String(path.at(-1)?.name ?? entry.name);
  state.player.location = normalized;
}

export function updateNpcLocationsAfterPlayerMove(current: GameState, next: GameState): void {
  const fromMapId = text(objectOrEmpty(current.player.location).mapId);
  const toMapId = text(objectOrEmpty(next.player.location).mapId);
  if (!fromMapId || fromMapId === toMapId) return;
  const currentById = new Map(current.npcs.map((npc) => [text(npc.npcId), npc]));
  for (const npc of next.npcs) {
    const before = currentById.get(text(npc.npcId));
    if (!before) continue;
    const oldLocation = objectOrEmpty(before.location);
    const newLocation = objectOrEmpty(npc.location);
    if (oldLocation.status === "current" && oldLocation.mapId === fromMapId && same(oldLocation, newLocation)) {
      newLocation.status = "last_known";
      npc.location = newLocation;
    }
  }
}

export function assertNpcMemoryGrowth(current: GameState, next: GameState, maximumNewPerNpc = 5): void {
  const currentById = new Map(current.npcs.map((npc) => [text(npc.npcId), npc]));
  for (const npc of next.npcs) {
    const before = currentById.get(text(npc.npcId));
    const oldIds = new Set(arrayObjects(before?.memories).map((memory) => text(memory.memoryId)));
    const additions = arrayObjects(npc.memories).filter((memory) => !oldIds.has(text(memory.memoryId))).length;
    if (additions > maximumNewPerNpc) {
      throw new AegisError("INVALID_DIFF", `人物 ${text(npc.npcId)} 單回合最多新增 ${maximumNewPerNpc} 項互動記憶。`);
    }
  }
}

export function assertKnowledgeProgression(current: GameState, next: GameState): void {
  const stages = ["rumor", "observed", "identified", "verified", "researched"];
  const confidence = ["low", "medium", "high", "confirmed"];
  const currentEntries = new Map(current.compendium.map((entry) => [text(entry.entryId), entry]));
  for (const entry of next.compendium) {
    const before = currentEntries.get(text(entry.entryId));
    if (!before) continue;
    if (stages.indexOf(text(entry.stage)) < stages.indexOf(text(before.stage))) {
      throw new AegisError("INVALID_DIFF", `圖鑑 ${text(entry.entryId)} 的知識階段不得倒退。`);
    }
    const oldFacts = new Map(arrayObjects(before.facts).map((fact) => [text(fact.factId), fact]));
    for (const fact of arrayObjects(entry.facts)) {
      const old = oldFacts.get(text(fact.factId));
      if (old && confidence.indexOf(text(fact.confidence)) < confidence.indexOf(text(old.confidence))) {
        throw new AegisError("INVALID_DIFF", `知識 ${text(fact.factId)} 的可信程度不得倒退。`);
      }
    }
  }
}

export function finalizeKnowledgeMetadata(current: GameState, next: GameState): void {
  const revision = next.revision;
  const gameTime = snapshotObject(clockSnapshot(next));
  const currentMaps = Array.isArray(current.map) ? current.map : [];
  const currentNpcs = Array.isArray(current.npcs) ? current.npcs : [];
  const currentCompendium = Array.isArray(current.compendium) ? current.compendium : [];
  finalizeCollection(currentMaps, next.map, "mapId", MAP_META, revision, gameTime);
  const oldMaps = new Map(currentMaps.map((entry) => [text(entry.mapId), entry]));
  for (const map of next.map) {
    const oldMap = oldMaps.get(text(map.mapId));
    finalizeNested(oldMap?.routes, map.routes, "routeId", ROUTE_META, revision, gameTime, "verified", "knowledgeStatus");
  }
  const oldNpcs = new Map(currentNpcs.map((npc) => [text(npc.npcId), npc]));
  for (const npc of next.npcs) {
    const oldNpc = oldNpcs.get(text(npc.npcId));
    finalizeLearned(oldNpc?.knownInformation, npc.knownInformation, "infoId", INFO_META, revision, gameTime);
    finalizeLearned(oldNpc?.memories, npc.memories, "memoryId", MEMORY_META, revision, gameTime);
    const location = objectOrEmpty(npc.location);
    if (Object.keys(location).length) {
      const oldLocation = objectOrEmpty(oldNpc?.location);
      if (!oldNpc || !sameWithoutMetadata(oldLocation, location)) {
        location.observedAtRevision = revision;
        location.observedAtGameTime = structuredClone(gameTime);
      } else {
        copyMetadata(oldLocation, location, LOCATION_META);
      }
      npc.location = location;
    }
  }
  finalizeCollection(currentCompendium, next.compendium, "entryId", MAP_META, revision, gameTime);
  const oldEntries = new Map(currentCompendium.map((entry) => [text(entry.entryId), entry]));
  for (const entry of next.compendium) {
    const oldEntry = oldEntries.get(text(entry.entryId));
    finalizeNested(oldEntry?.facts, entry.facts, "factId", FACT_META, revision, gameTime);
  }
}

function normalizeMap(
  state: GameState,
  strict: boolean,
  code: "INVALID_DIFF" | "INVALID_STATE" = strict ? "INVALID_DIFF" : "INVALID_STATE",
): JsonObject[] {
  const facilityIds = new Set<string>();
  const dangerIds = new Set<string>();
  const result = state.map.map((raw, index) => {
    const path = `map[${index}]`;
    if (strict) assertOnlyKeys(raw, MAP_KEYS, path, code);
    const mapId = text(raw.mapId) || (!strict ? text(raw.id) || stableId("map", state.gameId, index, raw) : "");
    const name = text(raw.name) || (!strict ? text(raw.title) || text(raw.location) : "");
    requireText(mapId, `${path}.mapId`, code);
    requireText(name, `${path}.name`, code);
    const item: JsonObject = {
      mapId,
      name,
      kind: enumValue(raw.kind, MAP_KINDS, !strict ? legacyMapKind(raw) : "", `${path}.kind`, code),
      discovery: enumValue(raw.discovery, DISCOVERY_STAGES, !strict ? legacyDiscovery(raw) : "", `${path}.discovery`, code),
    };
    optionalText(item, raw, "parentMapId", !strict ? raw.parentId : undefined, `${path}.parentMapId`, code);
    optionalText(item, raw, "description", !strict ? raw.note ?? raw.notes : undefined, `${path}.description`, code);
    const routes = normalizeRoutes(raw.routes, state.gameId, mapId, strict, path, code);
    if (routes.length) item.routes = routes;
    const facilities = normalizeFacilities(raw.facilities, state.gameId, mapId, strict, path, code);
    for (const facility of facilities) uniqueGlobal(facilityIds, text(facility.facilityId), "facilityId", code);
    if (facilities.length) item.facilities = facilities;
    const dangers = normalizeDangers(raw.knownDangers ?? (!strict ? raw.dangers : undefined), state.gameId, mapId, strict, path, code);
    for (const danger of dangers) uniqueGlobal(dangerIds, text(danger.dangerId), "dangerId", code);
    if (dangers.length) item.knownDangers = dangers;
    const refs = normalizeReferences(raw.references, strict, path, code);
    if (Object.keys(refs).length) item.references = refs;
    copyMetadata(raw, item, MAP_META);
    return item;
  });
  assertUnique(result, "mapId", "map", code);
  validateHierarchy(result, code);
  return result;
}

function normalizeRoutes(
  raw: JsonValue | undefined,
  gameId: string,
  mapId: string,
  strict: boolean,
  parentPath: string,
  code: "INVALID_DIFF" | "INVALID_STATE",
): JsonObject[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw issue(code, `${parentPath}.routes 必須是陣列。`);
  const result = raw.map((value, index) => {
    const path = `${parentPath}.routes[${index}]`;
    const route = object(value, path, code);
    if (strict) assertOnlyKeys(route, ROUTE_KEYS, path, code);
    const routeId = text(route.routeId) || (!strict ? text(route.id) || stableId("route", `${gameId}:${mapId}`, index, route) : "");
    const toMapId = text(route.toMapId) || (!strict ? text(route.destinationMapId) : "");
    requireText(routeId, `${path}.routeId`, code);
    requireText(toMapId, `${path}.toMapId`, code);
    const item: JsonObject = { routeId, toMapId };
    const estimated = route.estimatedMinutes ?? legacyEstimatedMinutes(route.estimatedTravel ?? route.travelTime);
    optionalNonnegativeInteger(item, "estimatedMinutes", estimated, `${path}.estimatedMinutes`, code, 60 * 24 * 365);
    optionalEnum(item, route, "travelMode", ROUTE_MODES, path, code);
    optionalEnum(item, route, "estimateConfidence", ESTIMATE_CONFIDENCE, path, code);
    optionalEnum(item, route, "danger", DANGER_LEVELS, path, code);
    copyStringArray(item, route, "conditions", `${path}.conditions`, code);
    copyStringArray(item, route, "requirements", `${path}.requirements`, code);
    optionalText(item, route, "notes", undefined, `${path}.notes`, code);
    optionalEnum(item, route, "knowledgeStatus", ROUTE_KNOWLEDGE, path, code);
    optionalText(item, route, "sourceType", undefined, `${path}.sourceType`, code);
    optionalText(item, route, "sourceId", undefined, `${path}.sourceId`, code);
    copyMetadata(route, item, ROUTE_META);
    return item;
  });
  assertUnique(result, "routeId", `${parentPath}.routes`, code);
  return result;
}

function normalizeFacilities(
  raw: JsonValue | undefined,
  gameId: string,
  mapId: string,
  strict: boolean,
  parentPath: string,
  code: "INVALID_DIFF" | "INVALID_STATE",
): JsonObject[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw issue(code, `${parentPath}.facilities 必須是陣列。`);
  return raw.map((value, index) => {
    const path = `${parentPath}.facilities[${index}]`;
    const facility = typeof value === "string" ? { name: value } : object(value, path, code);
    if (strict) assertOnlyKeys(facility, FACILITY_KEYS, path, code);
    const facilityId = text(facility.facilityId) || stableId("facility", `${gameId}:${mapId}`, index, facility);
    const name = text(facility.name);
    requireText(facilityId, `${path}.facilityId`, code);
    requireText(name, `${path}.name`, code);
    const item: JsonObject = { facilityId, name };
    for (const key of ["type", "availability"] as const) optionalText(item, facility, key, undefined, `${path}.${key}`, code);
    return item;
  });
}

function normalizeDangers(
  raw: JsonValue | undefined,
  gameId: string,
  mapId: string,
  strict: boolean,
  parentPath: string,
  code: "INVALID_DIFF" | "INVALID_STATE",
): JsonObject[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw issue(code, `${parentPath}.knownDangers 必須是陣列。`);
  return raw.map((value, index) => {
    const path = `${parentPath}.knownDangers[${index}]`;
    const danger = typeof value === "string" ? { name: value } : object(value, path, code);
    if (strict) assertOnlyKeys(danger, DANGER_KEYS, path, code);
    const dangerId = text(danger.dangerId) || stableId("danger", `${gameId}:${mapId}`, index, danger);
    const name = text(danger.name);
    requireText(dangerId, `${path}.dangerId`, code);
    requireText(name, `${path}.name`, code);
    const item: JsonObject = { dangerId, name };
    optionalEnum(item, danger, "severity", DANGER_LEVELS, path, code);
    optionalText(item, danger, "description", undefined, `${path}.description`, code);
    if (danger.confirmed !== undefined) {
      if (typeof danger.confirmed !== "boolean") throw issue(code, `${path}.confirmed 必須是布林值。`);
      item.confirmed = danger.confirmed;
    }
    optionalText(item, danger, "sourceType", undefined, `${path}.sourceType`, code);
    optionalText(item, danger, "sourceId", undefined, `${path}.sourceId`, code);
    return item;
  });
}

function normalizeReferences(
  raw: JsonValue | undefined,
  strict: boolean,
  parentPath: string,
  code: "INVALID_DIFF" | "INVALID_STATE",
): JsonObject {
  if (raw === undefined) return {};
  const refs = object(raw, `${parentPath}.references`, code);
  if (strict) assertOnlyKeys(refs, REFERENCE_KEYS, `${parentPath}.references`, code);
  const result: JsonObject = {};
  for (const key of ["npcIds", "questIds", "compendiumIds"] as const) {
    copyStringArray(result, refs, key, `${parentPath}.references.${key}`, code);
  }
  return result;
}

function normalizeNpcs(
  state: GameState,
  strict: boolean,
  code: "INVALID_DIFF" | "INVALID_STATE" = strict ? "INVALID_DIFF" : "INVALID_STATE",
): JsonObject[] {
  const result = state.npcs.map((raw, index) => {
    const path = `npcs[${index}]`;
    if (strict) {
      assertNoSecrets(raw, path, code);
      assertOnlyKeys(raw, NPC_KEYS, path, code);
    }
    const npcId = text(raw.npcId) || (!strict ? text(raw.id) || stableId("npc", state.gameId, index, raw) : "");
    const name = text(raw.name) || (!strict ? text(raw.title) : "");
    requireText(npcId, `${path}.npcId`, code);
    requireText(name, `${path}.name`, code);
    const item: JsonObject = {
      npcId,
      name,
      familiarity: enumValue(raw.familiarity, FAMILIARITY_STAGES, !strict ? legacyFamiliarity(raw) : "", `${path}.familiarity`, code),
    };
    optionalText(item, raw, "identity", !strict ? raw.role ?? raw.profession : undefined, `${path}.identity`, code);
    const relationship = normalizeRelationship(raw.relationship ?? (!strict ? raw.affinity : undefined), strict, path, code);
    if (relationship) item.relationship = relationship;
    const location = normalizeNpcLocation(raw.location, strict, path, code);
    if (Object.keys(location).length) item.location = location;
    const info = normalizeKnownInformation(raw.knownInformation, state.gameId, npcId, strict, path, code);
    if (info.length) item.knownInformation = info;
    const services = normalizeServices(raw.services, state.gameId, npcId, strict, path, code);
    if (services.length) item.services = services;
    const memories = normalizeMemories(raw.memories, state.gameId, npcId, strict, path, code);
    if (memories.length) item.memories = memories;
    copyStringArray(item, raw, "questIds", `${path}.questIds`, code);
    return item;
  });
  assertUnique(result, "npcId", "npcs", code);
  return result;
}

function normalizeRelationship(
  raw: JsonValue | undefined,
  strict: boolean,
  parentPath: string,
  code: "INVALID_DIFF" | "INVALID_STATE",
): JsonObject | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "string" || typeof raw === "number") {
    return { label: typeof raw === "number" ? `既有關係紀錄 ${raw}` : raw.trim() };
  }
  const relationship = object(raw, `${parentPath}.relationship`, code);
  if (strict) assertOnlyKeys(relationship, RELATIONSHIP_KEYS, `${parentPath}.relationship`, code);
  const label = text(relationship.label);
  requireText(label, `${parentPath}.relationship.label`, code);
  const result: JsonObject = { label };
  copyStringArray(result, relationship, "tags", `${parentPath}.relationship.tags`, code);
  return result;
}

function normalizeNpcLocation(
  raw: JsonValue | undefined,
  strict: boolean,
  parentPath: string,
  code: "INVALID_DIFF" | "INVALID_STATE",
): JsonObject {
  if (raw === undefined) return {};
  if (typeof raw === "string" && !strict) return { name: raw.trim(), status: "last_known" };
  const location = object(raw, `${parentPath}.location`, code);
  if (strict) assertOnlyKeys(location, NPC_LOCATION_KEYS, `${parentPath}.location`, code);
  const result: JsonObject = {};
  optionalText(result, location, "mapId", undefined, `${parentPath}.location.mapId`, code);
  optionalText(result, location, "name", undefined, `${parentPath}.location.name`, code);
  const status = location.status ?? (!strict ? "last_known" : undefined);
  if (status === undefined) throw issue(code, `${parentPath}.location.status 必須存在。`);
  result.status = enumValue(status, LOCATION_STATUSES, "", `${parentPath}.location.status`, code);
  if (result.status === "unknown" && (result.mapId !== undefined || result.name !== undefined)) {
    if (strict) throw issue(code, `${parentPath}.location.status 為 unknown 時不得保留 mapId 或 name。`);
    delete result.mapId;
    delete result.name;
  }
  copyMetadata(location, result, LOCATION_META);
  return result;
}

function normalizeKnownInformation(
  raw: JsonValue | undefined,
  gameId: string,
  npcId: string,
  strict: boolean,
  parentPath: string,
  code: "INVALID_DIFF" | "INVALID_STATE",
): JsonObject[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw issue(code, `${parentPath}.knownInformation 必須是陣列。`);
  const result = raw.map((value, index) => {
    const path = `${parentPath}.knownInformation[${index}]`;
    const info = typeof value === "string" ? { content: value } : object(value, path, code);
    if (strict) assertOnlyKeys(info, INFORMATION_KEYS, path, code);
    const infoId = text(info.infoId) || text(info.id) || stableId("info", `${gameId}:${npcId}`, index, info);
    const content = text(info.content) || text(info.text) || (!strict ? text(info.description) : "");
    requireText(infoId, `${path}.infoId`, code);
    requireText(content, `${path}.content`, code);
    const item: JsonObject = { infoId, content: content.slice(0, 500) };
    const legacySource = objectOrEmpty(info.source);
    optionalText(item, info, "sourceType", legacySource.type, `${path}.sourceType`, code);
    optionalText(item, info, "sourceId", legacySource.sourceId ?? legacySource.npcId ?? legacySource.mapId, `${path}.sourceId`, code);
    optionalEnum(item, info, "confidence", CONFIDENCE_LEVELS, path, code);
    copyMetadata(info, item, INFO_META);
    return item;
  });
  assertUnique(result, "infoId", `${parentPath}.knownInformation`, code);
  return result;
}

function normalizeServices(
  raw: JsonValue | undefined,
  gameId: string,
  npcId: string,
  strict: boolean,
  parentPath: string,
  code: "INVALID_DIFF" | "INVALID_STATE",
): JsonObject[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw issue(code, `${parentPath}.services 必須是陣列。`);
  const result = raw.map((value, index) => {
    const path = `${parentPath}.services[${index}]`;
    const service = typeof value === "string" ? { name: value } : object(value, path, code);
    if (strict) assertOnlyKeys(service, SERVICE_KEYS, path, code);
    const serviceId = text(service.serviceId) || stableId("service", `${gameId}:${npcId}`, index, service);
    const name = text(service.name);
    requireText(serviceId, `${path}.serviceId`, code);
    requireText(name, `${path}.name`, code);
    const item: JsonObject = { serviceId, name };
    for (const key of ["type", "conditions", "availability"] as const) optionalText(item, service, key, undefined, `${path}.${key}`, code);
    return item;
  });
  assertUnique(result, "serviceId", `${parentPath}.services`, code);
  return result;
}

function normalizeMemories(
  raw: JsonValue | undefined,
  gameId: string,
  npcId: string,
  strict: boolean,
  parentPath: string,
  code: "INVALID_DIFF" | "INVALID_STATE",
): JsonObject[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw issue(code, `${parentPath}.memories 必須是陣列。`);
  const result = raw.map((value, index) => {
    const path = `${parentPath}.memories[${index}]`;
    const memory = object(value, path, code);
    if (strict) {
      assertNoSecrets(memory, path, code);
      assertOnlyKeys(memory, MEMORY_KEYS, path, code);
    }
    const memoryId = text(memory.memoryId) || text(memory.id) || stableId("memory", `${gameId}:${npcId}`, index, memory);
    const summary = text(memory.summary) || text(memory.text);
    requireText(memoryId, `${path}.memoryId`, code);
    requireText(summary, `${path}.summary`, code);
    if (summary.length > 300) throw issue(code, `${path}.summary 不得超過 300 個字元。`);
    const item: JsonObject = {
      memoryId,
      summary,
      importance: enumValue(memory.importance, MEMORY_IMPORTANCE, "important", `${path}.importance`, code),
    };
    copyMetadata(memory, item, MEMORY_META);
    return item;
  });
  assertUnique(result, "memoryId", `${parentPath}.memories`, code);
  return result;
}

function normalizeCompendium(
  state: GameState,
  strict: boolean,
  code: "INVALID_DIFF" | "INVALID_STATE" = strict ? "INVALID_DIFF" : "INVALID_STATE",
): JsonObject[] {
  const result = state.compendium.map((raw, index) => {
    const path = `compendium[${index}]`;
    if (strict) assertOnlyKeys(raw, COMPENDIUM_KEYS, path, code);
    const entryId = text(raw.entryId) || (!strict ? text(raw.id) || stableId("entry", state.gameId, index, raw) : "");
    const name = text(raw.name) || (!strict ? text(raw.title) : "");
    const category = text(raw.category) || (!strict ? text(raw.type) || "other" : "");
    const categoryLabel = text(raw.categoryLabel) || CATEGORY_LABELS[category] || (!strict ? category : "");
    requireText(entryId, `${path}.entryId`, code);
    requireText(name, `${path}.name`, code);
    requireText(category, `${path}.category`, code);
    requireText(categoryLabel, `${path}.categoryLabel`, code);
    if (["person", "npc", "character"].includes(category.toLowerCase())) {
      throw issue(code, `${path}.category 不得把人物個體存入圖鑑；請使用 game.npcs。`);
    }
    const item: JsonObject = {
      entryId,
      name,
      category,
      categoryLabel,
      stage: enumValue(raw.stage, KNOWLEDGE_STAGES, !strict ? legacyKnowledgeStage(raw) : "", `${path}.stage`, code),
    };
    optionalText(item, raw, "summary", raw.description ?? (!strict ? raw.note ?? raw.info : undefined), `${path}.summary`, code);
    item.facts = normalizeFacts(raw, state.gameId, entryId, strict, path, code);
    for (const key of ["relatedMapIds", "relatedNpcIds", "questIds", "tags"] as const) {
      copyStringArray(item, raw, key, `${path}.${key}`, code);
    }
    copyMetadata(raw, item, MAP_META);
    return item;
  });
  assertUnique(result, "entryId", "compendium", code);
  return result;
}

function normalizeFacts(
  entry: JsonObject,
  gameId: string,
  entryId: string,
  strict: boolean,
  parentPath: string,
  code: "INVALID_DIFF" | "INVALID_STATE",
): JsonObject[] {
  let rawFacts = entry.facts;
  if (rawFacts === undefined && Array.isArray(entry.knownFacts)) {
    rawFacts = entry.knownFacts.map((fact) => {
      const migrated: JsonObject = { text: fact };
      if (entry.sources !== undefined) migrated.sources = entry.sources;
      if (entry.confidence !== undefined) migrated.confidence = entry.confidence;
      return migrated;
    });
  }
  if (rawFacts === undefined) return [];
  if (!Array.isArray(rawFacts)) throw issue(code, `${parentPath}.facts 必須是陣列。`);
  const result = rawFacts.map((value, index) => {
    const path = `${parentPath}.facts[${index}]`;
    const fact = typeof value === "string" ? { text: value } : object(value, path, code);
    if (strict) assertOnlyKeys(fact, FACT_KEYS, path, code);
    const factId = text(fact.factId) || stableId("fact", `${gameId}:${entryId}`, index, fact);
    const content = text(fact.text);
    requireText(factId, `${path}.factId`, code);
    requireText(content, `${path}.text`, code);
    const sources = normalizeSources(fact.sources ?? entry.sources, strict, path, code);
    if (sources.length === 0) {
      if (strict) throw issue(code, `${path}.sources 必須至少包含一項知識來源。`);
      sources.push({ sourceType: "other", description: "既有紀錄（來源未記錄）" });
    }
    const item: JsonObject = {
      factId,
      text: content.slice(0, 500),
      sources,
      confidence: enumValue(fact.confidence, CONFIDENCE_LEVELS, text(entry.confidence) || legacyConfidence(text(entry.stage)), `${path}.confidence`, code),
    };
    copyMetadata(fact, item, FACT_META);
    return item;
  });
  assertUnique(result, "factId", `${parentPath}.facts`, code);
  return result;
}

function normalizeSources(
  raw: JsonValue | undefined,
  strict: boolean,
  parentPath: string,
  code: "INVALID_DIFF" | "INVALID_STATE",
): JsonObject[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw issue(code, `${parentPath}.sources 必須是陣列。`);
  return raw.map((value, index) => {
    const path = `${parentPath}.sources[${index}]`;
    if (typeof value === "string") return { sourceType: "other", description: value.trim() };
    const source = object(value, path, code);
    if (strict) assertOnlyKeys(source, SOURCE_KEYS, path, code);
    const sourceType = text(source.sourceType) || legacySourceType(source.type);
    if (!SOURCE_TYPES.has(sourceType)) throw issue(code, `${path}.sourceType 不是允許的來源類型。`);
    const item: JsonObject = { sourceType };
    optionalText(item, source, "sourceId", source.npcId ?? source.mapId ?? source.eventId, `${path}.sourceId`, code);
    optionalText(item, source, "description", source.name ?? source.sourceName, `${path}.description`, code);
    return item;
  });
}

function validateKnowledgeReferences(state: GameState, code: "INVALID_DIFF" | "INVALID_STATE"): void {
  const mapIds = new Set(state.map.map((item) => text(item.mapId)));
  const npcIds = new Set(state.npcs.map((item) => text(item.npcId)));
  const entryIds = new Set(state.compendium.map((item) => text(item.entryId)));
  for (const map of state.map) {
    const mapId = text(map.mapId);
    if (typeof map.parentMapId === "string" && !mapIds.has(map.parentMapId)) {
      throw issue(code, `地點 ${mapId} 的 parentMapId 尚未存在於玩家已知地圖。`);
    }
    for (const route of arrayObjects(map.routes)) {
      if (!mapIds.has(text(route.toMapId))) throw issue(code, `地點 ${mapId} 的路線指向尚未得知的 mapId：${text(route.toMapId)}。`);
      validateTypedSource(route, mapIds, npcIds, new Set(), `路線 ${text(route.routeId)}`, code);
    }
    for (const danger of arrayObjects(map.knownDangers)) validateTypedSource(danger, mapIds, npcIds, new Set(), `危險 ${text(danger.dangerId)}`, code);
    const refs = objectOrEmpty(map.references);
    assertReferences(refs.npcIds, npcIds, `地點 ${mapId} 的 npcIds`, code);
    assertReferences(refs.compendiumIds, entryIds, `地點 ${mapId} 的 compendiumIds`, code);
  }
  for (const npc of state.npcs) {
    const location = objectOrEmpty(npc.location);
    if (typeof location.mapId === "string" && !mapIds.has(location.mapId)) {
      throw issue(code, `人物 ${text(npc.npcId)} 的位置尚未存在於玩家已知地圖。`);
    }
    for (const info of arrayObjects(npc.knownInformation)) validateTypedSource(info, mapIds, npcIds, new Set(), `人物情報 ${text(info.infoId)}`, code);
  }
  for (const entry of state.compendium) {
    assertReferences(entry.relatedMapIds, mapIds, `圖鑑 ${text(entry.entryId)} 的 relatedMapIds`, code);
    assertReferences(entry.relatedNpcIds, npcIds, `圖鑑 ${text(entry.entryId)} 的 relatedNpcIds`, code);
    for (const fact of arrayObjects(entry.facts)) {
      for (const source of arrayObjects(fact.sources)) validateTypedSource(source, mapIds, npcIds, new Set(state.quests.map((q) => text(q.questId))), `知識 ${text(fact.factId)}`, code);
    }
  }
  const playerLocation = objectOrEmpty(state.player.location);
  if (typeof playerLocation.mapId === "string" && !mapIds.has(playerLocation.mapId)) {
    throw issue(code, `玩家目前位置 mapId ${playerLocation.mapId} 尚未寫入已知地圖。`);
  }
}

function validateHierarchy(entries: JsonObject[], code: "INVALID_DIFF" | "INVALID_STATE"): void {
  const parents = new Map(entries.map((entry) => [text(entry.mapId), text(entry.parentMapId)]));
  for (const id of parents.keys()) {
    const visited = new Set<string>();
    let cursor = id;
    while (cursor) {
      if (visited.has(cursor)) throw issue(code, `地圖階層存在循環 parentMapId：${[...visited, cursor].join(" → ")}。`);
      visited.add(cursor);
      cursor = parents.get(cursor) ?? "";
    }
  }
}

function validateTypedSource(
  value: JsonObject,
  mapIds: Set<string>,
  npcIds: Set<string>,
  questIds: Set<string>,
  label: string,
  code: "INVALID_DIFF" | "INVALID_STATE",
): void {
  const sourceType = text(value.sourceType);
  const sourceId = text(value.sourceId);
  if (!sourceId) return;
  if ((sourceType === "npc") && !npcIds.has(sourceId)) throw issue(code, `${label} 引用了未知 NPC 來源 ${sourceId}。`);
  if ((sourceType === "map" || sourceType === "observation") && sourceId.startsWith("map-") && !mapIds.has(sourceId)) throw issue(code, `${label} 引用了未知地圖來源 ${sourceId}。`);
  if (sourceType === "quest" && !questIds.has(sourceId)) throw issue(code, `${label} 引用了未知任務來源 ${sourceId}。`);
}

function finalizeCollection(
  oldValues: JsonObject[],
  newValues: JsonObject[],
  idKey: string,
  keys: readonly string[],
  revision: number,
  gameTime: JsonObject,
): void {
  const oldById = new Map(oldValues.map((value) => [text(value[idKey]), value]));
  for (const value of newValues) {
    const old = oldById.get(text(value[idKey]));
    if (!old) {
      setFirstAndLast(value, keys, revision, gameTime);
    } else {
      if (old[keys[0] ?? "firstLearnedAtRevision"] === undefined) {
        value[keys[0] ?? "firstLearnedAtRevision"] = revision;
        value[keys[1] ?? "firstLearnedAtGameTime"] = structuredClone(gameTime);
      } else {
        copyFirst(old, value, keys);
      }
      if (sameWithoutMetadata(old, value)) copyLast(old, value, keys);
      else setLast(value, keys, revision, gameTime);
    }
  }
}

function finalizeNested(
  oldRaw: JsonValue | undefined,
  newRaw: JsonValue | undefined,
  idKey: string,
  keys: readonly string[],
  revision: number,
  gameTime: JsonObject,
  verifiedValue?: string,
  verifiedKey?: string,
): void {
  const oldValues = arrayObjects(oldRaw);
  const newValues = arrayObjects(newRaw);
  const oldById = new Map(oldValues.map((value) => [text(value[idKey]), value]));
  for (const value of newValues) {
    const old = oldById.get(text(value[idKey]));
    if (!old) {
      value[keys[0] ?? "firstLearnedAtRevision"] = revision;
      value[keys[1] ?? "firstLearnedAtGameTime"] = structuredClone(gameTime);
      if (!verifiedValue || value[verifiedKey ?? "knowledgeStatus"] === verifiedValue) {
        value[keys[2] ?? "lastUpdatedAtRevision"] = revision;
        value[keys[3] ?? "lastUpdatedAtGameTime"] = structuredClone(gameTime);
      }
      continue;
    }
    if (old[keys[0] ?? "firstLearnedAtRevision"] === undefined) {
      value[keys[0] ?? "firstLearnedAtRevision"] = revision;
      value[keys[1] ?? "firstLearnedAtGameTime"] = structuredClone(gameTime);
    } else {
      copyMetadata(old, value, keys.slice(0, 2));
    }
    const becameVerified = verifiedValue && verifiedKey && value[verifiedKey] === verifiedValue && old[verifiedKey] !== verifiedValue;
    if (becameVerified || (!verifiedValue && !sameWithoutMetadata(old, value))) {
      value[keys[2] ?? "lastUpdatedAtRevision"] = revision;
      value[keys[3] ?? "lastUpdatedAtGameTime"] = structuredClone(gameTime);
    } else {
      copyMetadata(old, value, keys.slice(2));
    }
  }
}

function finalizeLearned(
  oldRaw: JsonValue | undefined,
  newRaw: JsonValue | undefined,
  idKey: string,
  keys: readonly string[],
  revision: number,
  gameTime: JsonObject,
): void {
  const oldById = new Map(arrayObjects(oldRaw).map((value) => [text(value[idKey]), value]));
  for (const value of arrayObjects(newRaw)) {
    const old = oldById.get(text(value[idKey]));
    if (old) copyMetadata(old, value, keys);
    else {
      value[keys[0] ?? "createdAtRevision"] = revision;
      value[keys[1] ?? "createdAtGameTime"] = structuredClone(gameTime);
    }
  }
}

function setFirstAndLast(value: JsonObject, keys: readonly string[], revision: number, gameTime: JsonObject): void {
  value[keys[0] ?? "firstLearnedAtRevision"] = revision;
  value[keys[1] ?? "firstLearnedAtGameTime"] = structuredClone(gameTime);
  value[keys[2] ?? "lastUpdatedAtRevision"] = revision;
  value[keys[3] ?? "lastUpdatedAtGameTime"] = structuredClone(gameTime);
}

function setLast(value: JsonObject, keys: readonly string[], revision: number, gameTime: JsonObject): void {
  value[keys[2] ?? "lastUpdatedAtRevision"] = revision;
  value[keys[3] ?? "lastUpdatedAtGameTime"] = structuredClone(gameTime);
}

function copyFirst(old: JsonObject, value: JsonObject, keys: readonly string[]): void {
  copyMetadata(old, value, keys.slice(0, 2));
}

function copyLast(old: JsonObject, value: JsonObject, keys: readonly string[]): void {
  copyMetadata(old, value, keys.slice(2));
}

function copyMetadata(source: JsonObject, target: JsonObject, keys: readonly string[]): void {
  for (const key of keys) if (source[key] !== undefined) target[key] = structuredClone(source[key]);
}

function sameWithoutMetadata(left: JsonObject, right: JsonObject): boolean {
  return same(stripMetadata(left), stripMetadata(right));
}

function stripMetadata(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(stripMetadata);
  if (!value || typeof value !== "object") return value;
  const result: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (/^(firstLearnedAt|lastUpdatedAt|lastVerifiedAt|learnedAt|createdAt|observedAt)(Revision|GameTime)$/u.test(key)) continue;
    result[key] = stripMetadata(child);
  }
  return result;
}

function locationPath(entry: JsonObject, index: Map<string, JsonObject>): JsonObject[] {
  const path: JsonObject[] = [];
  const seen = new Set<string>();
  let cursor: JsonObject | undefined = entry;
  while (cursor) {
    const id = text(cursor.mapId);
    if (seen.has(id)) break;
    seen.add(id);
    path.unshift(cursor);
    cursor = typeof cursor.parentMapId === "string" ? index.get(cursor.parentMapId) : undefined;
  }
  return path;
}

function resolveLegacyPlayerMapId(entries: JsonObject[], location: JsonObject): string {
  const candidates = [location.sublocation, location.location, location.region]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  for (const name of candidates) {
    const matches = entries.filter((entry) => text(entry.name) === name);
    if (matches.length === 1) return text(matches[0]?.mapId);
  }
  return "";
}

function legacyEstimatedMinutes(raw: JsonValue | undefined): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return Math.round(raw);
  if (typeof raw !== "string") return undefined;
  const textValue = raw.trim();
  const hours = Number(textValue.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:小時|hour)/iu)?.[1] ?? 0);
  const minutes = Number(textValue.match(/([0-9]+)\s*(?:分鐘|分|minute)/iu)?.[1] ?? 0);
  if (hours || minutes) return Math.round(hours * 60 + minutes);
  const numeric = Number(textValue.match(/[0-9]+/)?.[0] ?? Number.NaN);
  return Number.isFinite(numeric) ? Math.round(numeric) : undefined;
}

function legacyMapKind(raw: JsonObject): string {
  const value = text(raw.type) || text(raw.level);
  return MAP_KINDS.has(value) ? value : "place";
}

function legacyDiscovery(raw: JsonObject): string {
  if (raw.surveyed === true) return "surveyed";
  if (raw.visited === true) return "visited";
  if (raw.heard === true) return "heard";
  return "known";
}

function legacyFamiliarity(raw: JsonObject): string {
  if (raw.met === false || raw.heard === true) return "heard";
  if (raw.trusted === true) return "trusted";
  return "met";
}

function legacyKnowledgeStage(raw: JsonObject): string {
  if (raw.researched === true) return "researched";
  if (raw.verified === true) return "verified";
  if (raw.identified === true || raw.unlocked === true) return "identified";
  if (raw.observed === true) return "observed";
  return "rumor";
}

function legacyConfidence(stage: string): string {
  if (stage === "verified" || stage === "researched") return "confirmed";
  if (stage === "identified") return "high";
  if (stage === "observed") return "medium";
  return "low";
}

function legacySourceType(raw: JsonValue | undefined): string {
  const value = text(raw);
  if (SOURCE_TYPES.has(value)) return value;
  return { identification: "skill", research: "experiment", event: "other", recorded_source: "other", legacy_record: "other" }[value] ?? "other";
}

function stableId(prefix: string, scope: string, index: number, value: JsonObject): string {
  const hash = createHash("sha256").update(`${scope}:${prefix}:${index}:${JSON.stringify(value)}`).digest("hex").slice(0, 20);
  return `${prefix}-${hash}`;
}

function enumValue(
  raw: JsonValue | undefined,
  allowed: Set<string>,
  fallback: string,
  path: string,
  code: "INVALID_DIFF" | "INVALID_STATE",
): string {
  const value = text(raw) || fallback;
  if (!allowed.has(value)) throw issue(code, `${path} 不是允許的值。`);
  return value;
}

function optionalEnum(
  target: JsonObject,
  source: JsonObject,
  key: string,
  allowed: Set<string>,
  parentPath: string,
  code: "INVALID_DIFF" | "INVALID_STATE",
): void {
  if (source[key] !== undefined) target[key] = enumValue(source[key], allowed, "", `${parentPath}.${key}`, code);
}

function optionalText(
  target: JsonObject,
  source: JsonObject,
  key: string,
  fallback: JsonValue | undefined,
  path: string,
  code: "INVALID_DIFF" | "INVALID_STATE",
): void {
  const value = source[key] ?? fallback;
  if (value === undefined) return;
  const normalized = text(value);
  if (!normalized) throw issue(code, `${path} 必須是非空字串。`);
  target[key] = normalized;
}

function optionalNonnegativeInteger(
  target: JsonObject,
  key: string,
  value: JsonValue | undefined,
  path: string,
  code: "INVALID_DIFF" | "INVALID_STATE",
  max: number,
): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    throw issue(code, `${path} 必須是 0～${max} 的整數。`);
  }
  target[key] = value;
}

function copyStringArray(
  target: JsonObject,
  source: JsonObject,
  key: string,
  path: string,
  code: "INVALID_DIFF" | "INVALID_STATE",
): void {
  const value = source[key];
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw issue(code, `${path} 必須是非空字串陣列。`);
  }
  target[key] = [...new Set(value.map((item) => String(item).trim()))];
}

function assertOnlyKeys(value: JsonObject, allowed: Set<string>, path: string, code: "INVALID_DIFF" | "INVALID_STATE"): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw issue(code, `${path} 含有未允許欄位：${unknown.join("、")}。`);
}

function assertNoSecrets(value: JsonValue, path: string, code: "INVALID_DIFF" | "INVALID_STATE"): void {
  if (Array.isArray(value)) return value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`, code));
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEYS.has(key)) throw issue(code, `${path}.${key} 是玩家人物資料禁止保存的秘密或逐字稿欄位。`);
    assertNoSecrets(child, `${path}.${key}`, code);
  }
}

function assertUnique(items: JsonObject[], key: string, path: string, code: "INVALID_DIFF" | "INVALID_STATE"): void {
  const seen = new Set<string>();
  for (const item of items) {
    const id = text(item[key]);
    if (seen.has(id)) throw issue(code, `${path} 中存在重複 ${key}：${id}。`);
    seen.add(id);
  }
}

function uniqueGlobal(seen: Set<string>, id: string, label: string, code: "INVALID_DIFF" | "INVALID_STATE"): void {
  if (seen.has(id)) throw issue(code, `地圖中存在重複 ${label}：${id}。`);
  seen.add(id);
}

function assertReferences(raw: JsonValue | undefined, known: Set<string>, label: string, code: "INVALID_DIFF" | "INVALID_STATE"): void {
  if (!Array.isArray(raw)) return;
  for (const id of raw) if (typeof id === "string" && !known.has(id)) throw issue(code, `${label} 引用了未知識別碼 ${id}。`);
}

function requireText(value: string, path: string, code: "INVALID_DIFF" | "INVALID_STATE"): void {
  if (!value) throw issue(code, `${path} 必須是非空字串。`);
}

function object(value: JsonValue, path: string, code: "INVALID_DIFF" | "INVALID_STATE"): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw issue(code, `${path} 必須是物件。`);
  return value;
}

function objectOrEmpty(value: JsonValue | undefined): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? structuredClone(value) : {};
}

function arrayObjects(value: JsonValue | undefined): JsonObject[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is JsonObject => Boolean(item) && typeof item === "object" && !Array.isArray(item));
}

function text(value: JsonValue | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function set(values: string[]): Set<string> {
  return new Set(values);
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function issue(code: "INVALID_DIFF" | "INVALID_STATE", message: string): AegisError {
  return new AegisError(code, message);
}
