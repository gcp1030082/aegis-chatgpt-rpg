import { resolve } from "node:path";

export interface AppConfig {
  port: number;
  storageDriver: "file" | "postgres";
  dataDir: string;
  databaseUrl: string | undefined;
  databaseSsl: boolean;
  mcpPathSecret: string | undefined;
  enableLegacyAdmin: boolean;
  maxStateBytes: number;
  maxDiffBytes: number;
  publicDir: string;
  legacyDir: string;
}

export const DEFAULT_MCP_PATH = "/mcp";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const storageDriver = env.AEGIS_STORAGE_DRIVER === "postgres" ? "postgres" : "file";
  return {
    port: positiveInteger(env.PORT, 8787),
    storageDriver,
    dataDir: env.AEGIS_DATA_DIR ?? "./data",
    databaseUrl: env.DATABASE_URL,
    databaseSsl: env.DATABASE_SSL === "true",
    mcpPathSecret: pathSecret(env.AEGIS_MCP_PATH_SECRET),
    enableLegacyAdmin: env.AEGIS_ENABLE_LEGACY_ADMIN === "true",
    maxStateBytes: positiveInteger(env.AEGIS_MAX_STATE_BYTES, 2 * 1024 * 1024),
    maxDiffBytes: positiveInteger(env.AEGIS_MAX_DIFF_BYTES, 512 * 1024),
    publicDir: resolve(env.AEGIS_PUBLIC_DIR ?? "./public"),
    legacyDir: resolve(env.AEGIS_LEGACY_DIR ?? "./legacy"),
  };
}

export function mcpEndpointPath(config: Pick<AppConfig, "mcpPathSecret">): string {
  return config.mcpPathSecret
    ? `${DEFAULT_MCP_PATH}/${config.mcpPathSecret}`
    : DEFAULT_MCP_PATH;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function pathSecret(value: string | undefined): string | undefined {
  const secret = value?.trim();
  if (!secret) return undefined;
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(secret)) {
    throw new Error(
      "AEGIS_MCP_PATH_SECRET must be 16-128 URL-safe letters, numbers, underscores, or hyphens.",
    );
  }
  return secret;
}
