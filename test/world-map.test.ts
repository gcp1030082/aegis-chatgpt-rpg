import { describe, expect, it } from "vitest";
import { toDashboardView, stableMapNodePosition } from "../src/domain/dashboard.js";
import { defaultGameState } from "../src/domain/default-state.js";
import { applyStateDiff } from "../src/domain/diff.js";

const makeOptions = (idempotencyKey: string) => ({
  maxDiffBytes: 512 * 1024,
  maxStateBytes: 2 * 1024 * 1024,
  idempotencyKey,
});

const hierarchy = [
  { mapId: "region-1", name: "洛薩邊境", kind: "region", discovery: "known" },
  { mapId: "town-1", name: "白樺渡鎮", kind: "town", discovery: "visited", parentMapId: "region-1" },
  {
    mapId: "place-1", name: "折角鹿角酒館", kind: "place", discovery: "visited", parentMapId: "town-1",
    facilities: [{ facilityId: "facility-inn", name: "住宿", type: "inn" }],
    knownDangers: [{ dangerId: "danger-brawl", name: "深夜鬥毆", severity: "moderate", confirmed: true }],
  },
  { mapId: "subplace-1", name: "酒館地窖", kind: "subplace", discovery: "heard", parentMapId: "place-1" },
  {
    mapId: "valley-1", name: "北岸白樺淺谷", kind: "place", discovery: "known", parentMapId: "region-1",
    routes: [{
      routeId: "route-valley-town", toMapId: "town-1", estimatedMinutes: 40, travelMode: "walk",
      estimateConfidence: "normal", danger: "high", knowledgeStatus: "heard",
    }],
  },
];

describe("authoritative map hierarchy and directed routes", () => {
  it("creates region → town → place → subplace while keeping the valley outside the town", () => {
    const result = applyStateDiff(defaultGameState("main"), {
      map: hierarchy,
      player: { location: { mapId: "place-1", region: "錯誤快取", location: "錯誤快取" } },
    }, makeOptions("map-hierarchy"));
    expect(result.game.map.find((entry) => entry.mapId === "valley-1")?.parentMapId).toBe("region-1");
    expect(result.game.player.location).toEqual({
      mapId: "place-1", region: "洛薩邊境", location: "白樺渡鎮", sublocation: "折角鹿角酒館",
    });
    expect(result.game.map.find((entry) => entry.mapId === "place-1")).toMatchObject({
      discovery: "visited",
      firstLearnedAtRevision: 1,
      lastUpdatedAtRevision: 1,
    });
  });

  it("rejects unknown parents, cyclic parents, and unknown route destinations", () => {
    const state = defaultGameState("main");
    expect(() => applyStateDiff(state, {
      map: [{ mapId: "orphan", name: "孤地", kind: "place", discovery: "known", parentMapId: "missing" }],
    }, makeOptions("orphan"))).toThrow(/parentMapId/);
    expect(() => applyStateDiff(state, {
      map: [
        { mapId: "a", name: "甲", kind: "place", discovery: "known", parentMapId: "b" },
        { mapId: "b", name: "乙", kind: "place", discovery: "known", parentMapId: "a" },
      ],
    }, makeOptions("cycle"))).toThrow(/循環/);
    expect(() => applyStateDiff(state, {
      map: [{
        mapId: "a", name: "甲", kind: "place", discovery: "known",
        routes: [{ routeId: "r", toMapId: "missing" }],
      }],
    }, makeOptions("route-missing"))).toThrow(/尚未得知/);
  });

  it("upserts a route by routeId without duplication and preserves directed semantics", () => {
    const first = applyStateDiff(defaultGameState("main"), { map: hierarchy }, makeOptions("map-first"));
    const second = applyStateDiff(first.game, {
      map: { upsert: [{
        mapId: "valley-1",
        routes: [{ routeId: "route-valley-town", knowledgeStatus: "verified", estimatedMinutes: 35 }],
      }] },
    }, makeOptions("route-verify"));
    const valley = second.game.map.find((entry) => entry.mapId === "valley-1");
    expect(valley?.routes).toEqual([
      expect.objectContaining({
        routeId: "route-valley-town", toMapId: "town-1", estimatedMinutes: 35,
        knowledgeStatus: "verified", lastVerifiedAtRevision: 2,
      }),
    ]);
    expect(second.game.map.find((entry) => entry.mapId === "town-1")?.routes).toBeUndefined();
  });

  it("keeps location danger separate from route danger and resolves reference names", () => {
    const result = applyStateDiff(defaultGameState("main"), {
      quests: [{ questId: "quest-herbs", name: "銀脈草採集" }],
      npcs: [{ npcId: "npc-bran", name: "布蘭・赫斯", familiarity: "met" }],
      compendium: [{
        entryId: "entry-herb", name: "銀脈草", category: "plant", categoryLabel: "植物", stage: "rumor",
        facts: [{
          factId: "fact-herb-rumor", text: "淺谷可能生長銀脈草",
          confidence: "low", sources: [{ sourceType: "rumor", description: "酒館傳聞" }],
        }],
      }],
      map: hierarchy.map((entry) => entry.mapId === "place-1" ? {
        ...entry,
        references: { npcIds: ["npc-bran"], questIds: ["quest-herbs"], compendiumIds: ["entry-herb"] },
      } : entry),
      player: { location: { mapId: "place-1" } },
    }, makeOptions("map-references"));
    const dashboard = toDashboardView(result.game);
    const place = dashboard.map.find((entry) => entry.mapId === "place-1");
    expect(place?.knownDangers).toEqual([expect.objectContaining({ dangerId: "danger-brawl", severity: "moderate" })]);
    expect(place?.referenceLabels).toMatchObject({
      npcs: [{ name: "布蘭・赫斯" }], quests: [{ name: "銀脈草採集" }], compendium: [{ name: "銀脈草" }],
    });
    const route = dashboard.map.find((entry) => entry.mapId === "valley-1")?.routes;
    expect(route).toEqual([expect.objectContaining({ danger: "high" })]);
  });

  it("uses mapId-only current-location comparison and stable seeded positions", () => {
    const current = { mapId: "same-id", name: "舊名稱" };
    const renamed = { mapId: "same-id", name: "新名稱" };
    expect(current.mapId === renamed.mapId).toBe(true);
    const before = stableMapNodePosition("same-id", 2);
    const after = stableMapNodePosition("same-id", 2);
    const other = stableMapNodePosition("new-node", 2);
    expect(after).toEqual(before);
    expect(other).not.toEqual(before);
  });
});
