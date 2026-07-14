import { AegisError } from "./errors.js";

export const SERVER_MANAGED_KEYS = new Set([
  "firstLearnedAtRevision",
  "firstLearnedAtGameTime",
  "lastUpdatedAtRevision",
  "lastUpdatedAtGameTime",
  "lastVerifiedAtRevision",
  "lastVerifiedAtGameTime",
  "createdAtRevision",
  "createdAtGameTime",
  "observedAtRevision",
  "observedAtGameTime",
  "learnedAtRevision",
  "learnedAtGameTime",
  "revision",
  "gameTime",
]);

const PRIVATE_STATE_KEYS = new Set([
  "secret",
  "secrets",
  "internalSecret",
  "internalSecrets",
  "privateState",
  "privateWorld",
  "privateNotes",
  "hiddenInfo",
  "hiddenInformation",
  "gmNotes",
  "trueIdentity",
  "trueLocation",
  "npcPrivateState",
]);

export function assertNoServerManagedFields(value: unknown, label = "State Diff"): void {
  walk(value, label);
}

export function assertNoPrivateStateFields(value: unknown, label = "玩家可見 State"): void {
  walkPrivate(value, label);
}

function walk(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (SERVER_MANAGED_KEYS.has(key)) {
      throw new AegisError("INVALID_DIFF", `${childPath} 由伺服器管理，不接受直接指定。`);
    }
    const playerRoot = path === "State Diff.player" || path === "outcome_diff.player";
    if (playerRoot && ["clock", "date", "time", "season"].includes(key)) {
      throw new AegisError("INVALID_DIFF", `${childPath} 由權威世界時鐘衍生，不接受直接指定。`);
    }
    walk(child, childPath);
  }
}

function walkPrivate(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkPrivate(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (
      PRIVATE_STATE_KEYS.has(key) ||
      normalized.startsWith("private") ||
      normalized.startsWith("hidden") ||
      normalized.startsWith("secret") ||
      normalized.startsWith("internalsecret")
    ) {
      throw new AegisError("INVALID_DIFF", `${path}.${key} 屬於伺服器私密世界狀態，禁止保存於玩家可見 State。`);
    }
    walkPrivate(child, `${path}.${key}`);
  }
}
