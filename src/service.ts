import { createHash, randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { applyStateDiff } from "./domain/diff.js";
import { cloneState, defaultGameState, defaultPlayerState, migrateGameState, toGameView } from "./domain/default-state.js";
import { AegisError } from "./domain/errors.js";
import { categorizeItem } from "./domain/inventory.js";
import { equipInventoryItem, unequipInventoryItem } from "./domain/equipment.js";
import { prepareTurn } from "./domain/context.js";
import {
  adjustSurvival,
  calculateTimeSurvival,
  survivalPatch,
  survivalSnapshot,
  type SurvivalActivity,
  type SurvivalEnvironment,
} from "./domain/survival.js";
import type { GameState, JsonObject, SaveRecord } from "./domain/types.js";
import { assertGameId, validateGameState } from "./domain/validation.js";
import type { GameStore } from "./storage/store.js";
import { recordAutomaticSave } from "./domain/commit.js";

export class AegisService {
  constructor(
    private readonly store: GameStore,
    private readonly config: Pick<AppConfig, "maxDiffBytes" | "maxStateBytes">,
  ) {}

  async createGame(gameId: string, title?: string): Promise<GameState> {
    assertGameId(gameId);
    const state = defaultGameState(gameId, cleanText(title, 100) || "AEGIS 冒險");
    validateGameState(state, this.config.maxStateBytes);
    return this.store.createGame(state);
  }

  async getGame(gameId: string): Promise<GameState> {
    assertGameId(gameId);
    const stored = await this.store.getGame(gameId);
    const state = stored ? migrateGameState(stored) : null;
    if (!state) throw new AegisError("GAME_NOT_FOUND", `找不到遊戲 ${gameId}。`);
    validateGameState(state, this.config.maxStateBytes);
    return state;
  }

  async prepareTurn(
    gameId: string,
    playerInput: string,
    runtime = "auto",
    actionType = "auto",
  ) {
    const input = cleanText(playerInput, 4000);
    if (!input) throw new AegisError("INVALID_DIFF", "玩家輸入不可為空白。");
    const game = await this.getGame(gameId);
    const turnId = randomUUID();
    await this.store.beginTurn({
      turnId,
      gameId: game.gameId,
      preparedRevision: game.revision,
      preparedAt: new Date().toISOString(),
      dashboardRevision: null,
      dashboardShownAt: null,
    });
    return prepareTurn(game, input, turnId, runtime, actionType);
  }

  async applyDiff(
    gameId: string,
    expectedRevision: number,
    idempotencyKey: string,
    diff: unknown,
    turnSummary?: string,
  ) {
    assertRevision(expectedRevision);
    const key = cleanIdempotencyKey(idempotencyKey);
    const current = await this.getGame(gameId);
    if (hasIdempotencyKey(current, key)) {
      return { game: current, changedPaths: [], idempotentReplay: true };
    }
    if (current.revision !== expectedRevision) {
      throw new AegisError("REVISION_CONFLICT", "遊戲狀態已更新，請重新準備回合。", {
        expectedRevision,
        actualRevision: current.revision,
      });
    }
    const result = applyStateDiff(current, diff, {
      maxDiffBytes: this.config.maxDiffBytes,
      maxStateBytes: this.config.maxStateBytes,
      idempotencyKey: key,
      turnSummary: cleanText(turnSummary, 500) || undefined,
    });
    const game = await this.store.compareAndSwap(gameId, expectedRevision, result.game);
    return { game, changedPaths: result.changedPaths, idempotentReplay: false };
  }

  async createSave(gameId: string, name: string, idempotencyKey: string): Promise<SaveRecord> {
    const state = await this.getGame(gameId);
    const key = cleanIdempotencyKey(idempotencyKey);
    const createdAt = new Date().toISOString();
    const save: SaveRecord = {
      saveId: deterministicSaveId(gameId, key),
      gameId,
      name: cleanText(name, 100) || `Revision ${state.revision}`,
      sourceRevision: state.revision,
      createdAt,
      state: cloneState(state),
    };
    return this.store.createSave(save);
  }

  async resetPlayer(
    gameId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ) {
    assertRevision(expectedRevision);
    const key = cleanIdempotencyKey(idempotencyKey);
    const current = await this.getGame(gameId);
    if (hasIdempotencyKey(current, key)) {
      return { game: current, changedPaths: [], idempotentReplay: true };
    }
    if (current.revision !== expectedRevision) {
      throw new AegisError("REVISION_CONFLICT", "遊戲狀態已更新，請重新確認後重設角色。", {
        expectedRevision,
        actualRevision: current.revision,
      });
    }

    const next = cloneState(current);
    next.player = defaultPlayerState();
    next.inventory = [];
    next.quests = [];
    next.history = { recent: [], major: [], summary: [] };
    next.npcs = [];
    next.map = [];
    next.compendium = [];
    const changedPaths = resetChangedPaths(current, next);
    if (changedPaths.length === 0) {
      throw new AegisError("NO_STATE_CHANGE", "玩家資料已是未初始化狀態，沒有需要重設的內容。", {
        changedPaths: [],
      });
    }
    next.revision = current.revision + 1;
    next.updatedAt = new Date().toISOString();
    next.engine.transactionLog = [];
    recordAutomaticSave(next, key, "Player reset", changedPaths);
    validateGameState(next, this.config.maxStateBytes);
    const game = await this.store.compareAndSwap(gameId, expectedRevision, next);
    return {
      game,
      changedPaths,
      idempotentReplay: false,
    };
  }

  async advanceTime(
    gameId: string,
    expectedRevision: number,
    idempotencyKey: string,
    hours: number,
    activity: SurvivalActivity,
    environment: SurvivalEnvironment,
    reason: string,
    extraHungerCost = 0,
    extraHydrationCost = 0,
    newDate?: string,
    newTime?: string,
    outcomeDiff?: unknown,
  ) {
    if (!Number.isFinite(hours) || hours <= 0 || hours > 720) {
      throw new AegisError("INVALID_DIFF", "elapsed_hours 必須大於 0 且不得超過 720。 ");
    }
    assertNonnegativeCost(extraHungerCost, "extra_hunger_cost");
    assertNonnegativeCost(extraHydrationCost, "extra_hydration_cost");
    const eventReason = cleanText(reason, 200);
    if (!eventReason) throw new AegisError("INVALID_DIFF", "時間結算必須提供明確原因。");
    const mutation = await this.mutationContext(gameId, expectedRevision, idempotencyKey);
    if (mutation.replay) {
      return {
        game: mutation.current,
        changedPaths: [],
        idempotentReplay: true,
        survival: survivalSnapshot(mutation.current.player),
        hungerCost: 0,
        hydrationCost: 0,
        appliedModifiers: [],
        stageChanges: [],
      };
    }
    const calculation = calculateTimeSurvival(
      mutation.current.player,
      hours,
      activity,
      environment,
      extraHungerCost,
      extraHydrationCost,
      asJsonObject(mutation.current.world.survivalBalance),
    );
    const playerPatch: JsonObject = { survival: survivalPatch(calculation.after) };
    if (cleanText(newDate, 100)) playerPatch.date = cleanText(newDate, 100);
    if (cleanText(newTime, 100)) playerPatch.time = cleanText(newTime, 100);
    const event = {
      type: "time_elapsed",
      reason: eventReason,
      elapsedHours: hours,
      activity,
      environment,
      hungerChange: -calculation.hungerCost,
      hydrationChange: -calculation.hydrationCost,
    };
    const committed = await this.commitGeneratedDiff(
      gameId,
      expectedRevision,
      mutation.key,
      mutation.current,
      mergeTimeOutcome(outcomeDiff, playerPatch, event),
      eventReason,
    );
    return {
      ...committed,
      idempotentReplay: false,
      survival: survivalSnapshot(committed.game.player),
      hungerCost: calculation.hungerCost,
      hydrationCost: calculation.hydrationCost,
      appliedModifiers: calculation.modifiers,
      stageChanges: calculation.transitions,
    };
  }

  async applySurvivalEvent(
    gameId: string,
    expectedRevision: number,
    idempotencyKey: string,
    hungerDelta: number,
    hydrationDelta: number,
    reason: string,
  ) {
    if (!Number.isFinite(hungerDelta) || !Number.isFinite(hydrationDelta)) {
      throw new AegisError("INVALID_DIFF", "生存狀態變化必須是有限數字。");
    }
    if (hungerDelta === 0 && hydrationDelta === 0) {
      throw new AegisError("NO_STATE_CHANGE", "飽食度與補水度都沒有變化。", { changedPaths: [] });
    }
    const eventReason = cleanText(reason, 200);
    if (!eventReason) throw new AegisError("INVALID_DIFF", "生存事件必須記錄原因。");
    const mutation = await this.mutationContext(gameId, expectedRevision, idempotencyKey);
    if (mutation.replay) {
      return {
        game: mutation.current,
        changedPaths: [],
        idempotentReplay: true,
        survival: survivalSnapshot(mutation.current.player),
        appliedHungerDelta: 0,
        appliedHydrationDelta: 0,
        stageChanges: [],
      };
    }
    const adjustment = adjustSurvival(mutation.current.player, hungerDelta, hydrationDelta);
    const event = {
      type: "survival_event",
      reason: eventReason,
      hungerChange: adjustment.appliedHungerDelta,
      hydrationChange: adjustment.appliedHydrationDelta,
    };
    const committed = await this.commitGeneratedDiff(
      gameId,
      expectedRevision,
      mutation.key,
      mutation.current,
      { player: { survival: survivalPatch(adjustment.after) }, history: { append: [event] } },
      eventReason,
    );
    return {
      ...committed,
      idempotentReplay: false,
      survival: survivalSnapshot(committed.game.player),
      appliedHungerDelta: adjustment.appliedHungerDelta,
      appliedHydrationDelta: adjustment.appliedHydrationDelta,
      stageChanges: adjustment.transitions,
    };
  }

  async useItem(
    gameId: string,
    expectedRevision: number,
    idempotencyKey: string,
    itemRef: string,
    restrictionsMet: boolean,
  ) {
    const reference = cleanText(itemRef, 200);
    if (!reference) throw new AegisError("INVALID_DIFF", "item_ref 不可為空白。");
    const mutation = await this.mutationContext(gameId, expectedRevision, idempotencyKey);
    if (mutation.replay) {
      return {
        game: mutation.current,
        changedPaths: [],
        idempotentReplay: true,
        item: null,
        survival: survivalSnapshot(mutation.current.player),
        appliedHungerDelta: 0,
        appliedHydrationDelta: 0,
        stageChanges: [],
        extraEffect: null,
      };
    }
    const inventory = cloneState(mutation.current.inventory);
    const index = findInventoryItem(inventory, reference);
    if (index < 0) throw new AegisError("INVALID_DIFF", `背包中找不到物品 ${reference}。`);
    const item = inventory[index];
    if (!item) throw new AegisError("INVALID_DIFF", `背包中找不到物品 ${reference}。`);
    if (categorizeItem(item, true) !== "consumable") {
      throw new AegisError("INVALID_DIFF", `${String(item.name ?? reference)} 不是消耗品。`);
    }
    if (hasUseRestrictions(item) && !restrictionsMet) {
      throw new AegisError("INVALID_DIFF", `${String(item.name ?? reference)} 的使用限制尚未確認。`, {
        useRestrictions: item.restrictions ?? item.useRestrictions ?? item.requirements ?? item["使用限制"],
      });
    }
    const hungerRestore = itemEffectValue(item, "restore_hunger", ["hungerRestore", "飽食度恢復量"]);
    const hydrationRestore = itemEffectValue(item, "restore_hydration", ["hydrationRestore", "補水度恢復量"]);
    const adjustment = adjustSurvival(mutation.current.player, hungerRestore, hydrationRestore);
    consumeInventoryItem(inventory, index, item);
    const itemName = String(item.name ?? item.title ?? reference);
    const event = {
      type: "item_use",
      itemId: item.id ?? null,
      itemName,
      hungerChange: adjustment.appliedHungerDelta,
      hydrationChange: adjustment.appliedHydrationDelta,
      extraEffect: item.extraEffect ?? item.effect ?? null,
    };
    const committed = await this.commitGeneratedDiff(
      gameId,
      expectedRevision,
      mutation.key,
      mutation.current,
      {
        inventory,
        player: { survival: survivalPatch(adjustment.after) },
        history: { append: [event] },
      },
      `Used ${itemName}`,
    );
    return {
      ...committed,
      idempotentReplay: false,
      item: { id: item.id ?? null, name: itemName },
      survival: survivalSnapshot(committed.game.player),
      appliedHungerDelta: adjustment.appliedHungerDelta,
      appliedHydrationDelta: adjustment.appliedHydrationDelta,
      stageChanges: adjustment.transitions,
      extraEffect: item.extraEffect ?? item.effect ?? null,
    };
  }

  async refillContainer(
    gameId: string,
    expectedRevision: number,
    idempotencyKey: string,
    itemRef: string,
    reason: string,
  ) {
    const reference = cleanText(itemRef, 200);
    const refillReason = cleanText(reason, 200);
    if (!reference || !refillReason) {
      throw new AegisError("INVALID_DIFF", "補充容器必須提供物品與合理水源／補充原因。");
    }
    const mutation = await this.mutationContext(gameId, expectedRevision, idempotencyKey);
    if (mutation.replay) return { game: mutation.current, idempotentReplay: true };
    const inventory = cloneState(mutation.current.inventory);
    const index = findInventoryItem(inventory, reference);
    const item = inventory[index];
    if (index < 0 || !item) throw new AegisError("INVALID_DIFF", `背包中找不到物品 ${reference}。`);
    if (item.refillable !== true || typeof item.maxUses !== "number" || item.maxUses <= 0) {
      throw new AegisError("INVALID_DIFF", `${String(item.name ?? reference)} 不是可補充容器。`);
    }
    const currentUses = typeof item.usesRemaining === "number" ? item.usesRemaining : 0;
    if (currentUses >= item.maxUses) {
      throw new AegisError("NO_STATE_CHANGE", "容器已是滿的。", { changedPaths: [] });
    }
    item.usesRemaining = item.maxUses;
    item.state = "filled";
    const itemName = String(item.name ?? reference);
    const committed = await this.commitGeneratedDiff(
      gameId,
      expectedRevision,
      mutation.key,
      mutation.current,
      {
        inventory,
        history: { append: [{ type: "container_refill", itemId: item.id ?? null, itemName, reason: refillReason }] },
      },
      refillReason,
    );
    return { ...committed, idempotentReplay: false, item: { id: item.id ?? null, name: itemName, usesRemaining: item.maxUses } };
  }

  async equipItem(
    gameId: string,
    expectedRevision: number,
    idempotencyKey: string,
    instanceId: string,
    slot: string,
  ) {
    const itemId = cleanText(instanceId, 200);
    const equipmentSlot = cleanText(slot, 100);
    if (!itemId || !equipmentSlot) {
      throw new AegisError("INVALID_DIFF", "裝備物品必須提供 instance_id 與 slot。");
    }
    const mutation = await this.mutationContext(gameId, expectedRevision, idempotencyKey);
    if (mutation.replay) {
      return { game: mutation.current, changedPaths: [], idempotentReplay: true };
    }
    const operation = equipInventoryItem(mutation.current, itemId, equipmentSlot);
    const itemName = String(operation.equipped.name ?? itemId);
    const game = await this.commitDirectMutation(
      gameId,
      expectedRevision,
      mutation.key,
      operation.next,
      `Equipped ${itemName}`,
      operation.changedPaths,
    );
    return {
      game,
      changedPaths: operation.changedPaths,
      idempotentReplay: false,
      equipped: operation.equipped,
      unequipped: operation.unequipped ?? null,
    };
  }

  async unequipItem(
    gameId: string,
    expectedRevision: number,
    idempotencyKey: string,
    slot: string,
  ) {
    const equipmentSlot = cleanText(slot, 100);
    if (!equipmentSlot) throw new AegisError("INVALID_DIFF", "卸除裝備必須提供 slot。");
    const mutation = await this.mutationContext(gameId, expectedRevision, idempotencyKey);
    if (mutation.replay) {
      return { game: mutation.current, changedPaths: [], idempotentReplay: true };
    }
    const operation = unequipInventoryItem(mutation.current, equipmentSlot);
    const itemName = String(operation.unequipped.name ?? operation.unequipped.instanceId ?? "物品");
    const game = await this.commitDirectMutation(
      gameId,
      expectedRevision,
      mutation.key,
      operation.next,
      `Unequipped ${itemName}`,
      operation.changedPaths,
    );
    return {
      game,
      changedPaths: operation.changedPaths,
      idempotentReplay: false,
      unequipped: operation.unequipped,
    };
  }

  async listSaves(gameId: string) {
    await this.getGame(gameId);
    return this.store.listSaves(gameId);
  }

  async loadSave(
    gameId: string,
    saveId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ) {
    assertRevision(expectedRevision);
    const key = cleanIdempotencyKey(idempotencyKey);
    const current = await this.getGame(gameId);
    if (hasIdempotencyKey(current, key)) {
      return { game: current, idempotentReplay: true };
    }
    if (current.revision !== expectedRevision) {
      throw new AegisError("REVISION_CONFLICT", "遊戲狀態已更新，請重新確認後讀檔。", {
        expectedRevision,
        actualRevision: current.revision,
      });
    }
    const save = await this.store.getSave(gameId, saveId);
    if (!save) throw new AegisError("SAVE_NOT_FOUND", `找不到存檔 ${saveId}。`);

    const restored = migrateGameState(cloneState(save.state));
    restored.gameId = current.gameId;
    restored.title = current.title;
    restored.createdAt = current.createdAt;
    restored.revision = current.revision + 1;
    restored.updatedAt = new Date().toISOString();
    appendRestoreTransaction(restored, key, save);
    validateGameState(restored, this.config.maxStateBytes);
    const game = await this.store.compareAndSwap(gameId, expectedRevision, restored);
    return { game, idempotentReplay: false };
  }

  async dashboard(gameId: string, turnId?: string) {
    assertGameId(gameId);
    const id = turnId === undefined ? undefined : cleanTurnId(turnId);
    const claimed = await this.store.claimDashboard(gameId, id);
    const game = migrateGameState(claimed.game);
    validateGameState(game, this.config.maxStateBytes);
    return {
      game: toGameView(game),
      turnId: claimed.turn.turnId,
      dashboardKey: `${game.gameId}:${claimed.turn.turnId}:${game.revision}`,
    };
  }

  private async mutationContext(
    gameId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ) {
    assertRevision(expectedRevision);
    const key = cleanIdempotencyKey(idempotencyKey);
    const current = await this.getGame(gameId);
    if (hasIdempotencyKey(current, key)) return { current, key, replay: true as const };
    if (current.revision !== expectedRevision) {
      throw new AegisError("REVISION_CONFLICT", "遊戲狀態已更新，請重新準備回合。", {
        expectedRevision,
        actualRevision: current.revision,
      });
    }
    return { current, key, replay: false as const };
  }

  private async commitGeneratedDiff(
    gameId: string,
    expectedRevision: number,
    key: string,
    current: GameState,
    diff: JsonObject,
    summary: string,
  ) {
    const result = applyStateDiff(current, diff, {
      maxDiffBytes: this.config.maxDiffBytes,
      maxStateBytes: this.config.maxStateBytes,
      idempotencyKey: key,
      turnSummary: summary,
    });
    const game = await this.store.compareAndSwap(gameId, expectedRevision, result.game);
    return { game, changedPaths: result.changedPaths };
  }

  private async commitDirectMutation(
    gameId: string,
    expectedRevision: number,
    key: string,
    next: GameState,
    summary: string,
    changedPaths: string[],
  ) {
    next.revision = expectedRevision + 1;
    next.updatedAt = new Date().toISOString();
    recordAutomaticSave(next, key, summary, changedPaths);
    validateGameState(next, this.config.maxStateBytes);
    return this.store.compareAndSwap(gameId, expectedRevision, next);
  }
}

function asJsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function mergeTimeOutcome(outcomeDiff: unknown, playerPatch: JsonObject, event: JsonObject): JsonObject {
  if (outcomeDiff === undefined) return { player: playerPatch, history: { append: [event] } };
  if (!outcomeDiff || typeof outcomeDiff !== "object" || Array.isArray(outcomeDiff)) {
    throw new AegisError("INVALID_DIFF", "outcome_diff 必須是物件。");
  }
  const outcome = cloneState(outcomeDiff as JsonObject);
  const allowed = new Set(["world", "player", "inventory", "npcs", "compendium", "map", "quests"]);
  const unknown = Object.keys(outcome).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new AegisError("INVALID_DIFF", `outcome_diff 含有不允許的欄位：${unknown.join("、")}。`);
  }
  const playerOutcome = outcome.player;
  if (playerOutcome !== undefined && (!playerOutcome || typeof playerOutcome !== "object" || Array.isArray(playerOutcome))) {
    throw new AegisError("INVALID_DIFF", "outcome_diff.player 必須是物件。");
  }
  const player = playerOutcome as JsonObject | undefined;
  for (const key of ["survival", "date", "time"] as const) {
    if (player?.[key] !== undefined) {
      throw new AegisError("INVALID_DIFF", `outcome_diff.player.${key} 由時間結算器管理，不得重複指定。`);
    }
  }
  outcome.player = { ...(player ?? {}), ...playerPatch };
  outcome.history = { append: [event] };
  return outcome;
}

