import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { DASHBOARD_LIMITS, dashboardPayloadBytes, toDashboardView } from "../src/domain/dashboard.js";
import { defaultGameState } from "../src/domain/default-state.js";
import { applyStateDiff } from "../src/domain/diff.js";

const options = {
  maxDiffBytes: 2 * 1024 * 1024,
  maxStateBytes: 4 * 1024 * 1024,
  idempotencyKey: "large-dashboard",
};

describe("bounded dashboard DTO", () => {
  it("caps large maps, NPCs, compendium, nested details, and history while keeping local context", () => {
    const long = "這是一段用來確認手機面板負載上限的玩家已知資料。".repeat(4);
    const map = [
      { mapId: "map-region", name: "測試區域", kind: "region", discovery: "known" },
      ...Array.from({ length: 99 }, (_, index) => ({
        mapId: `map-${String(index).padStart(3, "0")}`,
        name: `地點 ${index}`,
        kind: "place",
        discovery: index % 4 === 0 ? "heard" : "known",
        parentMapId: "map-region",
        description: long,
        ...(index === 50 ? {
          routes: [{ routeId: "route-current-external", toMapId: "map-098", knowledgeStatus: "known", danger: "high" }],
        } : {}),
      })),
    ];
    const npcs = Array.from({ length: 100 }, (_, index) => ({
      npcId: `npc-${index}`, name: `人物 ${index}`, identity: "旅人", familiarity: "met",
      location: { mapId: `map-${String(index % 99).padStart(3, "0")}`, status: "last_known" },
      knownInformation: Array.from({ length: 12 }, (__, detail) => ({
        infoId: `info-${index}-${detail}`, content: long, confidence: "medium",
      })),
      services: Array.from({ length: 12 }, (__, detail) => ({ serviceId: `service-${index}-${detail}`, name: `服務 ${detail}` })),
      memories: Array.from({ length: 5 }, (__, detail) => ({
        memoryId: `memory-${index}-${detail}`, summary: long.slice(0, 280), importance: "minor",
      })),
    }));
    const compendium = Array.from({ length: 100 }, (_, index) => ({
      entryId: `entry-${index}`, name: `條目 ${index}`, category: "plant", categoryLabel: "植物", stage: "researched",
      summary: long,
      facts: Array.from({ length: 12 }, (__, detail) => ({
        factId: `fact-${index}-${detail}`, text: long, confidence: "confirmed",
        sources: [{ sourceType: "observation", sourceId: `map-${String(index % 99).padStart(3, "0")}`, description: "親眼觀察" }],
      })),
    }));
    const history = Array.from({ length: 50 }, (_, index) => ({ type: "general", summary: `事件 ${index}：${long}` }));
    const game = applyStateDiff(defaultGameState("dashboard-load"), {
      player: { location: { mapId: "map-050" } },
      map,
      npcs,
      compendium,
      history: { append: history },
      world: { notes: long },
    }, options).game;

    const dashboard = toDashboardView(game);
    expect(dashboard.map).toHaveLength(DASHBOARD_LIMITS.mapNodes);
    expect(dashboard.npcs).toHaveLength(DASHBOARD_LIMITS.npcs);
    expect(dashboard.compendium).toHaveLength(DASHBOARD_LIMITS.compendiumEntries);
    expect(dashboard.historyEvents).toHaveLength(DASHBOARD_LIMITS.historyEvents);
    expect(dashboard.mapIndex).toMatchObject({
      currentMapId: "map-050", visibleNodes: 40, totalKnownNodes: 100, maxVisibleNodes: 40, truncated: true,
    });
    expect(dashboard.map.some((entry) => entry.mapId === "map-050")).toBe(true);
    expect(dashboard.map.some((entry) => entry.mapId === "map-region")).toBe(true);
    expect(dashboard.map.some((entry) => entry.mapId === "map-098")).toBe(true);
    for (const npc of dashboard.npcs) {
      expect((npc.knownInformation as unknown[] | undefined)?.length ?? 0).toBeLessThanOrEqual(DASHBOARD_LIMITS.npcInformation);
      expect((npc.services as unknown[] | undefined)?.length ?? 0).toBeLessThanOrEqual(DASHBOARD_LIMITS.npcServices);
      expect((npc.memories as unknown[] | undefined)?.length ?? 0).toBeLessThanOrEqual(DASHBOARD_LIMITS.npcMemories);
    }
    for (const entry of dashboard.compendium) {
      expect((entry.facts as unknown[] | undefined)?.length ?? 0).toBeLessThanOrEqual(DASHBOARD_LIMITS.compendiumFacts);
    }
    expect(JSON.stringify(dashboard.historyEvents)).not.toContain("{\\\"type\\\"");
    expect(dashboard.historyEvents.every((event) => typeof event.displayText === "string")).toBe(true);
    expect(dashboardPayloadBytes(game)).toBeLessThan(900 * 1024);
    expect(dashboardPayloadBytes(game)).toBeLessThan(Buffer.byteLength(JSON.stringify(game), "utf8"));
  });

  it("does not serialize server-only state into the player dashboard", () => {
    const state = defaultGameState("dashboard-private");
    state.engine.internalPrivateSentinel = "PRIVATE_WORLD_MUST_NOT_RENDER";
    expect(JSON.stringify(toDashboardView(state))).not.toContain("PRIVATE_WORLD_MUST_NOT_RENDER");
  });
});

describe("mobile map UI smoke contract", () => {
  it("keeps all map exploration local to the widget and bounds rendered nodes", async () => {
    const html = await readFile("public/aegis-widget.html", "utf8");
    expect(html).toContain('@media (max-width: 560px)');
    expect(html).toContain("touch-action: none");
    expect(html).toContain("mapEntriesCache = entries.slice(0, 40)");
    expect(html).toContain("data-map-view=\"graph\"");
    expect(html).toContain("id=\"map-recenter\"");
    expect(html).toContain("onpointerdown");
    expect(html).toContain("showMapDrawer");
    expect(html).not.toContain("tools/call");
    expect(html).not.toContain("callTool(");
    expect(html).not.toContain("aegis_prepare_turn");
    expect(html).not.toContain("aegis_show_dashboard");
  });
});
