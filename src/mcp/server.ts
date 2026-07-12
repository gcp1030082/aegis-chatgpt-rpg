import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asAegisError } from "../domain/errors.js";
import { toGameView } from "../domain/default-state.js";
import type { AegisService } from "../service.js";

const WIDGET_URI = "ui://widget/aegis-dashboard-v3.html";
const LEGACY_WIDGET_URI = "ui://widget/aegis-dashboard-v1.html";
const LEGACY_WIDGET_V2_URI = "ui://widget/aegis-dashboard-v2.html";
const gameIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/)
  .describe("遊戲識別碼，例如 main 或 world-1。");
const idempotencySchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9._:-]+$/)
  .describe("此操作唯一且重試時保持相同的鍵，例如 turn-12-combat-result。");
const resultOutputSchema = { result: z.record(z.unknown()) };

export function createAegisMcpServer(service: AegisService, widgetHtml: string): McpServer {
  const server = new McpServer(
    { name: "aegis-rpg", version: "0.3.0" },
    {
      instructions:
        "AEGIS State 是遊戲世界的唯一權威。每個遊戲回合先呼叫 aegis_prepare_turn，再依回傳狀態與規則判定結果；若持久狀態改變，必須在敘述成既成事實前成功寫入。時間流逝一律呼叫 aegis_advance_time；食用或飲用一律呼叫 aegis_use_item；事件造成飽食或補水變化使用 aegis_apply_survival_event；玩家重設只使用 aegis_reset_player。寫入衝突時重新 prepare。不得自行虛構背包、金錢、能力、NPC 狀態或世界事實。物品 category 必須且只能是 consumable、equipment、misc、special 之一；全部只是介面彙總，不是 category。新增或更新物品時應保存穩定 id、name、quantity、category、quality、description、effect、source，以及已知的 hungerRestore、hydrationRestore、usesRemaining、maxUses、refillable、useRestrictions、extraEffect。技能與裝備也應保存已知詳情。未知欄位保持空缺，不得猜測。玩家可見內容使用繁體中文，不顯示內部 Diff、Revision、驗證或 Transaction。介面查詢不推進時間。",
    },
  );

  const dashboardResource = (uri: string) => ({
    contents: [
      {
        uri,
        mimeType: RESOURCE_MIME_TYPE,
        text: widgetHtml,
        _meta: {
          ui: {
            prefersBorder: true,
            csp: { connectDomains: [], resourceDomains: [] },
          },
        },
      },
    ],
  });

  registerAppResource(server, "aegis-dashboard", WIDGET_URI, {}, async () =>
    dashboardResource(WIDGET_URI),
  );
  registerAppResource(
    server,
    "aegis-dashboard-v1-compat",
    LEGACY_WIDGET_URI,
    {},
    async () => dashboardResource(LEGACY_WIDGET_URI),
  );
  registerAppResource(
    server,
    "aegis-dashboard-v2-compat",
    LEGACY_WIDGET_V2_URI,
    {},
    async () => dashboardResource(LEGACY_WIDGET_V2_URI),
  );

  server.registerTool(
    "aegis_create_game",
    {
      title: "建立 AEGIS 遊戲",
      description: "Use this when the user wants to create a new persistent AEGIS game. It never overwrites an existing game_id.",
      inputSchema: {
        game_id: gameIdSchema,
        title: z.string().max(100).optional().describe("遊戲顯示名稱。"),
      },
      outputSchema: resultOutputSchema,
      annotations: impact(false, false, false, true),
    },
    async ({ game_id, title }) => safeTool(async () => ({
      game: toGameView(await service.createGame(game_id, title)),
      message: "遊戲已建立。接著可呼叫 aegis_prepare_turn 建立角色或開始行動。",
    })),
  );

  server.registerTool(
    "aegis_get_game_state",
    {
      title: "讀取 AEGIS 狀態",
      description: "Use this to answer state or interface queries from the authoritative game state without advancing time.",
      inputSchema: { game_id: gameIdSchema },
      outputSchema: resultOutputSchema,
      annotations: impact(true, false, false, true),
    },
    async ({ game_id }) => safeTool(async () => ({ game: await service.getGame(game_id) })),
  );

  server.registerTool(
    "aegis_prepare_turn",
    {
      title: "準備 AEGIS 回合",
      description: "Use this first for every gameplay turn. It returns the authoritative revision, relevant state, active rules, and the contract for resolving the player's exact input.",
      inputSchema: {
        game_id: gameIdSchema,
        player_input: z.string().min(1).max(4000).describe("玩家本回合的原始行動或指令。"),
        runtime: z.enum(["auto", "initialization", "normal", "system", "recovery"]).default("auto"),
        action_type: z.string().max(50).default("auto"),
      },
      outputSchema: resultOutputSchema,
      annotations: impact(true, false, false, true),
    },
    async ({ game_id, player_input, runtime, action_type }) => safeTool(async () => ({
      turn: await service.prepareTurn(game_id, player_input, runtime, action_type),
      nextStep:
        "Resolve only this player action. Use aegis_advance_time for elapsed game time, aegis_use_item for eating or drinking, aegis_apply_survival_event for other survival changes, and aegis_reset_player for player reset. Use aegis_apply_state_diff for other persistent changes. Narrate completion only after the required write succeeds.",
    })),
  );

  server.registerTool(
    "aegis_apply_state_diff",
    {
      title: "提交 AEGIS 狀態變更",
      description: "Use this after resolving one prepared turn when persistent game state actually changes. Direct arrays fully replace existing arrays, including empty arrays. Use explicit add/upsert/remove/append objects only for incremental operations.",
      inputSchema: {
        game_id: gameIdSchema,
        expected_revision: z.number().int().nonnegative().describe("aegis_prepare_turn 回傳的 revision。"),
        idempotency_key: idempotencySchema,
        diff: z.record(z.unknown()).describe(
          "只含 world、player、inventory、npcs、compendium、map、quests、history 的差異。直接陣列代表完整替換，[] 代表清空。player.skills/inventory/quests/history.recent/history.major/history.summary 必須是陣列。物品 category 必須是 consumable/equipment/misc/special。未知資料不可虛構。",
        ),
        turn_summary: z.string().max(500).optional().describe("本回合狀態變化的簡短摘要。"),
      },
      outputSchema: resultOutputSchema,
      annotations: impact(false, false, false, true),
    },
    async ({ game_id, expected_revision, idempotency_key, diff, turn_summary }) => safeTool(async () => {
      const applied = await service.applyDiff(
        game_id,
        expected_revision,
        idempotency_key,
        diff,
        turn_summary,
      );
      return {
        game: toGameView(applied.game),
        changedPaths: applied.changedPaths,
        idempotentReplay: applied.idempotentReplay,
        message: applied.idempotentReplay
          ? "這是安全重試；狀態先前已提交，本次未再次修改。"
          : "狀態變更已通過驗證並提交。",
      };
    }),
  );

  server.registerTool(
    "aegis_reset_player",
    {
      title: "重設 AEGIS 玩家",
      description: "Use only when the user explicitly asks to clear or reset the current player. It atomically removes player-owned progress while preserving the world and save snapshots.",
      inputSchema: {
        game_id: gameIdSchema,
        expected_revision: z.number().int().nonnegative(),
        idempotency_key: idempotencySchema,
        preserve_world: z.literal(true).default(true),
        preserve_saves: z.literal(true).default(true),
      },
      outputSchema: resultOutputSchema,
      annotations: impact(false, false, true, true),
    },
    async ({ game_id, expected_revision, idempotency_key }) => safeTool(async () => {
      const reset = await service.resetPlayer(game_id, expected_revision, idempotency_key);
      return {
        game: toGameView(reset.game),
        changedPaths: reset.changedPaths,
        idempotentReplay: reset.idempotentReplay,
        message: reset.idempotentReplay ? "角色重設已完成，這是安全重試結果。" : "角色資料已原子化重設；世界與存檔快照已保留。",
      };
    }),
  );

  server.registerTool(
    "aegis_advance_time",
    {
      title: "結算 AEGIS 遊戲時間",
      description: "Use whenever in-game time passes, including sleep, travel, waiting, combat, or time skips. It atomically settles hunger and hydration from elapsed game time.",
      inputSchema: {
        game_id: gameIdSchema,
        expected_revision: z.number().int().nonnegative(),
        idempotency_key: idempotencySchema,
        elapsed_hours: z.number().positive().max(720),
        activity: z.enum(["normal", "rest", "sleep", "travel", "combat", "running", "heavy_labor"]).default("normal"),
        environment: z.enum(["temperate", "hot", "cold"]).default("temperate"),
        reason: z.string().min(1).max(200),
        extra_hunger_cost: z.number().min(0).max(1000).default(0),
        extra_hydration_cost: z.number().min(0).max(1000).default(0),
        new_date: z.string().max(100).optional(),
        new_time: z.string().max(100).optional(),
      },
      outputSchema: resultOutputSchema,
      annotations: impact(false, false, true, true),
    },
    async (input) => safeTool(async () => service.advanceTime(
      input.game_id,
      input.expected_revision,
      input.idempotency_key,
      input.elapsed_hours,
      input.activity,
      input.environment,
      input.reason,
      input.extra_hunger_cost,
      input.extra_hydration_cost,
      input.new_date,
      input.new_time,
    )),
  );

  server.registerTool(
    "aegis_apply_survival_event",
    {
      title: "套用 AEGIS 生存事件",
      description: "Use when a concrete event changes hunger or hydration outside normal time consumption, such as a feast, heat exposure, illness, or contaminated water. A reason is mandatory.",
      inputSchema: {
        game_id: gameIdSchema,
        expected_revision: z.number().int().nonnegative(),
        idempotency_key: idempotencySchema,
        hunger_delta: z.number().min(-1000).max(1000).default(0),
        hydration_delta: z.number().min(-1000).max(1000).default(0),
        reason: z.string().min(1).max(200),
      },
      outputSchema: resultOutputSchema,
      annotations: impact(false, false, true, true),
    },
    async (input) => safeTool(async () => service.applySurvivalEvent(
      input.game_id,
      input.expected_revision,
      input.idempotency_key,
      input.hunger_delta,
      input.hydration_delta,
      input.reason,
    )),
  );

  server.registerTool(
    "aegis_use_item",
    {
      title: "使用 AEGIS 消耗品",
      description: "Use to eat food, drink, or consume an item. It atomically updates quantity or remaining capacity and applies capped hunger/hydration restoration.",
      inputSchema: {
        game_id: gameIdSchema,
        expected_revision: z.number().int().nonnegative(),
        idempotency_key: idempotencySchema,
        item_ref: z.string().min(1).max(200).describe("物品 id 或完整名稱。"),
        restrictions_met: z.boolean().default(false).describe("只有確認物品既有使用限制已符合時才能設為 true。"),
      },
      outputSchema: resultOutputSchema,
      annotations: impact(false, false, true, true),
    },
    async (input) => safeTool(async () => service.useItem(
      input.game_id,
      input.expected_revision,
      input.idempotency_key,
      input.item_ref,
      input.restrictions_met,
    )),
  );

  server.registerTool(
    "aegis_refill_container",
    {
      title: "補充 AEGIS 容器",
      description: "Use to refill a refillable consumable container at an established reasonable source. It does not create a water source and requires an explicit reason.",
      inputSchema: {
        game_id: gameIdSchema,
        expected_revision: z.number().int().nonnegative(),
        idempotency_key: idempotencySchema,
        item_ref: z.string().min(1).max(200),
        reason: z.string().min(1).max(200),
      },
      outputSchema: resultOutputSchema,
      annotations: impact(false, false, false, true),
    },
    async (input) => safeTool(async () => service.refillContainer(
      input.game_id,
      input.expected_revision,
      input.idempotency_key,
      input.item_ref,
      input.reason,
    )),
  );

  server.registerTool(
    "aegis_create_save",
    {
      title: "建立 AEGIS 存檔",
      description: "Use this when the user explicitly asks to save the current authoritative game state.",
      inputSchema: {
        game_id: gameIdSchema,
        name: z.string().min(1).max(100),
        idempotency_key: idempotencySchema,
      },
      outputSchema: resultOutputSchema,
      annotations: impact(false, false, false, true),
    },
    async ({ game_id, name, idempotency_key }) => safeTool(async () => {
      const save = await service.createSave(game_id, name, idempotency_key);
      return {
        save: {
          saveId: save.saveId,
          gameId: save.gameId,
          name: save.name,
          sourceRevision: save.sourceRevision,
          createdAt: save.createdAt,
        },
        message: "存檔已建立。",
      };
    }),
  );

  server.registerTool(
    "aegis_list_saves",
    {
      title: "列出 AEGIS 存檔",
      description: "Use this to list available saves for one game without changing state.",
      inputSchema: { game_id: gameIdSchema },
      outputSchema: resultOutputSchema,
      annotations: impact(true, false, false, true),
    },
    async ({ game_id }) => safeTool(async () => ({ saves: await service.listSaves(game_id) })),
  );

  server.registerTool(
    "aegis_load_save",
    {
      title: "載入 AEGIS 存檔",
      description: "Use this only after the user chooses a specific save. It overwrites the active state with that snapshot and advances the revision.",
      inputSchema: {
        game_id: gameIdSchema,
        save_id: z.string().uuid(),
        expected_revision: z.number().int().nonnegative(),
        idempotency_key: idempotencySchema,
      },
      outputSchema: resultOutputSchema,
      annotations: impact(false, false, true, true),
    },
    async ({ game_id, save_id, expected_revision, idempotency_key }) => safeTool(async () => {
      const loaded = await service.loadSave(game_id, save_id, expected_revision, idempotency_key);
      return {
        game: toGameView(loaded.game),
        idempotentReplay: loaded.idempotentReplay,
        message: "存檔已載入。",
      };
    }),
  );

  registerAppTool(
    server,
    "aegis_show_dashboard",
    {
      title: "顯示 AEGIS 儀表板",
      description: "Use this when the user wants an interactive visual summary of the current character, inventory item details, equipment, skills, quests, and saves.",
      inputSchema: { game_id: gameIdSchema },
      outputSchema: resultOutputSchema,
      annotations: impact(true, false, false, true),
      _meta: {
        ui: { resourceUri: WIDGET_URI },
        "openai/outputTemplate": WIDGET_URI,
        "openai/toolInvocation/invoking": "讀取 AEGIS 狀態…",
        "openai/toolInvocation/invoked": "AEGIS 儀表板已更新",
      },
    },
    async ({ game_id }) => safeTool(async () => ({ dashboard: await service.dashboard(game_id) })),
  );

  return server;
}

function impact(
  readOnlyHint: boolean,
  openWorldHint: boolean,
  destructiveHint: boolean,
  idempotentHint: boolean,
) {
  return { readOnlyHint, openWorldHint, destructiveHint, idempotentHint };
}

async function safeTool(work: () => Promise<Record<string, unknown>>) {
  try {
    const result = await work();
    return {
      structuredContent: { result },
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  } catch (error) {
    const aegisError = asAegisError(error);
    const result = {
      error: {
        code: aegisError.code,
        message: aegisError.message,
        details: aegisError.details ?? {},
      },
    };
    return {
      isError: true,
      structuredContent: { result },
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
}
