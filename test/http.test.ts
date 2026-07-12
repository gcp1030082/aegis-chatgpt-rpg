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
    expect(await health.json()).toMatchObject({ ok: true, version: "0.2.0" });

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
  });
});
