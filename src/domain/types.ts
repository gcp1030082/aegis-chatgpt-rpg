export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export interface GameTimeSnapshot {
  year: number;
  monthId: string;
  day: number;
  minuteOfDay: number;
}

export type GameClock = GameTimeSnapshot;

export type MapKind = "region" | "town" | "place" | "subplace";
export type MapDiscovery = "heard" | "known" | "visited" | "surveyed";
export type DangerLevel = "unknown" | "low" | "moderate" | "high" | "extreme";
export type RouteKnowledgeStatus = "heard" | "known" | "verified";

export interface MapRoute {
  routeId: string;
  toMapId: string;
  estimatedMinutes?: number;
  travelMode?: "walk" | "ride" | "boat" | "other";
  estimateConfidence?: "rough" | "normal" | "confirmed";
  danger?: DangerLevel;
  conditions?: string[];
  requirements?: string[];
  notes?: string;
  knowledgeStatus?: RouteKnowledgeStatus;
  sourceType?: string;
  sourceId?: string;
  firstLearnedAtRevision?: number;
  firstLearnedAtGameTime?: GameTimeSnapshot;
  lastVerifiedAtRevision?: number;
  lastVerifiedAtGameTime?: GameTimeSnapshot;
}

export interface MapFacility {
  facilityId: string;
  name: string;
  type?: string;
  availability?: string;
}

export interface KnownDanger {
  dangerId: string;
  name: string;
  severity?: DangerLevel;
  description?: string;
  confirmed?: boolean;
  sourceType?: string;
  sourceId?: string;
}

export interface MapEntry {
  mapId: string;
  name: string;
  kind: MapKind;
  discovery: MapDiscovery;
  parentMapId?: string;
  description?: string;
  routes?: MapRoute[];
  facilities?: MapFacility[];
  knownDangers?: KnownDanger[];
  references?: { npcIds?: string[]; questIds?: string[]; compendiumIds?: string[] };
  firstLearnedAtRevision?: number;
  firstLearnedAtGameTime?: GameTimeSnapshot;
  lastUpdatedAtRevision?: number;
  lastUpdatedAtGameTime?: GameTimeSnapshot;
}

export type NpcFamiliarity = "heard" | "met" | "acquainted" | "familiar" | "trusted";
export type NpcLocationStatus = "current" | "last_known" | "unknown";

export interface NpcKnownLocation {
  mapId?: string;
  name?: string;
  status: NpcLocationStatus;
  observedAtRevision?: number;
  observedAtGameTime?: GameTimeSnapshot;
}

export interface NpcKnownInformation {
  infoId: string;
  content: string;
  sourceType?: string;
  sourceId?: string;
  confidence?: KnowledgeConfidence;
  learnedAtRevision?: number;
  learnedAtGameTime?: GameTimeSnapshot;
}

export interface NpcService {
  serviceId: string;
  name: string;
  type?: string;
  conditions?: string;
  availability?: string;
}

export interface NpcMemory {
  memoryId: string;
  summary: string;
  importance: "minor" | "important" | "major";
  createdAtRevision?: number;
  createdAtGameTime?: GameTimeSnapshot;
}

export interface KnownNpc {
  npcId: string;
  name: string;
  identity?: string;
  familiarity: NpcFamiliarity;
  relationship?: { label: string; tags?: string[] };
  location?: NpcKnownLocation;
  knownInformation?: NpcKnownInformation[];
  services?: NpcService[];
  memories?: NpcMemory[];
  questIds?: string[];
}

export type CompendiumStage = "rumor" | "observed" | "identified" | "verified" | "researched";
export type KnowledgeConfidence = "low" | "medium" | "high" | "confirmed";

export interface KnowledgeSource {
  sourceType: "rumor" | "npc" | "observation" | "skill" | "book" | "document" | "experiment" | "quest" | "other";
  sourceId?: string;
  description?: string;
}

