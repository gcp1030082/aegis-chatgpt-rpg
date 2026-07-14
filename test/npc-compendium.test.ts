import { describe, expect, it } from "vitest";
import { toDashboardView } from "../src/domain/dashboard.js";
import { buildGameMigration, defaultGameState, MIGRATION_KEY, toGameView } from "../src/domain/default-state.js";
import { applyStateDiff } from "../src/domain/diff.js";
import type { JsonObject } from "../src/domain/types.js";

const options = (idempotencyKey: string) => ({
  maxDiffBytes: 512 * 1024,
  maxStateBytes: 2 * 1024 * 1024,
  idempotencyKey,
});

function publicKnowledgeState() {
  return applyStateDiff(defaultGameState("knowledge"), {
    player: { location: { mapId: "map-town" } },
    map: [
      { mapId: "map-region", name: "洛薩邊境", kind: "region", discovery: "known" },
      { mapId: "map-town", name: "白樺渡鎮", kind: "town", discovery: "visited", parentMapId: "map-region" },
      { mapId: "map-valley", name: "北岸淺谷", kind: "place", discovery: "known", parentMapId: "map-region" },
    ],
    quests: [{ questId: "quest-herb", name: "銀脈草採集", status: "active" }],
    npcs: [{
      npcId: "npc-bran", name: "布蘭・赫斯", identity: "採集嚮導", familiarity: "acquainted",
      relationship: { label: "合作過一次", tags: ["嚮導"] },
      location: { mapId: "map-town", status: "current" },
      knownInformation: [{
        infoId: "info-valley", content: "淺谷東側較安全", confidence: "medium",
        sourceType: "npc", sourceId: "npc-bran",
      }],
      services: [{ serviceId: "service-guide", name: "道路指引" }],
      memories: [{ memoryId: "memory-first", summary: "曾在北門提供路線建議", importance: "important" }],
      questIds: ["quest-herb"],
    }],
    compendium: [{
      entryId: "entry-herb", name: "銀脈草", category: "plant", categoryLabel: "植物", stage: "observed",
      summary: "在陰影中泛銀光的草藥", relatedMapIds: ["map-valley"], relatedNpcIds: ["npc-bran"],
      questIds: ["quest-herb"],
      facts: [{
        factId: "fact-glow", text: "葉脈在陰影中泛銀光", confidence: "medium",
        sources: [{ sourceType: "observation", sourceId: "map-valley", description: "親眼觀察" }],
      }],
    }],
  }, options("knowledge-base")).game;
}

