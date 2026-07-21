import { createHash } from "node:crypto";
import type { GameState, JsonObject, MigrationBackup, PrivateWorldState } from "./types.js";
import { migrateEquipmentState } from "./equipment.js";
import { survivalView } from "./survival.js";
import { normalizeSkills } from "./skills.js";
import { normalizeKnowledgeState, playerKnowledgeView, finalizeKnowledgeMetadata } from "./knowledge.js";
import { DEFAULT_CLOCK, normalizeClockState, snapshotObject } from "./clock.js";
import { normalizeQuestState } from "./quests.js";
import { normalizeHistoryState } from "./history.js";
import { canonicalWorldState } from "./world.js";

export const APP_VERSION = "0.7.1";
export const AEGIS_VERSION = "6.7.7-mcp.7.0";
export const SCHEMA_VERSION = "0.7.0";
export const MIGRATION_KEY = "aelvia-fixed-world-v1";

export interface MigrationResult {
  game: GameState;
  privateWorld: PrivateWorldState;
  changed: boolean;
  sourceVersion: string;
}

export function defaultGameState(gameId: string, title = "AEGIS 冒險"): GameState {
  const now = new Date().toISOString();
  return {
    gameId,
    title,
    version: AEGIS_VERSION,
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    world: canonicalWorldState(),
    player: defaultPlayerState(),
    inventory: [],
    npcs: [],
    compendium: [],
    map: [],
    quests: [],
    history: { recent: [], major: [], summary: [] },
    engine: {
      notes: "AEGIS persistent MCP runtime",
      historyLimit: 100,
      transactionLog: [],
      idempotencyKeys: [],
      migrations: {
        [MIGRATION_KEY]: {
          sourceVersion: SCHEMA_VERSION,
          targetVersion: SCHEMA_VERSION,
          completedAt: now,
        },
      },
      autoSave: { status: "saved", revision: 0, savedAt: now },
    },
  };
}

export function defaultPlayerState(): JsonObject {
  const clock = structuredClone(DEFAULT_CLOCK);
  return {
    initialized: false,
    tick: 0,
    money: 0,
    attributes: {},
    skills: [],
    equipment: {},
    equippedItems: {},
    activeEquipmentModifiers: [],
    clock: snapshotObject(clock),
    date: "群星曆742年・芽月1日",
    time: "上午 08:00",
    season: "春季",
    survival: {
      hunger: 100,
      hydration: 100,
      elapsedGameMinutes: 0,
      modifiers: [],
    },
  };
}

export function needsGameMigration(state: GameState): boolean {
  const migrations = asObject(state.engine?.migrations);
  return state.schemaVersion !== SCHEMA_VERSION || !asObject(migrations[MIGRATION_KEY]).completedAt;
}

export function buildGameMigration(
  state: GameState,
  existingPrivate?: PrivateWorldState | null,
): MigrationResult {
  if (!needsGameMigration(state)) {
    return {
      game: cloneState(state),
      privateWorld: existingPrivate ?? defaultPrivateWorldState(state.gameId, state.updatedAt),
      changed: false,
      sourceVersion: state.schemaVersion,
    };
  }

  const source = cloneState(state);
  const sourceVersion = source.schemaVersion || source.version || "legacy";
  const migrated = cloneState(source);
  const now = new Date().toISOString();
  const privateWorld = existingPrivate
    ? cloneState(existingPrivate)
    : defaultPrivateWorldState(migrated.gameId, now);
  normalizeBaseState(migrated);
  extractLegacyPrivateNpcState(migrated, privateWorld);
  ensureLegacyLocationHierarchy(migrated);
  applyMainCuratedHierarchy(migrated);
  const legacyDate = migrated.player.date;
  const legacyTime = migrated.player.time;
  migrated.world = canonicalWorldState();
  migrated.player.clock = {};
  migrated.player.date = typeof legacyDate === "string" ? legacyDate : "";
  migrated.player.time = typeof legacyTime === "string" ? legacyTime : "";
  normalizeClockState(migrated, true);
  normalizeKnowledgeState(migrated, false);
  normalizeQuestState(migrated, false);
  migrateStructuredRoutes(migrated, [
    ...(migrated.history?.recent ?? []),
    ...(migrated.history?.major ?? []),
    ...(migrated.history?.summary ?? []),
  ]);
  normalizeKnowledgeState(migrated, false);
  finalizeKnowledgeMetadata(source, migrated);
  normalizeHistoryState(migrated, undefined, MIGRATION_KEY, false);
  migrated.version = AEGIS_VERSION;
  migrated.schemaVersion = SCHEMA_VERSION;
  const migrations = asObject(migrated.engine.migrations);
  migrations[MIGRATION_KEY] = {
    sourceVersion,
    targetVersion: SCHEMA_VERSION,
    completedAt: now,
  };
  migrated.engine.migrations = migrations;
  const autoSave = asObject(migrated.engine.autoSave);
  autoSave.status = "saved";
  autoSave.revision = migrated.revision;
  autoSave.savedAt = typeof autoSave.savedAt === "string" ? autoSave.savedAt : migrated.updatedAt;
  migrated.engine.autoSave = autoSave;
  privateWorld.schemaVersion = SCHEMA_VERSION;
  privateWorld.updatedAt = now;
  return { game: migrateEquipmentState(migrated), privateWorld, changed: true, sourceVersion };
}

