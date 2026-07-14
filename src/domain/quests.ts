import { createHash } from "node:crypto";
import { AegisError } from "./errors.js";
import type { GameState, JsonObject, JsonValue } from "./types.js";

export function normalizeQuestState(
  state: GameState,
  strict: boolean,
  code: "INVALID_DIFF" | "INVALID_STATE" = strict ? "INVALID_DIFF" : "INVALID_STATE",
): void {
  const aliases = new Map<string, string>();
  const seen = new Set<string>();
  state.quests = state.quests.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new AegisError(code, `quests[${index}] 必須是物件。`);
    }
    const quest = structuredClone(raw);
    const legacyId = text(quest.id);
    const name = text(quest.name) || text(quest.title);
    const questId = text(quest.questId) || legacyId || stableQuestId(state.gameId, index, quest);
    if (!questId) throw new AegisError(code, `quests[${index}].questId 必須是非空字串。`);
    if (!name) throw new AegisError(code, `quests[${index}].name 必須是非空字串。`);
    if (seen.has(questId)) {
      throw new AegisError(code, `quests 中存在重複 questId：${questId}。`);
    }
    seen.add(questId);
    quest.questId = questId;
    quest.name = name;
    if (legacyId) aliases.set(legacyId, questId);
    aliases.set(name, questId);
    return quest;
  });
  if (!strict) rewriteLegacyQuestReferences(state, aliases);
}

export function validateQuestState(state: GameState): void {
  normalizeQuestState(state, true, "INVALID_STATE");
}

export function validateQuestReferences(
  state: GameState,
  code: "INVALID_DIFF" | "INVALID_STATE" = "INVALID_STATE",
): void {
  const questIds = new Set(state.quests.map((quest) => text(quest.questId)));
  for (const map of state.map) {
    const refs = object(map.references);
    assertQuestRefs(refs.questIds, questIds, `地點 ${text(map.mapId)}`, code);
  }
  for (const npc of state.npcs) {
    assertQuestRefs(npc.questIds, questIds, `人物 ${text(npc.npcId)}`, code);
  }
  for (const entry of state.compendium) {
    assertQuestRefs(entry.questIds, questIds, `圖鑑 ${text(entry.entryId)}`, code);
  }
}

function rewriteLegacyQuestReferences(state: GameState, aliases: Map<string, string>): void {
  for (const map of state.map) {
    const refs = object(map.references);
    if (Array.isArray(refs.questIds)) refs.questIds = rewrite(refs.questIds, aliases);
    if (Object.keys(refs).length) map.references = refs;
  }
  for (const npc of state.npcs) {
    if (Array.isArray(npc.questIds)) npc.questIds = rewrite(npc.questIds, aliases);
  }
  for (const entry of state.compendium) {
    if (Array.isArray(entry.questIds)) entry.questIds = rewrite(entry.questIds, aliases);
  }
}

function rewrite(values: JsonValue[], aliases: Map<string, string>): string[] {
  return values
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => aliases.get(value.trim()) ?? value.trim());
}

function assertQuestRefs(
  raw: JsonValue | undefined,
  known: Set<string>,
  label: string,
  code: "INVALID_DIFF" | "INVALID_STATE",
): void {
  if (raw === undefined) return;
  if (!Array.isArray(raw) || raw.some((value) => typeof value !== "string" || !value.trim())) {
    throw new AegisError(code, `${label} 的 questIds 必須是非空字串陣列。`);
  }
  for (const value of raw) {
    const id = String(value);
    if (!known.has(id)) throw new AegisError(code, `${label} 引用了未知 questId：${id}。`);
  }
}

function stableQuestId(gameId: string, index: number, quest: JsonObject): string {
  const hash = createHash("sha256")
    .update(`${gameId}:quest:${index}:${JSON.stringify(quest)}`)
    .digest("hex")
    .slice(0, 20);
  return `quest-${hash}`;
}

function text(value: JsonValue | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function object(value: JsonValue | undefined): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? structuredClone(value) : {};
}
