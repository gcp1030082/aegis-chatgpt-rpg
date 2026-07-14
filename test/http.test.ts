import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { startHttpServer } from "../src/http.js";
import { AegisService } from "../src/service.js";
import { FileGameStore } from "../src/storage/file-store.js";

describe("production HTTP surface", () => {
  let directory: string;
  let origin: string;
  let server: Awaited<ReturnType<typeof startHttpServer>>;
  let store: FileGameStore;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "aegis-http-"));
    store = new FileGameStore(directory);
    await store.initialize();
    const config: AppConfig = {
      port: 0,
      storageDriver: "file",
      dataDir: directory,
      databaseUrl: undefined,
      databaseSsl: false,
      mcpPathSecret: "aegis_http_secret_123456",
      enableLegacyAdmin: false,
      maxStateBytes: 2 * 1024 * 1024,
      maxDiffBytes: 512 * 1024,
      publicDir: resolve("public"),
      legacyDir: resolve("legacy"),
    };
    const service = new AegisService(store, config);
    server = await startHttpServer(config, service, store);
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolveClose, reject) => {
      server.close((error) => (error ? reject(error) : resolveClose()));
    });
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("keeps legacy admin and the unprotected MCP path closed", async () => {
    expect((await fetch(`${origin}/admin`)).status).toBe(404);
    expect((await fetch(`${origin}/mcp`, { method: "OPTIONS" })).status).toBe(404);
  });

  it("serves health and initializes MCP on the secret path", async () => {
    const health = await fetch(`${origin}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, version: "0.5.2" });

    const healthWithTrailingSlash = await fetch(`${origin}/healthz/`);
    expect(healthWithTrailingSlash.status).toBe(200);
    expect(await healthWithTrailingSlash.json()).toMatchObject({ ok: true });

    const options = await fetch(`${origin}/mcp/aegis_http_secret_123456/`, {
      method: "OPTIONS",
    });
    expect(options.status).toBe(204);

    const initialized = await fetch(`${origin}/mcp/aegis_http_secret_123456`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "aegis-test", version: "1.0" },
        },
      }),
    });
    expect(initialized.status).toBe(200);
    const payload = (await initialized.json()) as { result?: { serverInfo?: { name?: string } } };
    expect(payload.result?.serverInfo?.name).toBe("aegis-rpg");

    for (const version of ["v1", "v2", "v3", "v4", "v5", "v6"]) {
      const uri = `ui://widget/aegis-dashboard-${version}.html`;
      const dashboardResource = await fetch(`${origin}/mcp/aegis_http_secret_123456`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: version, method: "resources/read", params: { uri } }),
      });
      expect(dashboardResource.status).toBe(200);
      const resourcePayload = (await dashboardResource.json()) as {
        result?: { contents?: Array<{ uri?: string; text?: string }> };
      };
      expect(resourcePayload.result?.contents?.[0]?.uri).toBe(uri);
      expect(resourcePayload.result?.contents?.[0]?.text).toContain('data-inventory-category="special"');
      expect(resourcePayload.result?.contents?.[0]?.text).toContain("飽食度");
      expect(resourcePayload.result?.contents?.[0]?.text).toContain('data-tab="map"');
      expect(resourcePayload.result?.contents?.[0]?.text).toContain('data-tab="people"');
      expect(resourcePayload.result?.contents?.[0]?.text).toContain('data-tab="compendium"');
    }

    const toolsList = await fetch(`${origin}/mcp/aegis_http_secret_123456`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
    });
    const toolsPayload = (await toolsList.json()) as {
      result?: { tools?: Array<{
        name?: string;
        description?: string;
        inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
        _meta?: Record<string, unknown>;
      }> };
    };
    const names = toolsPayload.result?.tools?.map((tool) => tool.name) ?? [];
    expect(names).toHaveLength(12);
    expect(names).toEqual(expect.arrayContaining([
      "aegis_reset_player",
      "aegis_advance_time",
      "aegis_apply_survival_event",
      "aegis_use_item",
      "aegis_refill_container",
      "aegis_equip_item",
      "aegis_unequip_item",
    ]));
    expect(names).not.toEqual(expect.arrayContaining([
      "aegis_create_save", "aegis_list_saves", "aegis_load_save",
    ]));
    for (const tool of toolsPayload.result?.tools ?? []) {
      if (tool.name === "aegis_show_dashboard") {
        expect(tool._meta?.["openai/outputTemplate"]).toBe("ui://widget/aegis-dashboard-v6.html");
        expect(tool.inputSchema?.properties).toHaveProperty("turn_id");
        expect(tool.inputSchema?.required).toContain("game_id");
        expect(tool.inputSchema?.required).not.toContain("turn_id");
      } else {
        expect(tool._meta?.["openai/outputTemplate"]).toBeUndefined();
      }
      expect(tool.description).toMatch(/[㐀-鿿]/u);
    }

    const callTool = async (id: number, name: string, args: Record<string, unknown>) => {
      const response = await fetch(`${origin}/mcp/aegis_http_secret_123456`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
      });
      expect(response.status).toBe(200);
      return await response.json() as {
        result?: {
          isError?: boolean;
          structuredContent?: { result?: Record<string, unknown> };
        };
      };
    };

    const created = await callTool(10, "aegis_create_game", { game_id: "ui-flow", title: "介面測試" });
    const createdResult = created.result?.structuredContent?.result as {
      game?: { revision?: number };
      dashboard?: unknown;
    };
    expect(createdResult.game?.revision).toBe(0);
    expect(createdResult.dashboard).toBeUndefined();

    const prepared = await callTool(11, "aegis_prepare_turn", {
      game_id: "ui-flow", player_input: "觀察周圍，不推進時間",
    });
    const preparedResult = prepared.result?.structuredContent?.result as {
      turn?: { revision?: number; turnId?: string };
      dashboard?: unknown;
    };
    expect(preparedResult.turn?.revision).toBe(0);
    expect(preparedResult.turn?.turnId).toMatch(/^[0-9a-f-]{36}$/);
    expect(preparedResult.dashboard).toBeUndefined();

    const committed = await callTool(12, "aegis_apply_state_diff", {
      game_id: "ui-flow", expected_revision: 0, idempotency_key: "ui-turn-1",
      diff: {
        player: {
          initialized: true, name: "測試者", hp: 10, mp: 8, sp: 6,
          location: { mapId: "map-town", region: "北境", location: "白樺鎮" },
        },
        map: [
          { mapId: "map-region", name: "北境", kind: "region", discovery: "known" },
          {
            mapId: "map-town", name: "白樺鎮", kind: "town", parentMapId: "map-region", discovery: "visited",
            facilities: ["旅店"], routes: [{ routeId: "road-1", toMapId: "map-region", danger: "low" }],
          },
        ],
        npcs: [{
          npcId: "npc-guide", name: "路標守衛", identity: "城門守衛", familiarity: "met",
          location: { mapId: "map-town", name: "白樺鎮城門", status: "current" },
          knownInformation: [{ infoId: "info-road", text: "守衛熟悉北方道路", confidence: "medium" }],
          services: ["道路指引"], questIds: [], memories: [],
        }],
        compendium: [{
          entryId: "entry-moss", name: "銀光苔", category: "plant", stage: "rumor", confidence: "low",
          sources: [{ type: "npc", name: "路標守衛", npcId: "npc-guide", mapId: "map-town" }],
          knownFacts: ["據說在潮濕石壁發光"], relatedMapIds: ["map-town"], relatedNpcIds: ["npc-guide"],
        }],
      },
    });
    const committedResult = committed.result?.structuredContent?.result as {
      game?: { revision?: number; player?: { sp?: number }; map?: unknown[]; npcs?: unknown[]; compendium?: unknown[] };
      dashboard?: unknown;
    };
    expect(committedResult.game).toMatchObject({ revision: 1, player: { sp: 6 } });
    expect(committedResult.game?.map).toHaveLength(2);
    expect(committedResult.game?.npcs).toHaveLength(1);
    expect(committedResult.game?.compendium).toHaveLength(1);
    expect(committedResult.dashboard).toBeUndefined();

    const turnId = preparedResult.turn?.turnId;
    if (!turnId) throw new Error("prepare_turn 未回傳 turnId");
    const shown = await callTool(13, "aegis_show_dashboard", { game_id: "ui-flow" });
    const shownResult = shown.result?.structuredContent?.result as {
      dashboard?: { dashboardKey?: string; turnId?: string; game?: { revision?: number; player?: { sp?: number } } };
    };
    expect(shownResult.dashboard).toMatchObject({
      dashboardKey: `ui-flow:${turnId}:1`,
      turnId,
      game: { revision: 1, player: { sp: 6 } },
    });

    const duplicateDashboard = await callTool(14, "aegis_show_dashboard", {
      game_id: "ui-flow", turn_id: turnId,
    });
    expect(duplicateDashboard.result?.isError).toBe(true);
    expect(duplicateDashboard.result?.structuredContent?.result).toMatchObject({
      error: { code: "DASHBOARD_ALREADY_SHOWN" },
    });

    const rejected = await callTool(15, "aegis_apply_state_diff", {
      game_id: "ui-flow", expected_revision: 1, idempotency_key: "ui-no-op",
      diff: { inventory: [], quests: [] },
    });
    expect(rejected.result?.isError).toBe(true);
    expect(rejected.result?.structuredContent?.result).not.toHaveProperty("dashboard");
  });
});