export function migrateGameState(state: GameState): GameState {
  return buildGameMigration(state).game;
}

export function createMigrationBackup(
  source: GameState,
  sourceVersion: string,
  createdAt = new Date().toISOString(),
): MigrationBackup {
  const sourceRevision = Number.isInteger(source.revision) && source.revision >= 0 ? source.revision : 0;
  const hash = createHash("sha256")
    .update(`${source.gameId}:${MIGRATION_KEY}:${sourceVersion}:${sourceRevision}`)
    .digest("hex")
    .slice(0, 24);
  return {
    backupId: `migration-${hash}`,
    gameId: source.gameId,
    migrationKey: MIGRATION_KEY,
    sourceVersion,
    sourceRevision,
    createdAt,
    state: cloneState(source),
  };
}

export function defaultPrivateWorldState(gameId: string, updatedAt = new Date().toISOString()): PrivateWorldState {
  return { gameId, schemaVersion: SCHEMA_VERSION, npcs: {}, updatedAt };
}

export function toGameView(state: GameState) {
  const player = cloneState(state.player);
  const storedSurvival = asObject(player.survival);
  player.survival = { ...storedSurvival, ...survivalView(player) };
  const knowledge = playerKnowledgeView(state);
  return {
    gameId: state.gameId,
    title: state.title,
    revision: state.revision,
    updatedAt: state.updatedAt,
    world: cloneState(state.world),
    player,
    inventory: cloneState(state.inventory),
    quests: cloneState(state.quests),
    map: knowledge.map,
    npcs: knowledge.npcs,
    compendium: knowledge.compendium,
    recentHistory: cloneState(state.history.recent.slice(-12)),
    autoSave: cloneState(asObject(state.engine.autoSave)),
  };
}

export function cloneState<T>(value: T): T {
  return structuredClone(value);
}

export function asObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonObject;
}