function resetChangedPaths(left: GameState, right: GameState): string[] {
  const paths = ["player", "inventory", "quests", "history", "npcs", "map", "compendium"] as const;
  return paths.filter((path) => JSON.stringify(left[path]) !== JSON.stringify(right[path]));
}

function findInventoryItem(inventory: JsonObject[], reference: string): number {
  return inventory.findIndex(
    (item) =>
      String(item.instanceId ?? "") === reference ||
      String(item.templateId ?? "") === reference ||
      String(item.id ?? "") === reference ||
      String(item.name ?? item.title ?? "") === reference,
  );
}

function hasUseRestrictions(item: JsonObject): boolean {
  const value = item.restrictions ?? item.useRestrictions ?? item.requirements ?? item["使用限制"];
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return value !== undefined && value !== null && value !== "";
}

function itemNumber(item: JsonObject, keys: string[]): number {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return 0;
}

function itemEffectValue(item: JsonObject, type: string, legacyKeys: string[]): number {
  if (Array.isArray(item.effects)) {
    return item.effects.reduce<number>((total, raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return total;
      const effect = raw as JsonObject;
      return effect.type === type && typeof effect.value === "number" && Number.isFinite(effect.value) && effect.value >= 0
        ? total + effect.value
        : total;
    }, 0);
  }
  return itemNumber(item, legacyKeys);
}

