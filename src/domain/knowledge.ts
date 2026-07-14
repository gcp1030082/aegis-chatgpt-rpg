import { AegisError } from "./errors.js";
import type { GameState, JsonObject, JsonValue } from "./types.js";

const MAP_KINDS = new Set(["region", "town", "place", "subplace"]);
const DISCOVERY_STAGES = new Set(["heard", "known", "visited", "surveyed"]);
const ROUTE_DANGERS = new Set(["unknown", "low", "moderate", "high", "extreme"]);
const FAMILIARITY_STAGES = new Set(["heard", "met", "acquainted", "familiar", "trusted"]);
const LOCATION_STATUSES = new Set(["current", "last_known", "unknown"]);
const COMPENDIUM_CATEGORIES = new Set([
  "creature", "plant", "material", "magical_phenomenon", "faction", "culture", "other",
]);
const KNOWLEDGE_STAGES = new Set(["rumor", "observed", "identified", "verified", "researched"]);
const CONFIDENCE_LEVELS = new Set(["low", "medium", "high", "confirmed"]);

const MAP_KEYS = new Set([
  "mapId", "name", "kind", "parentMapId", "discovery", "description", "routes", "facilities", "references",
]);
const ROUTE_KEYS = new Set([
  "routeId", "toMapId", "estimatedTravel", "danger", "conditions", "requirements", "notes",
]);
const FACILITY_KEYS = new Set(["facilityId", "name", "type", "availability"]);
const REFERENCE_KEYS = new Set(["npcIds", "questIds", "compendiumIds"]);
const NPC_KEYS = new Set([
  "npcId", "name", "identity", "location", "relationship", "familiarity", "knownInformation", "services",
  "questIds", "memories",
]);
const NPC_LOCATION_KEYS = new Set(["mapId", "name", "status", "observedAtTick"]);
const INFORMATION_KEYS = new Set(["infoId", "text", "source", "confidence", "learnedAtTick"]);
const SERVICE_KEYS = new Set(["serviceId", "name", "type", "conditions"]);
const MEMORY_KEYS = new Set(["memoryId", "summary", "tick", "importance"]);
const COMPENDIUM_KEYS = new Set([
  "entryId", "name", "category", "stage", "description", "knownFacts", "sources", "confidence",
  "relatedMapIds", "relatedNpcIds", "questIds", "tags",
]);
const SOURCE_KEYS = new Set(["sourceId", "type", "name", "obtainedAtTick", "mapId", "npcId", "eventId"]);
const SECRET_KEYS = new Set([
  "secret", "secrets", "internalSecret", "internalSecrets", "privateNotes", "hiddenInfo", "hiddenInformation",
  "gmNotes", "agenda", "trueIdentity", "dialogueTranscript", "transcript", "dialogueHistory", "fullTranscript",
]);

export function normalizeKnowledgeState(state: GameState, strict: boolean): void {
  state.map = normalizeMap(state.map, strict);
  state.npcs = normalizeNpcs(state.npcs, strict);
  state.compendium = normalizeCompendium(state.compendium, strict);
  validateKnowledgeReferences(state, strict ? "INVALID_DIFF" : "INVALID_STATE");
}

export function validateKnowledgeState(state: GameState): void {
  normalizeMap(state.map, true, "INVALID_STATE");
  normalizeNpcs(state.npcs, true, "INVALID_STATE");
  normalizeCompendium(state.compendium, true, "INVALID_STATE");
  validateKnowledgeReferences(state, "INVALID_STATE");
}

export function playerKnowledgeView(state: GameState) {
  return {
    map: structuredClone(state.map),
    npcs: structuredClone(state.npcs),
    compendium: structuredClone(state.compendium),
  };
}