function normalizeBaseState(migrated: GameState): void {
  const now = new Date().toISOString();
  if (typeof migrated.title !== "string" || !migrated.title.trim()) migrated.title = "AEGIS 冒險";
  if (!Number.isInteger(migrated.revision) || migrated.revision < 0) migrated.revision = 0;
  if (typeof migrated.createdAt !== "string" || !migrated.createdAt) migrated.createdAt = now;
  if (typeof migrated.updatedAt !== "string" || !migrated.updatedAt) migrated.updatedAt = migrated.createdAt;
  if (!migrated.world || typeof migrated.world !== "object" || Array.isArray(migrated.world)) migrated.world = {};
  if (migrated.world.survivalBalance === undefined) migrated.world.survivalBalance = { hungerPerGameHour: 2, hydrationPerGameHour: 3 };
  if (!migrated.player || typeof migrated.player !== "object" || Array.isArray(migrated.player)) migrated.player = defaultPlayerState();
  if (!Array.isArray(migrated.player.skills)) migrated.player.skills = [];
  migrated.player.skills = normalizeSkills(
    migrated.player.skills.map((skill) => Boolean(skill) && typeof skill === "object" && !Array.isArray(skill) ? skill as JsonObject : { name: String(skill) }),
    false,
  );
  if (migrated.player.equipment === undefined) migrated.player.equipment = {};
  if (migrated.player.attributes === undefined) migrated.player.attributes = {};
  if (migrated.player.money === undefined) migrated.player.money = 0;
  if (migrated.player.tick === undefined) migrated.player.tick = 0;
  if (migrated.player.initialized === undefined) migrated.player.initialized = false;
  const survival = asObject(migrated.player.survival);
  if (survival.hunger === undefined) survival.hunger = 100;
  if (survival.hydration === undefined) survival.hydration = 100;
  if (survival.elapsedGameMinutes === undefined) survival.elapsedGameMinutes = 0;
  if (survival.modifiers === undefined) survival.modifiers = [];
  migrated.player.survival = survival;
  if (!Array.isArray(migrated.inventory)) migrated.inventory = [];
  if (!Array.isArray(migrated.npcs)) migrated.npcs = [];
  if (!Array.isArray(migrated.map)) migrated.map = [];
  if (!Array.isArray(migrated.compendium)) migrated.compendium = [];
  if (!Array.isArray(migrated.quests)) migrated.quests = [];
  if (!migrated.history || typeof migrated.history !== "object" || Array.isArray(migrated.history)) {
    migrated.history = { recent: [], major: [], summary: [] };
  }
  for (const key of ["recent", "major", "summary"] as const) if (!Array.isArray(migrated.history[key])) migrated.history[key] = [];
  if (!migrated.engine || typeof migrated.engine !== "object" || Array.isArray(migrated.engine)) migrated.engine = {};
  if (!Array.isArray(migrated.engine.transactionLog)) migrated.engine.transactionLog = [];
  if (!Array.isArray(migrated.engine.idempotencyKeys)) migrated.engine.idempotencyKeys = [];
  if (migrated.engine.historyLimit === undefined) migrated.engine.historyLimit = 100;
}

function extractLegacyPrivateNpcState(game: GameState, privateWorld: PrivateWorldState): void {
  for (const [index, npc] of game.npcs.entries()) {
    const npcId = text(npc.npcId) || text(npc.id) || stableLegacyId(game.gameId, "npc", index, npc);
    const extracted: JsonObject = {};
    for (const [key, value] of Object.entries(npc)) {
      if (PRIVATE_KEYS.has(key) || key.toLowerCase().startsWith("private") || key.toLowerCase().startsWith("hidden")) {
        extracted[key] = cloneState(value);
      }
    }
    if (Object.keys(extracted).length) {
      privateWorld.npcs[npcId] = { ...asObject(privateWorld.npcs[npcId]), ...extracted };
    }
  }
}

const PRIVATE_KEYS = new Set([
  "secret", "secrets", "trueIdentity", "privateState", "privateNotes", "hiddenInfo", "hiddenInformation",
  "gmNotes", "agenda", "goals", "motives", "schedule", "trueLocation", "privateQuests", "unrevealedRelations",
]);

function ensureLegacyLocationHierarchy(game: GameState): void {
  ensureExplicitLegacyMapParents(game);
  const location = asObject(game.player.location);
  if (text(location.mapId)) return;
  const parts = [
    { name: text(location.region), kind: "region" },
    { name: text(location.location), kind: "place" },
    { name: text(location.sublocation), kind: "subplace" },
  ].filter((part) => part.name);
  let parentMapId = "";
  for (const [index, part] of parts.entries()) {
    let entry = game.map.find((candidate) => text(candidate.name) === part.name);
    if (!entry) {
      entry = {
        mapId: stableLegacyId(game.gameId, "map-location", index, { name: part.name }),
        name: part.name,
        kind: part.kind,
        discovery: index === parts.length - 1 ? "visited" : "known",
      };
      game.map.push(entry);
    }
    if (parentMapId && !text(entry.parentMapId)) entry.parentMapId = parentMapId;
    parentMapId = text(entry.mapId) || stableLegacyId(game.gameId, "map-location", index, entry);
    entry.mapId = parentMapId;
  }
  if (parentMapId) location.mapId = parentMapId;
  if (Object.keys(location).length) game.player.location = location;
}

