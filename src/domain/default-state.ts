import type { GameState, JsonObject } from "./types.js";
import { normalizeItemCategory } from "./inventory.js";
import { survivalView } from "./survival.js";

export const AEGIS_VERSION = "6.7.7-mcp.2";

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
  if (migrated.player.skills === undefined) migrated.player.skills = [];
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
  migrated.inventory = migrated.inventory.map((item) => normalizeItemCategory(item));
  return migrated;
}

export function toGameView(state: GameState) {
  const player = cloneState(state.player);
  const storedSurvival = asObject(player.survival);
  player.survival = { ...storedSurvival, ...survivalView(player) };
  return {
    gameId: state.gameId,
    title: state.title,
    revision: state.revision,
    updatedAt: state.updatedAt,
    world: state.world,
    player,
    inventory: state.inventory,
    quests: state.quests,
    recentHistory: state.history.recent.slice(-12),
  };
}

export function cloneState<T>(value: T): T {
  return structuredClone(value);
}

export function asObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonObject;
}
