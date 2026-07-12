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

const WIDGET_URI = "ui://widget/aegis-dashboard-v2.html";
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
    { name: "aegis-rpg", version: "0.2.0" },
    {
      instructions:
        "AEGIS State 是遊戲世界的唯一權威。每個遊戲回合先呼叫 aegis_prepare_turn，再依回傳狀態與規則判定結果；若持久狀態改變，必須在敘述成既成事實前成功呼叫 aegis_apply_state_diff。寫入衝突時重新 prepare。不得自行虛構背包、金錢、能力、NPC 狀態或世界事實。新增或更新物品時應保存穩定 id、name、quantity、category、quality、description、effect、source 等已知資料；技能應保存 id、name、level、type、description、effect、cost、cooldown、source；裝備應放在 player.equipment 的對應部位，並以物件保存相同的詳細資料。未知欄位保持空缺，不得猜測。玩家可見內容使用繁體中文，不顯示內部 Diff、Revision、驗證或 Transaction。介面查詢不推進時間。",
    },
  );

  registerAppResource(server, "aegis-dashboard", WIDGET_URI, {}, async () => ({
    contents: [
      {
        uri: WIDGET_URI,
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
  }));

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
        "Resolve only this player action. If persistent state changes, call aegis_apply_state_diff with the returned revision before narrating the change as completed.",
    })),
  );

  server.registerTool(
    "aegis_apply_state_diff",
    {
      title: "提交 AEGIS 狀態變更",
      description: "Use this after resolving one prepared turn when persistent game state actually changes. The server validates and atomically commits the diff.",
      inputSchema: {
        game_id: gameIdSchema,
        expected_revision: z.number().int().nonnegative().describe("aegis_prepare_turn 回傳的 revision。"),
        idempotency_key: idempotencySchema,
        diff: z.record(z.unknown()).describe(
          "只含 world、player、inventory、npcs、compendium、map、quests、history 的差異。物品請盡量保存 id/name/quantity/category/quality/description/effect/source；技能與裝備也要保存等級、效果、來源等已知詳情，未知資料不可虛構。",
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
        message: "狀態變更已通過驗證並提交。",
      };
    }),
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
