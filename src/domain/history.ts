import { createHash } from "node:crypto";
import { AegisError } from "./errors.js";
import { clockSnapshot, snapshotObject } from "./clock.js";
import type { GameState, JsonObject, JsonValue } from "./types.js";

export const HISTORY_EVENT_TYPES = new Set([
  "general",
  "time_elapsed",
  "travel",
  "item_used",
  "survival_changed",
  "quest_changed",
  "location_discovered",
  "npc_met",
  "npc_information_learned",
  "npc_location_updated",
  "compendium_updated",
  "container_refilled",
  "equipment_changed",
]);

const LEGACY_TYPE_ALIASES: Record<string, string> = {
  item_use: "item_used",
  survival_event: "survival_changed",
  container_refill: "container_refilled",
};

export function normalizeHistoryState(
  state: GameState,
  current: GameState | undefined,
  seed: string,
  strict: boolean,
): void {
  const previous = current ? allEvents(current) : new Map<string, JsonObject>();
  const snapshot = snapshotObject(clockSnapshot(state));
  const seen = new Set<string>();
  for (const channel of ["recent", "major", "summary"] as const) {
    state.history[channel] = state.history[channel].map((raw, index) => {
      const normalized = normalizeEvent(raw, strict, `${channel}[${index}]`);
      let eventId = text(normalized.eventId);
      if (!eventId) {
        eventId = deterministicEventId(state.gameId, seed, channel, index, normalized);
      }
      if (seen.has(eventId)) {
        throw new AegisError(strict ? "INVALID_DIFF" : "INVALID_STATE", `history 中存在重複 eventId：${eventId}。`);
      }
      seen.add(eventId);
      const existing = previous.get(eventId);
      if (existing) return structuredClone(existing);
      delete normalized.revision;
      delete normalized.gameTime;
      normalized.eventId = eventId;
      normalized.revision = state.revision;
      normalized.gameTime = structuredClone(snapshot);
      return normalized;
    });
  }
}

export function validateHistoryState(state: GameState): void {
  const seen = new Set<string>();
  for (const [channel, values] of Object.entries(state.history)) {
    for (const [index, raw] of values.entries()) {
      if (!isObject(raw)) throw new AegisError("INVALID_STATE", `history.${channel}[${index}] 必須是事件物件。`);
      const eventId = text(raw.eventId);
      if (!eventId) throw new AegisError("INVALID_STATE", `history.${channel}[${index}].eventId 必須存在。`);
      if (seen.has(eventId)) throw new AegisError("INVALID_STATE", `history 中存在重複 eventId：${eventId}。`);
      seen.add(eventId);
      if (!text(raw.type)) throw new AegisError("INVALID_STATE", `history.${channel}[${index}].type 必須存在。`);
      if (typeof raw.revision !== "number" || !Number.isInteger(raw.revision) || raw.revision < 0 || raw.revision > state.revision) {
        throw new AegisError("INVALID_STATE", `history.${channel}[${index}].revision 無效。`);
      }
      const gameTime = raw.gameTime;
      if (!isObject(gameTime) || typeof gameTime.year !== "number" || typeof gameTime.monthId !== "string" ||
        typeof gameTime.day !== "number" || typeof gameTime.minuteOfDay !== "number") {
        throw new AegisError("INVALID_STATE", `history.${channel}[${index}].gameTime 無效。`);
      }
    }
  }
}

export function newHistoryEvent(type: string, fields: JsonObject = {}): JsonObject {
  return { type, ...structuredClone(fields) };
}

