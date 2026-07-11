import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AppConfig } from "./config.js";
import { createAegisMcpServer } from "./mcp/server.js";
import type { AegisService } from "./service.js";
import type { GameStore } from "./storage/store.js";

const MCP_PATH = "/mcp";

export async function startHttpServer(
  config: AppConfig,
  service: AegisService,
  store: GameStore,
) {
  const widgetHtml = await readFile(join(config.publicDir, "aegis-widget.html"), "utf8");

  const server = createServer(async (req, res) => {
    if (!req.url) return sendText(res, 400, "Missing URL");
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/healthz")) {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, service: "aegis-rpg", version: "0.1.0" }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/admin") {
      try {
        const html = await readFile(join(config.legacyDir, "aegis_companion_v6_7_7.html"), "utf8");
        res.writeHead(200, securityHeaders("text/html; charset=utf-8"));
        res.end(html);
      } catch {
        sendText(res, 404, "Admin console not installed");
      }
      return;
    }
    if (req.method === "OPTIONS" && url.pathname.startsWith(MCP_PATH)) {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "content-type, mcp-session-id, mcp-protocol-version",
        "Access-Control-Expose-Headers": "Mcp-Session-Id",
      });
      res.end();
      return;
    }

    const mcpMethods = new Set(["POST", "GET", "DELETE"]);
    if (url.pathname === MCP_PATH && req.method && mcpMethods.has(req.method)) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
      const mcpServer = createAegisMcpServer(service, widgetHtml);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void mcpServer.close();
      });
      try {
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res);
      } catch (error) {
        console.error("MCP request failed", error);
        if (!res.headersSent) sendText(res, 500, "Internal server error");
      }
      return;
    }

    sendText(res, 404, "Not Found");
  });

  await new Promise<void>((resolve) => server.listen(config.port, "0.0.0.0", resolve));
  console.log(`AEGIS MCP server listening on http://0.0.0.0:${config.port}${MCP_PATH}`);

  const shutdown = async () => {
    server.close();
    await store.close();
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  return server;
}

function securityHeaders(contentType: string) {
  return {
    "content-type": contentType,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "SAMEORIGIN",
  };
}

function sendText(
  res: import("node:http").ServerResponse,
  status: number,
  message: string,
): void {
  res.writeHead(status, securityHeaders("text/plain; charset=utf-8"));
  res.end(message);
}