function normalizeMap(
  values: JsonObject[],
  strict: boolean,
  errorCode: "INVALID_DIFF" | "INVALID_STATE" = strict ? "INVALID_DIFF" : "INVALID_STATE",
): JsonObject[] {
  const result = values.map((raw, index) => {
    const path = `map[${index}]`;
    if (strict) assertOnlyKeys(raw, MAP_KEYS, path, errorCode);
    const mapId = text(raw.mapId) || (!strict ? text(raw.id) : "") || (!strict ? `legacy-map-${index + 1}` : "");
    const name = text(raw.name) || (!strict ? text(raw.title) || text(raw.location) : "");
    requireText(mapId, `${path}.mapId`, errorCode);
    requireText(name, `${path}.name`, errorCode);
    const kind = enumValue(raw.kind, MAP_KINDS, !strict ? legacyMapKind(raw) : "", `${path}.kind`, errorCode);
    const discovery = enumValue(
      raw.discovery,
      DISCOVERY_STAGES,
      !strict ? legacyDiscovery(raw) : "",
      `${path}.discovery`,
      errorCode,
    );
    const item: JsonObject = { mapId, name, kind, discovery };
    copyOptionalText(item, raw, "parentMapId", !strict ? raw.parentId : undefined, `${path}.parentMapId`, errorCode);
    copyOptionalText(item, raw, "description", !strict ? raw.note ?? raw.notes : undefined, `${path}.description`, errorCode);
    const routes = normalizeRoutes(raw.routes, mapId, strict, path, errorCode);
    if (routes.length) item.routes = routes;
    const facilities = normalizeFacilities(raw.facilities, strict, path, errorCode);
    if (facilities.length) item.facilities = facilities;
    const references = normalizeReferences(raw.references, strict, path, errorCode);
    if (Object.keys(references).length) item.references = references;
    return item;
  });
  assertUnique(result, "mapId", "map", errorCode);
  return result;
}

function normalizeRoutes(
  raw: JsonValue | undefined,
  mapId: string,
  strict: boolean,
  parentPath: string,
  errorCode: "INVALID_DIFF" | "INVALID_STATE",
): JsonObject[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw issue(errorCode, `${parentPath}.routes 必須是陣列。`);
  return raw.map((value, index) => {
    const path = `${parentPath}.routes[${index}]`;
    const route = object(value, path, errorCode);
    if (strict) assertOnlyKeys(route, ROUTE_KEYS, path, errorCode);
    const routeId = text(route.routeId) || (!strict ? text(route.id) : "") || (!strict ? `${mapId}-route-${index + 1}` : "");
    const toMapId = text(route.toMapId) || (!strict ? text(route.destinationMapId) : "");
    requireText(routeId, `${path}.routeId`, errorCode);
    requireText(toMapId, `${path}.toMapId`, errorCode);
    const result: JsonObject = { routeId, toMapId };
    if (route.estimatedTravel !== undefined) {
      if (!(typeof route.estimatedTravel === "string" || nonnegativeNumber(route.estimatedTravel))) {
        throw issue(errorCode, `${path}.estimatedTravel 必須是文字或非負數字。`);
      }
      result.estimatedTravel = route.estimatedTravel;
    } else if (!strict && route.travelTime !== undefined && (typeof route.travelTime === "string" || nonnegativeNumber(route.travelTime))) {
      result.estimatedTravel = route.travelTime;
    }
    if (route.danger !== undefined) {
      result.danger = enumValue(route.danger, ROUTE_DANGERS, "", `${path}.danger`, errorCode);
    }
    copyStringArray(result, route, "conditions", `${path}.conditions`, errorCode);
    copyStringArray(result, route, "requirements", `${path}.requirements`, errorCode);
    copyOptionalText(result, route, "notes", undefined, `${path}.notes`, errorCode);
    return result;
  });
}

function normalizeFacilities(
  raw: JsonValue | undefined,
  strict: boolean,
  parentPath: string,
  errorCode: "INVALID_DIFF" | "INVALID_STATE",
): JsonValue[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw issue(errorCode, `${parentPath}.facilities 必須是陣列。`);
  return raw.map((value, index) => {
    if (typeof value === "string" && value.trim()) return value.trim();
    const path = `${parentPath}.facilities[${index}]`;
    const facility = object(value, path, errorCode);
    if (strict) assertOnlyKeys(facility, FACILITY_KEYS, path, errorCode);
    const name = text(facility.name);
    requireText(name, `${path}.name`, errorCode);
    const result: JsonObject = { name };
    for (const key of ["facilityId", "type", "availability"] as const) {
      copyOptionalText(result, facility, key, undefined, `${path}.${key}`, errorCode);
    }
    return result;
  });
}

function normalizeReferences(
  raw: JsonValue | undefined,
  strict: boolean,
  parentPath: string,
  errorCode: "INVALID_DIFF" | "INVALID_STATE",
): JsonObject {
  if (raw === undefined) return {};
  const refs = object(raw, `${parentPath}.references`, errorCode);
  if (strict) assertOnlyKeys(refs, REFERENCE_KEYS, `${parentPath}.references`, errorCode);
  const result: JsonObject = {};
  for (const key of ["npcIds", "questIds", "compendiumIds"] as const) {
    copyStringArray(result, refs, key, `${parentPath}.references.${key}`, errorCode);
  }
  return result;
}