export interface CompendiumFact {
  factId: string;
  text: string;
  sources: KnowledgeSource[];
  confidence: KnowledgeConfidence;
  firstLearnedAtRevision?: number;
  firstLearnedAtGameTime?: GameTimeSnapshot;
  lastUpdatedAtRevision?: number;
  lastUpdatedAtGameTime?: GameTimeSnapshot;
}

export interface CompendiumEntry {
  entryId: string;
  name: string;
  category: string;
  categoryLabel: string;
  stage: CompendiumStage;
  summary?: string;
  facts: CompendiumFact[];
  relatedMapIds?: string[];
  relatedNpcIds?: string[];
  questIds?: string[];
  tags?: string[];
}

export interface QuestRecord {
  questId: string;
  name: string;
  status?: string;
  description?: string;
  objectives?: JsonValue[];
}

export interface BaseHistoryEvent {
  eventId: string;
  type: string;
  summary?: string;
  revision: number;
  gameTime: GameTimeSnapshot;
}

export interface GeneralEvent extends BaseHistoryEvent { type: "general" }
export interface TimeElapsedEvent extends BaseHistoryEvent { type: "time_elapsed"; elapsedMinutes: number }
export interface TravelEvent extends BaseHistoryEvent { type: "travel"; fromMapId: string; toMapId: string; actualTravelMinutes: number }
export interface ItemUsedEvent extends BaseHistoryEvent { type: "item_used"; itemName?: string }
export interface SurvivalChangedEvent extends BaseHistoryEvent { type: "survival_changed" }
export interface QuestChangedEvent extends BaseHistoryEvent { type: "quest_changed"; questId?: string; questName?: string }
export interface LocationDiscoveredEvent extends BaseHistoryEvent { type: "location_discovered"; mapId?: string; mapName?: string }
export interface NpcMetEvent extends BaseHistoryEvent { type: "npc_met"; npcId?: string; npcName?: string }
export interface NpcInformationLearnedEvent extends BaseHistoryEvent { type: "npc_information_learned"; npcId?: string; npcName?: string }
export interface NpcLocationUpdatedEvent extends BaseHistoryEvent { type: "npc_location_updated"; npcId?: string; npcName?: string }
export interface CompendiumUpdatedEvent extends BaseHistoryEvent { type: "compendium_updated"; entryId?: string; entryName?: string }

export type HistoryEvent =
  | GeneralEvent
  | TimeElapsedEvent
  | TravelEvent
  | ItemUsedEvent
  | SurvivalChangedEvent
  | QuestChangedEvent
  | LocationDiscoveredEvent
  | NpcMetEvent
  | NpcInformationLearnedEvent
  | NpcLocationUpdatedEvent
  | CompendiumUpdatedEvent;

export interface CalendarMonthDefinition {
  monthId: string;
  name: string;
  days: number;
  seasonId?: string;
}

export interface WorldCalendar {
  calendarId: string;
  eraName: string;
  hoursPerDay: number;
  minutesPerHour: number;
  months: CalendarMonthDefinition[];
  seasons?: Array<{ seasonId: string; name: string }>;
}

export interface PrivateWorldState {
  gameId: string;
  schemaVersion: string;
  npcs: Record<string, JsonObject>;
  updatedAt: string;
}

export interface MigrationBackup {
  backupId: string;
  gameId: string;
  migrationKey: string;
  sourceVersion: string;
  sourceRevision: number;
  createdAt: string;
  state: GameState;
}

export interface MigrationCommit {
  expectedRevision: number;
  game: GameState;
  privateWorld: PrivateWorldState;
  backup: MigrationBackup;
}

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

export interface TurnRecord {
  turnId: string;
  gameId: string;
  preparedRevision: number;
  preparedAt: string;
  dashboardRevision: number | null;
  dashboardShownAt: string | null;
}

export interface DashboardClaim {
  game: GameState;
  turn: TurnRecord;
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

export interface DashboardGameView extends GameView {
  mapIndex: JsonObject;
  referenceIndex: JsonObject;
  historyEvents: JsonObject[];
  payloadLimits: JsonObject;
}

export interface PreparedTurn {
  turnId: string;
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
