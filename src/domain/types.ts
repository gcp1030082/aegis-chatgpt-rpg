export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export interface HistoryState {
  recent: JsonValue[];
  major: JsonValue[];
  summary: JsonValue[];
}

export interface GameState {
  gameId: string;
  title: string;
  version: string;
  schemaVersion: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  world: JsonObject;
  player: JsonObject;
  inventory: JsonObject[];
  npcs: JsonObject[];
  compendium: JsonObject[];
  map: JsonObject[];
  quests: JsonObject[];
  history: HistoryState;
  engine: JsonObject;
}

export interface SaveRecord {
  saveId: string;
  gameId: string;
  name: string;
  sourceRevision: number;
  createdAt: string;
  state: GameState;
}

export interface SaveSummary {
  saveId: string;
  gameId: string;
  name: string;
  sourceRevision: number;
  createdAt: string;
}

export interface GameView {
  gameId: string;
  title: string;
  revision: number;
  updatedAt: string;
  world: JsonObject;
  player: JsonObject;
  inventory: JsonObject[];
  quests: JsonObject[];
  map: JsonObject[];
  npcs: JsonObject[];
  compendium: JsonObject[];
  recentHistory: JsonValue[];
  autoSave: JsonObject;
}

export interface PreparedTurn {
  gameId: string;
  revision: number;
  runtime: string;
  actionTags: string[];
  runtimeContext: string;
  game: GameView;
}

export interface ApplyDiffResult {
  game: GameState;
  changedPaths: string[];
}