function normalizeNpcs(
  values: JsonObject[],
  strict: boolean,
  errorCode: "INVALID_DIFF" | "INVALID_STATE" = strict ? "INVALID_DIFF" : "INVALID_STATE",
): JsonObject[] {
  const result = values.map((raw, index) => {
    const path = `npcs[${index}]`;
    if (strict) {
      assertNoSecrets(raw, path, errorCode);
      assertOnlyKeys(raw, NPC_KEYS, path, errorCode);
    }
    const npcId = text(raw.npcId) || (!strict ? text(raw.id) : "") || (!strict ? `legacy-npc-${index + 1}` : "");
    const name = text(raw.name) || (!strict ? text(raw.title) : "");
    requireText(npcId, `${path}.npcId`, errorCode);
    requireText(name, `${path}.name`, errorCode);
    const familiarity = enumValue(
      raw.familiarity,
      FAMILIARITY_STAGES,
      !strict ? legacyFamiliarity(raw) : "",
      `${path}.familiarity`,
      errorCode,
    );
    const item: JsonObject = { npcId, name, familiarity };
    copyOptionalText(item, raw, "identity", !strict ? raw.role ?? raw.profession : undefined, `${path}.identity`, errorCode);
    if (raw.relationship !== undefined) {
      if (!(typeof raw.relationship === "string" || nonnegativeNumber(raw.relationship))) {
        throw issue(errorCode, `${path}.relationship 必須是文字或非負數字。`);
      }
      item.relationship = raw.relationship;
    } else if (!strict && raw.affinity !== undefined && (typeof raw.affinity === "string" || nonnegativeNumber(raw.affinity))) {
      item.relationship = raw.affinity;
    }
    const location = normalizeNpcLocation(raw.location, strict, path, errorCode);
    if (Object.keys(location).length) item.location = location;
    const information = normalizeKnownInformation(raw.knownInformation, strict, path, errorCode);
    if (information.length) item.knownInformation = information;
    const services = normalizeServices(raw.services, strict, path, errorCode);
    if (services.length) item.services = services;
    copyStringArray(item, raw, "questIds", `${path}.questIds`, errorCode);
    const memories = normalizeMemories(raw.memories, strict, path, errorCode);
    if (memories.length) item.memories = memories;
    return item;
  });
  assertUnique(result, "npcId", "npcs", errorCode);
  return result;
}

function normalizeNpcLocation(
  raw: JsonValue | undefined,
  strict: boolean,
  parentPath: string,
  errorCode: "INVALID_DIFF" | "INVALID_STATE",
): JsonObject {
  if (raw === undefined) return {};
  if (typeof raw === "string") {
    return strict
      ? (() => { throw issue(errorCode, `${parentPath}.location 必須是物件。`); })()
      : { name: raw, status: "last_known" };
  }
  const location = object(raw, `${parentPath}.location`, errorCode);
  if (strict) assertOnlyKeys(location, NPC_LOCATION_KEYS, `${parentPath}.location`, errorCode);
  const result: JsonObject = {};
  copyOptionalText(result, location, "mapId", undefined, `${parentPath}.location.mapId`, errorCode);
  copyOptionalText(result, location, "name", undefined, `${parentPath}.location.name`, errorCode);
  if (location.status !== undefined) {
    result.status = enumValue(location.status, LOCATION_STATUSES, "", `${parentPath}.location.status`, errorCode);
  } else if (Object.keys(result).length) {
    result.status = strict ? "unknown" : "last_known";
  }
  copyOptionalInteger(result, location, "observedAtTick", `${parentPath}.location.observedAtTick`, errorCode);
  return result;
}