function ensureExplicitLegacyMapParents(game: GameState): void {
  const original = [...game.map];
  const ensure = (name: string, kind: string): JsonObject => {
    let entry = game.map.find((candidate) => text(candidate.name) === name);
    if (!entry) {
      entry = {
        mapId: stableLegacyId(game.gameId, `map-${kind}`, game.map.length, { name }),
        name,
        kind,
        discovery: "known",
      };
      game.map.push(entry);
    }
    if (!text(entry.mapId)) entry.mapId = stableLegacyId(game.gameId, `map-${kind}`, game.map.indexOf(entry), entry);
    return entry;
  };
  for (const raw of original) {
    const regionName = text(raw.region);
    const townName = text(raw.town);
    let parent: JsonObject | undefined;
    if (regionName && regionName !== text(raw.name)) parent = ensure(regionName, "region");
    if (townName && townName !== text(raw.name)) {
      const town = ensure(townName, "town");
      if (parent) town.parentMapId = String(parent.mapId);
      parent = town;
    }
    if (parent && !text(raw.parentMapId)) raw.parentMapId = String(parent.mapId);
  }
}

function applyMainCuratedHierarchy(game: GameState): void {
  if (game.gameId !== "main") return;
  const definitions = [
    { name: "洛薩邊境", id: "map-lothar-border-001", kind: "region", parent: "" },
    { name: "白樺渡鎮", id: "map-white-birch-town-001", kind: "town", parent: "洛薩邊境" },
    { name: "折角鹿角酒館", id: "map-antler-tavern-001", kind: "place", parent: "白樺渡鎮" },
    { name: "灰葉藥鋪", id: "map-grayleaf-apothecary-001", kind: "place", parent: "白樺渡鎮" },
    { name: "北岸白樺淺谷", id: "map-north-birch-valley-001", kind: "place", parent: "洛薩邊境" },
    { name: "淺谷入口", id: "map-birch-hollow-entrance-001", kind: "subplace", parent: "北岸白樺淺谷" },
    { name: "廢棄瞭望塔", id: "map-abandoned-watchtower-001", kind: "place", parent: "洛薩邊境" },
  ];
  const evidence = new Set<string>();
  for (const entry of game.map) evidence.add(text(entry.name));
  const location = asObject(game.player.location);
  for (const key of ["region", "location", "sublocation"] as const) if (text(location[key])) evidence.add(text(location[key]));
  const required = new Set(evidence);
  for (const definition of [...definitions].reverse()) {
    if (required.has(definition.name) && definition.parent) required.add(definition.parent);
  }
  const byName = new Map<string, JsonObject>();
  const idRemap = new Map<string, string>();
  for (const definition of definitions) {
    let entry = game.map.find((candidate) => text(candidate.name) === definition.name);
    if (!entry && required.has(definition.name)) {
      entry = { mapId: definition.id, name: definition.name, kind: definition.kind, discovery: "known" };
      game.map.push(entry);
    }
    if (entry) {
      const oldId = text(entry.mapId);
      if (oldId && oldId !== definition.id) idRemap.set(oldId, definition.id);
      entry.mapId = definition.id;
      entry.kind = definition.kind;
      byName.set(definition.name, entry);
    }
  }
  rewriteMapIdReferences(game, idRemap);
  for (const definition of definitions) {
    const entry = byName.get(definition.name);
    const parent = byName.get(definition.parent);
    if (entry && parent) entry.parentMapId = String(parent.mapId);
  }
  const currentName = text(location.sublocation) || text(location.location) || text(location.region);
  const current = byName.get(currentName);
  if (current) {
    location.mapId = String(current.mapId);
    game.player.location = location;
  }
}