describe("public NPC knowledge and private-world boundary", () => {
  it("validates map locations and transitions current → last_known → unknown without stale map data", () => {
    const base = publicKnowledgeState();
    expect(() => applyStateDiff(base, {
      npcs: { upsert: [{ npcId: "npc-bran", location: { mapId: "missing", status: "current" } }] },
    }, options("unknown-npc-location"))).toThrow(/尚未存在/);

    const moved = applyStateDiff(base, {
      player: { location: { mapId: "map-valley" } },
    }, options("player-left-npc")).game;
    expect(moved.npcs[0]?.location).toMatchObject({ mapId: "map-town", status: "last_known", observedAtRevision: 2 });

    const unknown = applyStateDiff(moved, {
      npcs: { upsert: [{ npcId: "npc-bran", location: { status: "unknown" } }] },
    }, options("npc-left-unknown")).game;
    expect(unknown.npcs[0]?.location).toEqual(expect.objectContaining({ status: "unknown" }));
    expect(unknown.npcs[0]?.location).not.toHaveProperty("mapId");
    expect(unknown.npcs[0]?.location).not.toHaveProperty("name");
  });

  it("upserts information, services, and memories by stable ID and enforces memory safety", () => {
    const base = publicKnowledgeState();
    const updated = applyStateDiff(base, {
      npcs: { upsert: [{
        npcId: "npc-bran",
        knownInformation: [{ infoId: "info-valley", content: "淺谷東側已確認較安全", confidence: "high" }],
        services: [{ serviceId: "service-guide", name: "付費道路指引", conditions: "需提前預約" }],
        memories: [{ memoryId: "memory-first", summary: "曾在北門提供並驗證路線建議", importance: "major" }],
      }] },
    }, options("npc-upsert")).game;
    const npc = updated.npcs[0];
    expect(npc?.knownInformation).toHaveLength(1);
    expect(npc?.services).toHaveLength(1);
    expect(npc?.memories).toHaveLength(1);
    expect(npc).toMatchObject({
      knownInformation: [expect.objectContaining({ infoId: "info-valley", confidence: "high" })],
      services: [expect.objectContaining({ serviceId: "service-guide", conditions: "需提前預約" })],
      memories: [expect.objectContaining({ memoryId: "memory-first", importance: "major", createdAtRevision: 1 })],
    });

    expect(() => applyStateDiff(base, {
      npcs: { upsert: [{
        npcId: "npc-bran",
        memories: [{ memoryId: "memory-transcript", summary: "摘要", transcript: "不應保存的完整逐字稿" }],
      }] },
    }, options("npc-transcript"))).toThrow(/逐字稿|私密/);
    expect(() => applyStateDiff(base, {
      npcs: { upsert: [{
        npcId: "npc-bran",
        memories: [{ memoryId: "memory-long", summary: "長".repeat(301) }],
      }] },
    }, options("npc-long-memory"))).toThrow(/300/);
    expect(() => applyStateDiff(base, {
      npcs: { upsert: [{
        npcId: "npc-bran",
        memories: Array.from({ length: 6 }, (_, index) => ({
          memoryId: `memory-new-${index}`, summary: `第 ${index + 1} 項新記憶`, importance: "minor",
        })),
      }] },
    }, options("npc-too-many-memories"))).toThrow(/最多新增 5/);
  });

  it("resolves quest names for the UI and rejects private fields without echoing their value", () => {
    const base = publicKnowledgeState();
    const dashboard = toDashboardView(base);
    expect(dashboard.npcs[0]).toMatchObject({
      questNames: [{ id: "quest-herb", name: "銀脈草採集" }],
      locationSummary: "白樺渡鎮",
    });
    let caught: unknown;
    try {
      applyStateDiff(base, {
        world: { privateState: { passwordLikeSentinel: "NEVER_ECHO_THIS_VALUE" } },
      }, options("private-public-diff"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "INVALID_DIFF" });
    expect(String((caught as Error).message)).not.toContain("NEVER_ECHO_THIS_VALUE");
  });

  it("extracts legacy NPC secrets to separate storage and never exposes true location", () => {
    const legacy = defaultGameState("private-migration");
    markLegacy(legacy);
    legacy.map = [{ mapId: "map-known", name: "已知酒館", kind: "place", discovery: "visited" }];
    legacy.player.location = { mapId: "map-known" };
    legacy.npcs = [{
      id: "npc-secret", name: "旅人", familiarity: "met", location: "已知酒館",
      trueIdentity: "王室密探", trueLocation: "未公開藏身處", hiddenInformation: { target: "玩家" },
    }];
    const migrated = buildGameMigration(legacy);
    expect(migrated.privateWorld.npcs["npc-secret"]).toMatchObject({
      trueIdentity: "王室密探", trueLocation: "未公開藏身處", hiddenInformation: { target: "玩家" },
    });
    expect(migrated.game.npcs[0]).toMatchObject({
      npcId: "npc-secret", name: "旅人", location: { name: "已知酒館", status: "last_known" },
    });
    const publicJson = JSON.stringify({
      game: toGameView(migrated.game),
      dashboard: toDashboardView(migrated.game),
    });
    expect(publicJson).not.toContain("王室密探");
    expect(publicJson).not.toContain("未公開藏身處");
    expect(publicJson).not.toContain("target");
  });
});

describe("progressive compendium facts", () => {
  it("requires sources, deduplicates factId, unions new sources, and only permits forward progress", () => {
    const base = publicKnowledgeState();
    expect(() => applyStateDiff(base, {
      compendium: { upsert: [{
        entryId: "entry-herb",
        facts: [{ factId: "fact-no-source", text: "沒有來源的聲稱", confidence: "low" }],
      }] },
    }, options("fact-no-source"))).toThrow(/sources/);

    const identified = applyStateDiff(base, {
      compendium: { upsert: [{
        entryId: "entry-herb", stage: "identified",
        facts: [{
          factId: "fact-glow", confidence: "high",
          sources: [{ sourceType: "skill", sourceId: "skill-herbalism", description: "草藥辨識" }],
        }],
      }] },
    }, options("fact-progress")).game;
    const fact = (identified.compendium[0]?.facts as JsonObject[])[0];
    expect(identified.compendium[0]?.stage).toBe("identified");
    expect(fact).toMatchObject({
      factId: "fact-glow", confidence: "high", firstLearnedAtRevision: 1, lastUpdatedAtRevision: 2,
    });
    expect(fact?.sources).toHaveLength(2);

    expect(() => applyStateDiff(identified, {
      compendium: { upsert: [{ entryId: "entry-herb", stage: "rumor" }] },
    }, options("fact-stage-regression"))).toThrow(/不得倒退/);
    expect(() => applyStateDiff(identified, {
      compendium: { upsert: [{
        entryId: "entry-herb",
        facts: [{ factId: "fact-glow", confidence: "low", sources: [{ sourceType: "rumor", description: "傳聞" }] }],
      }] },
    }, options("fact-confidence-regression"))).toThrow(/不得倒退/);
  });

  it("reveals a bounded number of facts according to the player's knowledge stage", () => {
    const state = defaultGameState("rumor-view");
    const facts = Array.from({ length: 8 }, (_, index) => ({
      factId: `fact-${index}`, text: `玩家知識 ${index}`, confidence: "low",
      sources: [{ sourceType: "rumor", description: `傳聞 ${index}` }],
    }));
    const rumor = applyStateDiff(state, {
      compendium: [{
        entryId: "entry-rumor", name: "霧獸", category: "creature", categoryLabel: "生物",
        stage: "rumor", facts,
      }],
    }, options("rumor-facts")).game;
    expect((toDashboardView(rumor).compendium[0]?.facts as JsonObject[])).toHaveLength(1);
    const researched = applyStateDiff(rumor, {
      compendium: { upsert: [{ entryId: "entry-rumor", stage: "researched" }] },
    }, options("researched-facts")).game;
    expect((toDashboardView(researched).compendium[0]?.facts as JsonObject[])).toHaveLength(8);
  });
});

function markLegacy(state: ReturnType<typeof defaultGameState>): void {
  state.schemaVersion = "6.7.7-mcp.5.2";
  state.version = "6.7.7-mcp.5.2";
  delete (state.engine.migrations as JsonObject)[MIGRATION_KEY];
}