function normalizeKnownInformation(
  raw: JsonValue | undefined,
  strict: boolean,
  parentPath: string,
  errorCode: "INVALID_DIFF" | "INVALID_STATE",
): JsonObject[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw issue(errorCode, `${parentPath}.knownInformation 必須是陣列。`);
  return raw.map((value, index) => {
    const path = `${parentPath}.knownInformation[${index}]`;
    if (typeof value === "string" && !strict) {
      return { infoId: `known-info-${index + 1}`, text: value, confidence: "medium" };
    }
    const info = object(value, path, errorCode);
    if (strict) assertOnlyKeys(info, INFORMATION_KEYS, path, errorCode);
    const infoId = text(info.infoId) || (!strict ? text(info.id) : "") || (!strict ? `known-info-${index + 1}` : "");
    const content = text(info.text) || (!strict ? text(info.description) : "");
    requireText(infoId, `${path}.infoId`, errorCode);
    requireText(content, `${path}.text`, errorCode);
    const result: JsonObject = { infoId, text: content };
    if (info.source !== undefined) result.source = normalizeSourceValue(info.source, strict, `${path}.source`, errorCode);
    if (info.confidence !== undefined) {
      result.confidence = enumValue(info.confidence, CONFIDENCE_LEVELS, "", `${path}.confidence`, errorCode);
    }
    copyOptionalInteger(result, info, "learnedAtTick", `${path}.learnedAtTick`, errorCode);
    return result;
  });
}

function normalizeServices(
  raw: JsonValue | undefined,
  strict: boolean,
  parentPath: string,
  errorCode: "INVALID_DIFF" | "INVALID_STATE",
): JsonValue[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw issue(errorCode, `${parentPath}.services 必須是陣列。`);
  return raw.map((value, index) => {
    if (typeof value === "string" && value.trim()) return value.trim();
    const path = `${parentPath}.services[${index}]`;
    const service = object(value, path, errorCode);
    if (strict) assertOnlyKeys(service, SERVICE_KEYS, path, errorCode);
    const name = text(service.name);
    requireText(name, `${path}.name`, errorCode);
    const result: JsonObject = { name };
    for (const key of ["serviceId", "type", "conditions"] as const) {
      copyOptionalText(result, service, key, undefined, `${path}.${key}`, errorCode);
    }
    return result;
  });
}

function normalizeMemories(
  raw: JsonValue | undefined,
  strict: boolean,
  parentPath: string,
  errorCode: "INVALID_DIFF" | "INVALID_STATE",
): JsonObject[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw issue(errorCode, `${parentPath}.memories 必須是陣列。`);
  return raw.map((value, index) => {
    const path = `${parentPath}.memories[${index}]`;
    const memory = object(value, path, errorCode);
    if (strict) assertOnlyKeys(memory, MEMORY_KEYS, path, errorCode);
    const memoryId = text(memory.memoryId) || (!strict ? text(memory.id) : "") || (!strict ? `memory-${index + 1}` : "");
    const summary = text(memory.summary) || (!strict ? text(memory.text) : "");
    requireText(memoryId, `${path}.memoryId`, errorCode);
    requireText(summary, `${path}.summary`, errorCode);
    const result: JsonObject = { memoryId, summary };
    copyOptionalInteger(result, memory, "tick", `${path}.tick`, errorCode);
    if (memory.importance !== undefined) {
      const importance = text(memory.importance);
      if (!new Set(["important", "major"]).has(importance)) {
        throw issue(errorCode, `${path}.importance 必須是 important 或 major。`);
      }
      result.importance = importance;
    } else {
      result.importance = "important";
    }
    return result;
  });
}

function normalizeCompendium(
  values: JsonObject[],
  strict: boolean,
  errorCode: "INVALID_DIFF" | "INVALID_STATE" = strict ? "INVALID_DIFF" : "INVALID_STATE",
): JsonObject[] {
  const result = values.map((raw, index) => {
    const path = `compendium[${index}]`;
    if (strict) assertOnlyKeys(raw, COMPENDIUM_KEYS, path, errorCode);
    const entryId = text(raw.entryId) || (!strict ? text(raw.id) : "") || (!strict ? `legacy-entry-${index + 1}` : "");
    const name = text(raw.name) || (!strict ? text(raw.title) : "");
    requireText(entryId, `${path}.entryId`, errorCode);
    requireText(name, `${path}.name`, errorCode);
    const category = enumValue(
      raw.category,
      COMPENDIUM_CATEGORIES,
      !strict ? legacyCompendiumCategory(raw) : "",
      `${path}.category`,
      errorCode,
    );
    const stage = enumValue(raw.stage, KNOWLEDGE_STAGES, !strict ? legacyKnowledgeStage(raw) : "", `${path}.stage`, errorCode);
    const confidence = enumValue(
      raw.confidence,
      CONFIDENCE_LEVELS,
      !strict ? legacyConfidence(stage) : "",
      `${path}.confidence`,
      errorCode,
    );
    const item: JsonObject = { entryId, name, category, stage, confidence };
    copyOptionalText(item, raw, "description", !strict ? raw.note ?? raw.info : undefined, `${path}.description`, errorCode);
    copyStringArray(item, raw, "knownFacts", `${path}.knownFacts`, errorCode);
    const sources = normalizeSources(raw.sources, strict, path, errorCode);
    if (!sources.length && strict) throw issue(errorCode, `${path}.sources 必須記錄至少一項知識來源。`);
    item.sources = sources.length ? sources : [{ type: "legacy_record", name: "既有紀錄（來源未記錄）" }];
    for (const key of ["relatedMapIds", "relatedNpcIds", "questIds", "tags"] as const) {
      copyStringArray(item, raw, key, `${path}.${key}`, errorCode);
    }
    return item;
  });
  assertUnique(result, "entryId", "compendium", errorCode);
  return result;
}

