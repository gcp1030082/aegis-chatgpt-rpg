import type { GameState, JsonObject } from "./types.js";

export const AEGIS_VERSION = "6.7.7-mcp.1";

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
    player: {
      name: "",
      gender: "",
      age: "",
      race: "",
      role: "",
      background: "",
      attributes: {},
      hp: "",
      mp: "",
      sp: "",
      level: "",
      money: 0,
      skills: [],
      equipment: {},
      location: { region: "", location: "", sublocation: "" },
      date: "",
      time: "",
      season: "",
      weather: "",
      tick: 0,
      initialized: false,
    },
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

export function toGameView(state: GameState) {
  return {
    gameId: state.gameId,
    title: state.title,
    revision: state.revision,
    updatedAt: state.updatedAt,
    world: state.world,
    player: state.player,
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