export function formatHistoryEvent(raw: JsonValue): string {
  if (!isObject(raw)) return "發生了一項尚未分類的事件。";
  const summary = text(raw.summary) || text(raw.reason);
  switch (text(raw.type)) {
    case "general":
      return summary || "發生了一項事件。";
    case "time_elapsed":
      return summary || `經過了${formatMinutes(raw.elapsedMinutes)}。`;
    case "travel": {
      const destination = text(raw.toName) || "目的地";
      return summary || `抵達${destination}，旅程耗時${formatMinutes(raw.actualTravelMinutes)}。`;
    }
    case "item_used":
      return summary || `使用了${text(raw.itemName) || "一項物品"}。`;
    case "survival_changed":
      return summary || "生存狀態發生變化。";
    case "quest_changed":
      return summary || `任務「${text(raw.questName) || "未命名任務"}」已更新。`;
    case "location_discovered":
      return summary || `已發現${text(raw.mapName) || "一處地點"}。`;
    case "npc_met":
      return summary || `遇見了${text(raw.npcName) || "一名人物"}。`;
    case "npc_information_learned":
      return summary || `從${text(raw.npcName) || "一名人物"}得知了新的情報。`;
    case "npc_location_updated":
      return summary || `${text(raw.npcName) || "人物"}的位置情報已更新。`;
    case "compendium_updated":
      return summary || `圖鑑「${text(raw.entryName) || "未命名條目"}」已更新。`;
    case "container_refilled":
      return summary || `已補充${text(raw.itemName) || "容器"}。`;
    case "equipment_changed":
      return summary || `裝備${text(raw.itemName) ? `「${text(raw.itemName)}」` : "狀態"}已更新。`;
    default:
      if (process.env.NODE_ENV !== "production") {
        console.warn(`[AEGIS history] 未知事件類型：${text(raw.type) || "(empty)"}`);
      }
      return "發生了一項尚未分類的事件。";
  }
}

function normalizeEvent(raw: JsonValue, strict: boolean, path: string): JsonObject {
  if (typeof raw === "string") {
    const summary = raw.trim();
    if (!summary) throw new AegisError(strict ? "INVALID_DIFF" : "INVALID_STATE", `${path} 不可為空白事件。`);
    return { type: "general", summary: summary.slice(0, 500) };
  }
  if (!isObject(raw)) {
    throw new AegisError(strict ? "INVALID_DIFF" : "INVALID_STATE", `${path} 必須是事件物件或舊版文字事件。`);
  }
  const result = structuredClone(raw);
  const rawType = text(result.type);
  const type = LEGACY_TYPE_ALIASES[rawType] ?? rawType;
  if (!type) {
    if (strict) throw new AegisError("INVALID_DIFF", `${path}.type 必須存在。`);
    result.type = "general";
    result.summary = legacySummary(result);
    return result;
  }
  if (!HISTORY_EVENT_TYPES.has(type)) {
    if (strict) throw new AegisError("INVALID_DIFF", `${path}.type 不是允許的歷史事件類型。`);
    result.type = type;
    return result;
  }
  result.type = type;
  if (typeof result.summary === "string") result.summary = result.summary.trim().slice(0, 500);
  if (typeof result.reason === "string") result.reason = result.reason.trim().slice(0, 500);
  return result;
}

function allEvents(state: GameState): Map<string, JsonObject> {
  const result = new Map<string, JsonObject>();
  for (const values of Object.values(state.history)) {
    for (const raw of values) {
      if (isObject(raw) && text(raw.eventId)) result.set(text(raw.eventId), raw);
    }
  }
  return result;
}

function deterministicEventId(
  gameId: string,
  seed: string,
  channel: string,
  index: number,
  event: JsonObject,
): string {
  const hash = createHash("sha256")
    .update(`${gameId}:${seed}:${channel}:${index}:${JSON.stringify(event)}`)
    .digest("hex")
    .slice(0, 24);
  return `event-${hash}`;
}

function legacySummary(value: JsonObject): string {
  for (const key of ["summary", "reason", "text", "message", "title"] as const) {
    const candidate = text(value[key]);
    if (candidate) return candidate.slice(0, 500);
  }
  return "發生了一項尚未分類的事件。";
}

function formatMinutes(value: JsonValue | undefined): string {
  const minutes = typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours && remainder) return `${hours} 小時 ${remainder} 分鐘`;
  if (hours) return `${hours} 小時`;
  return `${remainder} 分鐘`;
}

function text(value: JsonValue | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