function normalizeSources(
  raw: JsonValue | undefined,
  strict: boolean,
  parentPath: string,
  errorCode: "INVALID_DIFF" | "INVALID_STATE",
): JsonObject[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw issue(errorCode, `${parentPath}.sources 必須是陣列。`);
  return raw.map((source, index) => normalizeSourceValue(source, strict, `${parentPath}.sources[${index}]`, errorCode));
}

function normalizeSourceValue(
  raw: JsonValue,
  strict: boolean,
  path: string,
  errorCode: "INVALID_DIFF" | "INVALID_STATE",
): JsonObject {
  if (typeof raw === "string" && !strict) return { type: "recorded_source", name: raw };
  const source = object(raw, path, errorCode);
  if (strict) assertOnlyKeys(source, SOURCE_KEYS, path, errorCode);
  const type = text(source.type) || (!strict ? "recorded_source" : "");
  const name = text(source.name) || (!strict ? text(source.sourceName) : "");
  requireText(type, `${path}.type`, errorCode);
  requireText(name, `${path}.name`, errorCode);
  const result: JsonObject = { type, name };
  for (const key of ["sourceId", "mapId", "npcId", "eventId"] as const) {
    copyOptionalText(result, source, key, undefined, `${path}.${key}`, errorCode);
  }
  copyOptionalInteger(result, source, "obtainedAtTick", `${path}.obtainedAtTick`, errorCode);
  return result;
}

function validateKnowledgeReferences(state: GameState, errorCode: "INVALID_DIFF" | "INVALID_STATE"): void {
  const mapIds = new Set(state.map.map((item) => String(item.mapId)));
  const npcIds = new Set(state.npcs.map((item) => String(item.npcId)));
  const entryIds = new Set(state.compendium.map((item) => String(item.entryId)));

  for (const item of state.map) {
    const mapId = String(item.mapId);
    if (typeof item.parentMapId === "string" && !mapIds.has(item.parentMapId)) {
      throw issue(errorCode, `地點 ${mapId} 的 parentMapId 尚未存在於玩家已知地圖。`);
    }
    for (const route of arrayObjects(item.routes)) {
      if (!mapIds.has(String(route.toMapId))) {
        throw issue(errorCode, `地點 ${mapId} 的路線指向尚未得知的 mapId：${String(route.toMapId)}。`);
      }
    }
    const refs = asObject(item.references);
    assertReferences(refs.npcIds, npcIds, `地點 ${mapId} 的 npcIds`, errorCode);
    assertReferences(refs.compendiumIds, entryIds, `地點 ${mapId} 的 compendiumIds`, errorCode);
  }

  for (const npc of state.npcs) {
    const location = asObject(npc.location);
    if (typeof location.mapId === "string" && !mapIds.has(location.mapId)) {
      throw issue(errorCode, `人物 ${String(npc.npcId)} 的位置尚未存在於玩家已知地圖。`);
    }
  }

  for (const entry of state.compendium) {
    assertReferences(entry.relatedMapIds, mapIds, `圖鑑 ${String(entry.entryId)} 的 relatedMapIds`, errorCode);
    assertReferences(entry.relatedNpcIds, npcIds, `圖鑑 ${String(entry.entryId)} 的 relatedNpcIds`, errorCode);
  }

  const playerLocation = asObject(state.player.location);
  if (typeof playerLocation.mapId === "string" && !mapIds.has(playerLocation.mapId)) {
    throw issue(errorCode, `玩家目前位置 mapId ${playerLocation.mapId} 尚未寫入已知地圖。`);
  }
}