function consumeInventoryItem(inventory: JsonObject[], index: number, item: JsonObject): void {
  if (typeof item.usesRemaining === "number") {
    if (!Number.isInteger(item.usesRemaining) || item.usesRemaining <= 0) {
      throw new AegisError("INVALID_DIFF", `${String(item.name ?? "物品")} 已沒有可使用次數或容量。`);
    }
    item.usesRemaining -= 1;
    item.state = item.usesRemaining === 0 ? "empty" : "available";
    return;
  }
  const quantity = typeof item.quantity === "number" ? item.quantity : 1;
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new AegisError("INVALID_DIFF", `${String(item.name ?? "物品")} 的持有數量不足。`);
  }
  if (quantity <= 1) inventory.splice(index, 1);
  else item.quantity = quantity - 1;
}

function assertNonnegativeCost(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1000) {
    throw new AegisError("INVALID_DIFF", `${label} 必須是 0～1000 的有限數字。`);
  }
}

function hasIdempotencyKey(state: GameState, key: string): boolean {
  const keys = state.engine.idempotencyKeys;
  return Array.isArray(keys) && keys.includes(key);
}

function appendRestoreTransaction(state: GameState, key: string, save: SaveRecord): void {
  recordAutomaticSave(state, key, `Loaded recovery snapshot ${save.name}`, ["*"], {
    sourceSaveId: save.saveId,
  });
}

function deterministicSaveId(gameId: string, key: string): string {
  const hex = createHash("sha256").update(`${gameId}:${key}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function cleanIdempotencyKey(value: string): string {
  const key = cleanText(value, 120);
  if (!key || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new AegisError(
      "INVALID_DIFF",
      "idempotency_key 必須是 1–120 字元的英數、點、底線、冒號或連字號。",
    );
  }
  return key;
}

function cleanTurnId(value: string): string {
  const turnId = (value ?? "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(turnId)) {
    throw new AegisError("INVALID_DIFF", "turn_id 必須是 aegis_prepare_turn 回傳的有效識別碼。");
  }
  return turnId;
}

function assertRevision(value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new AegisError("INVALID_DIFF", "expected_revision 必須是非負整數。");
  }
}

function cleanText(value: string | undefined, maxLength: number): string {
  return (value ?? "").trim().slice(0, maxLength);
}
