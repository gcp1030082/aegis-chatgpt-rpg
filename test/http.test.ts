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
    expect(await health.json()).toMatchObject({ ok: true, version: "0.3.0" });

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

    for (const version of ["v1", "v2", "v3"]) {
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
    }

    const toolsList = await fetch(`${origin}/mcp/aegis_http_secret_123456`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
    });
    const toolsPayload = (await toolsList.json()) as { result?: { tools?: Array<{ name?: string }> } };
    const names = toolsPayload.result?.tools?.map((tool) => tool.name) ?? [];
    expect(names).toHaveLength(13);
    expect(names).toEqual(expect.arrayContaining([
      "aegis_reset_player",
      "aegis_advance_time",
      "aegis_apply_survival_event",
      "aegis_use_item",
      "aegis_refill_container",
    ]));
  });
});