function rewriteMapIdReferences(game: GameState, remap: Map<string, string>): void {
  if (remap.size === 0) return;
  const rewrite = (value: unknown): unknown => typeof value === "string" ? remap.get(value) ?? value : value;
  const location = asObject(game.player.location);
  if (location.mapId !== undefined) location.mapId = rewrite(location.mapId) as string;
  if (Object.keys(location).length) game.player.location = location;
  for (const entry of game.map) {
    if (entry.parentMapId !== undefined) entry.parentMapId = rewrite(entry.parentMapId) as string;
    if (Array.isArray(entry.routes)) {
      for (const route of entry.routes) {
        if (!route || typeof route !== "object" || Array.isArray(route)) continue;
        if (route.toMapId !== undefined) route.toMapId = rewrite(route.toMapId) as JsonObject[string];
        if (route.sourceId !== undefined) route.sourceId = rewrite(route.sourceId) as JsonObject[string];
      }
    }
    if (Array.isArray(entry.knownDangers)) {
      for (const danger of entry.knownDangers) {
        if (danger && typeof danger === "object" && !Array.isArray(danger) && danger.sourceId !== undefined) {
          danger.sourceId = rewrite(danger.sourceId) as JsonObject[string];
        }
      }
    }
  }
  for (const npc of game.npcs) {
    const knownLocation = asObject(npc.location);
    if (knownLocation.mapId !== undefined) knownLocation.mapId = rewrite(knownLocation.mapId) as string;
    if (Object.keys(knownLocation).length) npc.location = knownLocation;
    if (Array.isArray(npc.knownInformation)) {
      for (const info of npc.knownInformation) {
        if (info && typeof info === "object" && !Array.isArray(info) && info.sourceId !== undefined) {
          info.sourceId = rewrite(info.sourceId) as JsonObject[string];
        }
      }
    }
  }
  for (const entry of game.compendium) {
    if (Array.isArray(entry.relatedMapIds)) entry.relatedMapIds = entry.relatedMapIds.map(rewrite) as JsonObject[string];
    if (Array.isArray(entry.facts)) {
      for (const fact of entry.facts) {
        if (!fact || typeof fact !== "object" || Array.isArray(fact) || !Array.isArray(fact.sources)) continue;
        for (const source of fact.sources) {
          if (source && typeof source === "object" && !Array.isArray(source) && source.sourceId !== undefined) {
            source.sourceId = rewrite(source.sourceId) as JsonObject[string];
          }
        }
      }
    }
  }
  for (const channel of [game.history.recent, game.history.major, game.history.summary]) {
    for (const raw of channel) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      for (const key of ["mapId", "fromMapId", "toMapId", "sourceId"] as const) {
        if (raw[key] !== undefined) raw[key] = rewrite(raw[key]) as JsonObject[string];
      }
    }
  }
}

function migrateStructuredRoutes(game: GameState, events: unknown[]): void {
  const maps = new Map(game.map.map((entry) => [text(entry.mapId), entry]));
  for (const raw of events) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const event = raw as Record<string, unknown>;
    if (event.type !== "travel") continue;
    const fromMapId = typeof event.fromMapId === "string" ? event.fromMapId : "";
    const toMapId = typeof event.toMapId === "string" ? event.toMapId : "";
    const from = maps.get(fromMapId);
    if (!from || !maps.has(toMapId)) continue;
    const routes = Array.isArray(from.routes) ? from.routes.filter((value): value is JsonObject => Boolean(value) && typeof value === "object" && !Array.isArray(value)) : [];
    if (routes.some((route) => route.toMapId === toMapId)) continue;
    const minutes = typeof event.actualTravelMinutes === "number" && Number.isInteger(event.actualTravelMinutes)
      ? event.actualTravelMinutes
      : undefined;
    routes.push({
      routeId: stableLegacyId(game.gameId, "route-event", routes.length, { fromMapId, toMapId }),
      toMapId,
      ...(minutes !== undefined ? { estimatedMinutes: minutes } : {}),
      knowledgeStatus: "verified",
      sourceType: "travel_event",
    });
    from.routes = routes;
  }
}

function stableLegacyId(gameId: string, prefix: string, index: number, value: JsonObject): string {
  const hash = createHash("sha256").update(`${gameId}:${prefix}:${index}:${JSON.stringify(value)}`).digest("hex").slice(0, 20);
  return `${prefix}-${hash}`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