function assertReferences(
  raw: JsonValue | undefined,
  known: Set<string>,
  label: string,
  errorCode: "INVALID_DIFF" | "INVALID_STATE",
): void {
  if (!Array.isArray(raw)) return;
  for (const id of raw) {
    if (typeof id === "string" && !known.has(id)) throw issue(errorCode, `${label} 引用了未知識別碼 ${id}。`);
  }
}

function legacyMapKind(raw: JsonObject): string {
  const value = text(raw.type) || text(raw.level);
  return MAP_KINDS.has(value) ? value : "place";
}

function legacyDiscovery(raw: JsonObject): string {
  if (raw.visited === true) return "visited";
  if (raw.heard === true) return "heard";
  return "known";
}

function legacyFamiliarity(raw: JsonObject): string {
  if (raw.met === false || raw.heard === true) return "heard";
  if (raw.trusted === true) return "trusted";
  return "met";
}

function legacyCompendiumCategory(raw: JsonObject): string {
  const value = text(raw.type);
  return COMPENDIUM_CATEGORIES.has(value) ? value : "other";
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

function enumValue(
  raw: JsonValue | undefined,
  allowed: Set<string>,
  fallback: string,
  path: string,
  errorCode: "INVALID_DIFF" | "INVALID_STATE",
): string {
  const value = text(raw) || fallback;
  if (!allowed.has(value)) throw issue(errorCode, `${path} 不是允許的值。`);
  return value;
}

function assertOnlyKeys(
  value: JsonObject,
  allowed: Set<string>,
  path: string,
  errorCode: "INVALID_DIFF" | "INVALID_STATE",
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw issue(errorCode, `${path} 含有未允許欄位：${unknown.join("、")}。`);
}

function assertNoSecrets(
  value: JsonValue,
  path: string,
  errorCode: "INVALID_DIFF" | "INVALID_STATE",
): void {
  if (Array.isArray(value)) return value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`, errorCode));
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEYS.has(key)) throw issue(errorCode, `${path}.${key} 是人物玩家介面禁止保存的秘密或逐字稿欄位。`);
    assertNoSecrets(child, `${path}.${key}`, errorCode);
  }
}

function assertUnique(
  items: JsonObject[],
  key: string,
  path: string,
  errorCode: "INVALID_DIFF" | "INVALID_STATE",
): void {
  const seen = new Set<string>();
  for (const item of items) {
    const id = String(item[key]);
    if (seen.has(id)) throw issue(errorCode, `${path} 中存在重複 ${key}：${id}。`);
    seen.add(id);
  }
}

function copyStringArray(
  target: JsonObject,
  source: JsonObject,
  key: string,
  path: string,
  errorCode: "INVALID_DIFF" | "INVALID_STATE",
): void {
  const value = source[key];
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw issue(errorCode, `${path} 必須是非空字串陣列。`);
  }
  target[key] = value.map((item) => String(item).trim());
}

function copyOptionalText(
  target: JsonObject,
  source: JsonObject,
  key: string,
  fallback: JsonValue | undefined,
  path: string,
  errorCode: "INVALID_DIFF" | "INVALID_STATE",
): void {
  const value = source[key] ?? fallback;
  if (value === undefined) return;
  const normalized = text(value);
  if (!normalized) throw issue(errorCode, `${path} 必須是非空字串。`);
  target[key] = normalized;
}

function copyOptionalInteger(
  target: JsonObject,
  source: JsonObject,
  key: string,
  path: string,
  errorCode: "INVALID_DIFF" | "INVALID_STATE",
): void {
  const value = source[key];
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw issue(errorCode, `${path} 必須是非負整數。`);
  }
  target[key] = value;
}

function requireText(value: string, path: string, errorCode: "INVALID_DIFF" | "INVALID_STATE"): void {
  if (!value) throw issue(errorCode, `${path} 必須是非空字串。`);
}

function object(value: JsonValue, path: string, errorCode: "INVALID_DIFF" | "INVALID_STATE"): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw issue(errorCode, `${path} 必須是物件。`);
  return value;
}

function asObject(value: JsonValue | undefined): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function arrayObjects(value: JsonValue | undefined): JsonObject[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is JsonObject => Boolean(item) && typeof item === "object" && !Array.isArray(item));
}

function text(value: JsonValue | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function nonnegativeNumber(value: JsonValue): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function issue(code: "INVALID_DIFF" | "INVALID_STATE", message: string): AegisError {
  return new AegisError(code, message);
}
