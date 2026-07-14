import type { GameState, JsonObject } from "./types.js";
import { migrateEquipmentState } from "./equipment.js";
import { survivalView } from "./survival.js";
import { normalizeSkills } from "./skills.js";
import { normalizeKnowledgeState, playerKnowledgeView } from "./knowledge.js";

export const AEGIS_VERSION = "6.7.7-mcp.5";

export function defaultGameState(gameId: string, title = "AEGIS 冒險"): GameState {
  const now = new Date().toISOString();
  return {
    gameId,
    title,
    version: AEGIS_VERSION,
    schemaVersion: AEGIS_VERSION,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    world: {
      name: "",
      genre: "異世界開放世界",
      era: "",
      civilization: "",
      technology: "",
      magic: "",
      currency: "",
      language: "",
      religion: "",
      startRegion: "",
      survivalBalance: {
        hungerPerGameHour: 2,
        hydrationPerGameHour: 3,
      },
      notes: "",
    },
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
      autoSave: { status: "saved", revision: 0, savedAt: now },
    },
  };
}

export function defaultPlayerState(): JsonObject {
  return {
    initialized: false,
    tick: 0,
    money: 0,
    attributes: {},
    skills: [],
    equipment: {},
    equippedItems: {},
    activeEquipmentModifiers: [],
    survival: {
      hunger: 100,
      hydration: 100,
      elapsedGameMinutes: 0,
      modifiers: [],
    },
  };
}

export function migrateGameState(state: GameState): GameState {
  const migrated = cloneState(state);
  migrated.version = AEGIS_VERSION;
  migrated.schemaVersion = AEGIS_VERSION;
  if (migrated.world.survivalBalance === undefined) {
    migrated.world.survivalBalance = { hungerPerGameHour: 2, hydrationPerGameHour: 3 };
  }
  if (migrated.player.skills === undefined) migrated.player.skills = [];
  if (Array.isArray(migrated.player.skills)) {
    migrated.player.skills = normalizeSkills(
      migrated.player.skills.map((skill) =>
        Boolean(skill) && typeof skill === "object" && !Array.isArray(skill)
          ? skill as JsonObject
          : { name: String(skill) },
      ),
      false,
    );
  }
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
  const autoSave = asObject(migrated.engine.autoSave);
  if (autoSave.status === undefined) autoSave.status = "saved";
  if (autoSave.revision === undefined) autoSave.revision = migrated.revision;
  if (autoSave.savedAt === undefined) autoSave.savedAt = migrated.updatedAt;
  migrated.engine.autoSave = autoSave;
  if (!Array.isArray(migrated.npcs)) migrated.npcs = [];
  if (!Array.isArray(migrated.map)) migrated.map = [];
  if (!Array.isArray(migrated.compendium)) migrated.compendium = [];
  normalizeKnowledgeState(migrated, false);
  return migrateEquipmentState(migrated);
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
    world: state.world,
    player,
    inventory: state.inventory,
    quests: state.quests,
    map: knowledge.map,
    npcs: knowledge.npcs,
    compendium: knowledge.compendium,
    recentHistory: state.history.recent.slice(-12),
    autoSave: asObject(state.engine.autoSave),
  };
}

export function cloneState<T>(value: T): T {
  return structuredClone(value);
}

export function asObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonObject;
}
