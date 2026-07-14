import { describe, expect, it } from "vitest";
import { defaultGameState, migrateGameState, toGameView, MIGRATION_KEY } from "../src/domain/default-state.js";
import { applyStateDiff } from "../src/domain/diff.js";

const options = (key: string) => ({
  maxDiffBytes: 512 * 1024,
  maxStateBytes: 2 * 1024 * 1024,
  idempotencyKey: key,
});

function discoveryDiff() {
  return {
    player: {
      initialized: true,
      name: "探索者",
      location: { mapId: "place-grove", region: "霧林", location: "月苔林地" },
    },
    map: [
      { mapId: "region-mist", name: "霧林", kind: "region", discovery: "known" },
      {
        mapId: "place-grove", name: "月苔林地", kind: "place", parentMapId: "region-mist", discovery: "visited",
        routes: [{
          routeId: "route-back", toMapId: "region-mist", estimatedTravel: "約一小時", danger: "moderate",
          conditions: ["雨季泥濘"], requirements: ["步行可達"],
        }],
        facilities: [{ facilityId: "spring-1", name: "林間泉水", type: "water_source" }],
        references: { npcIds: ["npc-herbalist"], compendiumIds: ["entry-moonmoss"], questIds: [] },
      },
    ],
    npcs: [{
      npcId: "npc-herbalist", name: "芙蘿", identity: "採藥人", familiarity: "met", relationship: "初識",
      location: { mapId: "place-grove", name: "月苔林地", status: "current", observedAtTick: 1 },
      knownInformation: [{
        infoId: "info-moss", text: "她正在尋找月光苔", confidence: "high",
        source: { type: "observation", name: "親眼所見", mapId: "place-grove" }, learnedAtTick: 1,
      }],
      services: [{ serviceId: "service-herbs", name: "辨識藥草", type: "identification" }],
      questIds: [],
      memories: [{ memoryId: "memory-first-meeting", summary: "在林間首次交談", tick: 1, importance: "important" }],
    }],
    compendium: [{
      entryId: "entry-moonmoss", name: "月光苔", category: "plant", stage: "observed", confidence: "medium",
      description: "夜間泛出微光的苔蘚。", knownFacts: ["生長於潮濕岩面"],
      sources: [{ type: "observation", name: "月苔林地的岩壁", obtainedAtTick: 1, mapId: "place-grove" }],
      relatedMapIds: ["place-grove"], relatedNpcIds: ["npc-herbalist"], questIds: [], tags: ["發光植物"],
    }],
  };
}

describe("player-known map, people, and compendium state", () => {
  it("commits location, NPC, and knowledge atomically in one revision and exposes only the player view", () => {
    const result = applyStateDiff(defaultGameState("main"), discoveryDiff(), options("discover-grove"));
    expect(result.game.revision).toBe(1);
    expect(result.changedPaths).toEqual(expect.arrayContaining(["player.location", "map", "npcs", "compendium"]));
    expect(result.game.map).toHaveLength(2);
    expect(result.game.npcs[0]).toMatchObject({ npcId: "npc-herbalist", familiarity: "met" });
    expect(result.game.compendium[0]).toMatchObject({ entryId: "entry-moonmoss", stage: "observed" });
    expect(toGameView(result.game)).toMatchObject({
      revision: 1,
      map: [{ mapId: "region-mist" }, { mapId: "place-grove" }],
      npcs: [{ npcId: "npc-herbalist" }],
      compendium: [{ entryId: "entry-moonmoss" }],
    });
  });

  it("rejects NPC secrets, transcripts, duplicate identifiers, invalid compendium kinds, and unknown references", () => {
    const base = defaultGameState("main");
    expect(() => applyStateDiff(base, {
      npcs: [{ npcId: "npc-1", name: "陌生人", familiarity: "heard", secrets: ["真實身份"] }],
    }, options("secret"))).toThrow(/禁止保存/);

    expect(() => applyStateDiff(base, {
      npcs: [{ npcId: "npc-1", name: "陌生人", familiarity: "met", dialogueTranscript: "完整逐字稿" }],
    }, options("transcript"))).toThrow(/逐字稿/);

    expect(() => applyStateDiff(base, {
      map: [
        { mapId: "same", name: "甲地", kind: "place", discovery: "known" },
        { mapId: "same", name: "乙地", kind: "place", discovery: "heard" },
      ],
    }, options("duplicate"))).toThrow(/重複 mapId/);

    expect(() => applyStateDiff(base, {
      compendium: [{
        entryId: "person-entry", name: "某人", category: "person", stage: "rumor", confidence: "low",
        sources: [{ type: "rumor", name: "酒館傳聞" }],
      }],
    }, options("person-entry"))).toThrow(/category/);

    expect(() => applyStateDiff(base, {
      map: [{
        mapId: "place-1", name: "孤地", kind: "place", discovery: "heard",
        routes: [{ routeId: "missing-route", toMapId: "unknown-place" }],
      }],
    }, options("unknown-route"))).toThrow(/尚未得知/);
  });

  it("migrates legacy player knowledge into safe typed records without carrying secrets or completion flags", () => {
    const legacy = defaultGameState("legacy");
    legacy.schemaVersion = "6.7.7-mcp.5.2";
    legacy.version = "6.7.7-mcp.5.2";
    delete (legacy.engine.migrations as Record<string, unknown>)[MIGRATION_KEY];
    legacy.map = [{ id: "old-map", name: "舊村", visited: true, progress: 90 }];
    legacy.npcs = [{ id: "old-npc", name: "舊居民", affinity: 20, secret: "不可顯示", transcript: "逐字稿" }];
    legacy.compendium = [{ id: "old-entry", name: "舊傳聞", unlocked: true, playerNotes: "舊筆記" }];
    const migrated = migrateGameState(legacy);
    expect(migrated.map[0]).toMatchObject({ mapId: "old-map", name: "舊村", kind: "place", discovery: "visited" });
    expect(migrated.npcs[0]).toMatchObject({
      npcId: "old-npc", name: "舊居民", familiarity: "met", relationship: { label: "既有關係紀錄 20" },
    });
    expect(migrated.compendium[0]).toMatchObject({
      entryId: "old-entry", name: "舊傳聞", category: "other", categoryLabel: "其他", stage: "identified", facts: [],
    });
    expect(JSON.stringify(migrated)).not.toContain("不可顯示");
    expect(JSON.stringify(migrated)).not.toContain("逐字稿");
    expect(JSON.stringify(migrated)).not.toContain("progress");
  });
});
