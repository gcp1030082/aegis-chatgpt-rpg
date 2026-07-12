import { describe, expect, it } from "vitest";
import { DEFAULT_MCP_PATH, loadConfig, mcpEndpointPath } from "../src/config.js";

describe("deployment configuration", () => {
  it("uses the public development path and disables legacy admin by default", () => {
    const config = loadConfig({});
    expect(mcpEndpointPath(config)).toBe(DEFAULT_MCP_PATH);
    expect(config.enableLegacyAdmin).toBe(false);
  });

  it("places a valid secret in the MCP path", () => {
    const config = loadConfig({
      AEGIS_MCP_PATH_SECRET: "aegis_test_secret_123456",
      AEGIS_ENABLE_LEGACY_ADMIN: "true",
    });
    expect(mcpEndpointPath(config)).toBe("/mcp/aegis_test_secret_123456");
    expect(config.enableLegacyAdmin).toBe(true);
  });

  it("rejects unsafe path secrets", () => {
    expect(() => loadConfig({ AEGIS_MCP_PATH_SECRET: "too short" })).toThrow(
      /AEGIS_MCP_PATH_SECRET/,
    );
  });
});
