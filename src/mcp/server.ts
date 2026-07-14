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

const WIDGET_URI = "ui://widget/aegis-dashboard-v6.html";
const LEGACY_WIDGET_URI = "ui://widget/aegis-dashboard-v1.html";
const LEGACY_WIDGET_V2_URI = "ui://widget/aegis-dashboard-v2.html";
const LEGACY_WIDGET_V3_URI = "ui://widget/aegis-dashboard-v3.html";
const LEGACY_WIDGET_V4_URI = "ui://widget/aegis-dashboard-v4.html";
const LEGACY_WIDGET_V5_URI = "ui://widget/aegis-dashboard-v5.html";
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
const turnIdSchema = z
  .string()
  .uuid()
  .describe("aegis_prepare_turn 為本回合簽發的 turnId；只能用於本回合唯一一次面板顯示。");
const resultOutputSchema = { result: z.record(z.unknown()) };

export function createAegisMcpServer(service: AegisService, widgetHtml: string): McpServer {
  const server = new McpServer(
    { name: "aegis-rpg", version: "0.5.2" },
    {
      instructions:
        "AEGIS State 是單一流動世界的唯一權威。每個玩家回合先靜默呼叫 aegis_prepare_turn，再依權威狀態判定；aegis_prepare_turn 與 aegis_get_game_state 都不得建立玩家可見面板。prepare_turn 會簽發伺服器端 turnId，但不改變遊戲 State 或 revision。若持久狀態改變，必須在敘述成既成事實前成功寫入；沒有真實變化時不得為了產生 revision 虛構修改。時間流逝一律呼叫 aegis_advance_time；旅行或長事件若同時改變位置、地圖、人物、圖鑑或任務，將這些 outcome_diff 與時間和生存結算放在同一原子交易。食用或飲用一律呼叫 aegis_use_item；事件造成飽食或補水變化使用 aegis_apply_survival_event；裝備與卸除只使用 aegis_equip_item / aegis_unequip_item；玩家重設只使用 aegis_reset_player。寫入衝突時重新 prepare，並只使用新回合的 turnId。新地點、新 NPC 或新知識必須先成功寫入，才能在敘述與面板中視為已發現。map 只保存玩家已知或聽聞地點，具有唯一 mapId；npcs 只保存玩家合理知道的資料，具有唯一 npcId，禁止秘密與逐字稿；compendium 只保存實際發現知識，具有唯一 entryId、漸進階段、來源與可信度，不保存人物個體或具體地點。不得自行虛構背包、金錢、能力、NPC 狀態、精確路線或世界全知事實。物品 category 必須且只能是 consumable、equipment、misc、special；全部只是介面檢視。每件實體物品必須有唯一 instanceId；已裝備實例不得留在 inventory。物品描述、結構化 effects 或 modifiers、acquisition 與限制必須分離；初始物品 acquisition.type 使用 initial_item。技能必須有單一 category、繁中 categoryLabel、分離的 description、effects、acquisition 與可選 tags；初始技能使用 initial_skill；unique 類別必須有 uniqueScope 與 uniqueHolderId 權威依據。未知欄位保持空缺，不得猜測或把規格示例當固定數值。AEGIS 僅自動保存，不向一般玩家提供建立、列出或讀取舊存檔。玩家可見內容全部使用繁體中文，不顯示內部 Diff、Revision、驗證或 Transaction。完成本回合所有必要寫入後，以 prepare_turn 回傳的 turnId 恰好呼叫一次 aegis_show_dashboard；伺服器會原子拒絕過期 turnId 與同一回合的第二次顯示。不得顯示中間狀態。頁籤切換完全由前端處理，不呼叫工具、不推進時間、不產生 revision。",
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
  registerAppResource(
    server,
    "aegis-dashboard-v3-compat",
    LEGACY_WIDGET_V3_URI,
    {},
    async () => dashboardResource(LEGACY_WIDGET_V3_URI),
  );
  registerAppResource(
    server,
    "aegis-dashboard-v4-compat",
    LEGACY_WIDGET_V4_URI,
    {},
    async () => dashboardResource(LEGACY_WIDGET_V4_URI),
  );
  registerAppResource(
    server,
    "aegis-dashboard-v5-compat",
    LEGACY_WIDGET_V5_URI,
    {},
    async () => dashboardResource(LEGACY_WIDGET_V5_URI),
  );

  registerAppTool(
    server,
    "aegis_create_game",
    {
      title: "建立 AEGIS 遊戲",
      description: "建立新的永久 AEGIS 世界；不會覆寫已存在的 game_id。",
      inputSchema: {
        game_id: gameIdSchema,
        title: z.string().max(100).optional().describe("遊戲顯示名稱。"),
      },
      outputSchema: resultOutputSchema,
      annotations: impact(false, false, false, true),
      _meta: silentMeta("建立世界…", "世界已建立並自動保存"),
    },
    async ({ game_id, title }) => safeTool(async () => {
      const game = toGameView(await service.createGame(game_id, title));
      return {
        game,
        message: "遊戲已建立並自動保存。接著可準備角色建立回合。",
      };
    }),
  );

  registerAppTool(
    server,
    "aegis_get_game_state",
    {
      title: "讀取 AEGIS 狀態",
      description: "靜默讀取完整權威遊戲狀態，不渲染面板，也不推進遊戲時間。",
      inputSchema: { game_id: gameIdSchema },
      outputSchema: resultOutputSchema,
      annotations: impact(true, false, false, true),
      _meta: silentMeta("讀取權威狀態…", "權威狀態已讀取"),
    },
    async ({ game_id }) => safeTool(async () => {
      const game = await service.getGame(game_id);
      return { game };
    }),
  );

  registerAppTool(
    server,
    "aegis_prepare_turn",
    {
      title: "準備 AEGIS 回合",
      description: "每個遊戲回合的靜默第一步；取得權威狀態、適用規則與本回合處理契約，不渲染玩家面板。",
      inputSchema: {
        game_id: gameIdSchema,
        player_input: z.string().min(1).max(4000).describe("玩家本回合的原始行動或指令。"),
        runtime: z.enum(["auto", "initialization", "normal", "system", "recovery"]).default("auto"),
        action_type: z.string().max(50).default("auto"),
      },
      outputSchema: resultOutputSchema,
      annotations: impact(false, false, false, false),
      _meta: silentMeta("準備回合…", "回合已準備"),
    },
    async ({ game_id, player_input, runtime, action_type }) => safeTool(async () => {
      const turn = await service.prepareTurn(game_id, player_input, runtime, action_type);
      return {
        turn,
        nextStep:
          `Resolve only this player action. Use specialized write tools for time, item use, survival, equipment, or player reset, and aegis_apply_state_diff for other changes. Narrate completion only after the required write succeeds. After every write is finished, call aegis_show_dashboard exactly once with turn_id=${turn.turnId}; never show an intermediate revision or reuse an older turnId. If the client tool schema does not expose turn_id, call aegis_show_dashboard exactly once with game_id only so the server can atomically claim the active turn. Do not offer manual save or load.`,
      };
    }),
  );

  registerAppTool(
    server,
    "aegis_apply_state_diff",
    {
      title: "提交 AEGIS 狀態變更",
      description: "在永久狀態確實改變時提交一個已準備回合。直接陣列代表完整覆寫，空陣列代表清空；增量修改使用明確操作。",
      inputSchema: {
        game_id: gameIdSchema,
        expected_revision: z.number().int().nonnegative().describe("aegis_prepare_turn 回傳的 revision。"),
        idempotency_key: idempotencySchema,
        diff: z.record(z.unknown()).describe(
          "只含 world、player、inventory、npcs、compendium、map、quests、history 的差異。直接陣列代表完整替換，[] 代表清空。player.skills/inventory/quests/history.recent/history.major/history.summary 必須是陣列。物品 category 必須是 consumable/equipment/misc/special。map 條目必須有 mapId、name、kind(region/town/place/subplace)、discovery(heard/known/visited/surveyed)；路線只可引用已知 toMapId。npcs 條目必須有 npcId、name、familiarity(heard/met/acquainted/familiar/trusted)，只保存玩家已知資料，禁止秘密與逐字稿。compendium 條目必須有 entryId、name、category(creature/plant/material/magical_phenomenon/faction/culture/other)、stage(rumor/observed/identified/verified/researched)、confidence(low/medium/high/confirmed) 與至少一項 sources；不得保存人物個體或具體地點條目。未知資料不可虛構。",
        ),
        turn_summary: z.string().max(500).optional().describe("本回合狀態變化的簡短摘要。"),
      },
      outputSchema: resultOutputSchema,
      annotations: impact(false, false, false, true),
      _meta: silentMeta("提交狀態…", "進度已自動保存"),
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
          : "狀態變更已通過驗證、提交並自動保存。",
      };
    }),
  );

  registerAppTool(
    server,
    "aegis_reset_player",
    {
      title: "重設 AEGIS 玩家",
      description: "僅在玩家明確要求時原子重設角色資料；保留世界狀態與僅供開發者使用的災難復原快照。",
      inputSchema: {
        game_id: gameIdSchema,
        expected_revision: z.number().int().nonnegative(),
        idempotency_key: idempotencySchema,
        preserve_world: z.literal(true).default(true),
      },
      outputSchema: resultOutputSchema,
      annotations: impact(false, false, true, true),
      _meta: silentMeta("重設角色…", "角色已重設並自動保存"),
    },
    async ({ game_id, expected_revision, idempotency_key }) => safeTool(async () => {
      const reset = await service.resetPlayer(game_id, expected_revision, idempotency_key);
      return {
        game: toGameView(reset.game),
        changedPaths: reset.changedPaths,
        idempotentReplay: reset.idempotentReplay,
        message: reset.idempotentReplay ? "角色重設已完成，這是安全重試結果。" : "角色資料已原子化重設；世界設定已依操作規則保留。",
      };
    }),
  );

  registerAppTool(
    server,
    "aegis_advance_time",
    {
      title: "結算 AEGIS 遊戲時間",
      description: "在睡眠、旅行、等待、戰鬥或時間跳躍時，依實際遊戲時間原子結算飽食度與補水度。",
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
        outcome_diff: z.record(z.unknown()).optional().describe(
          "與本次時間事件在同一交易提交的結果，可含 world、player（不得含 survival/date/time）、inventory、npcs、compendium、map、quests；用於原子更新旅行目的地、新人物與新知識。map、npcs、compendium 使用與 aegis_apply_state_diff 相同的唯一 ID、玩家知識與來源規則。",
        ),
      },
      outputSchema: resultOutputSchema,
      annotations: impact(false, false, true, true),
      _meta: silentMeta("結算遊戲時間…", "生存狀態已更新並自動保存"),
    },
    async (input) => safeTool(async () => {
      const result = await service.advanceTime(
        input.game_id, input.expected_revision, input.idempotency_key, input.elapsed_hours,
        input.activity, input.environment, input.reason, input.extra_hunger_cost,
        input.extra_hydration_cost, input.new_date, input.new_time, input.outcome_diff,
      );
      return { ...result, game: toGameView(result.game), message: "時間、事件結果與生存狀態已原子結算，進度已自動保存。" };
    }),
  );

  registerAppTool(
    server,
    "aegis_apply_survival_event",
    {
      title: "套用 AEGIS 生存事件",
      description: "在宴席、高溫、疾病、污染飲水等具體事件改變生存數值時使用；必須記錄明確原因。",
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
      _meta: silentMeta("套用生存事件…", "生存狀態已更新並自動保存"),
    },
    async (input) => safeTool(async () => {
      const result = await service.applySurvivalEvent(
        input.game_id, input.expected_revision, input.idempotency_key,
        input.hunger_delta, input.hydration_delta, input.reason,
      );
      return { ...result, game: toGameView(result.game), message: "生存事件已記錄，進度已自動保存。" };
    }),
  );

  registerAppTool(
    server,
    "aegis_use_item",
    {
      title: "使用 AEGIS 消耗品",
      description: "食用、飲用或消耗背包物品；原子更新數量或剩餘容量，並套用不超過上限的恢復效果。",
      inputSchema: {
        game_id: gameIdSchema,
        expected_revision: z.number().int().nonnegative(),
        idempotency_key: idempotencySchema,
        item_ref: z.string().min(1).max(200).describe("物品 id 或完整名稱。"),
        restrictions_met: z.boolean().default(false).describe("只有確認物品既有使用限制已符合時才能設為 true。"),
      },
      outputSchema: resultOutputSchema,
      annotations: impact(false, false, true, true),
      _meta: silentMeta("使用物品…", "物品與角色狀態已更新並自動保存"),
    },
    async (input) => safeTool(async () => {
      const result = await service.useItem(
        input.game_id, input.expected_revision, input.idempotency_key,
        input.item_ref, input.restrictions_met,
      );
      return { ...result, game: toGameView(result.game), message: "物品使用結果已提交，進度已自動保存。" };
    }),
  );

  registerAppTool(
    server,
    "aegis_refill_container",
    {
      title: "補充 AEGIS 容器",
      description: "在已確立且合理的來源補充可重複使用容器；不會憑空建立水源，且必須記錄原因。",
      inputSchema: {
        game_id: gameIdSchema,
        expected_revision: z.number().int().nonnegative(),
        idempotency_key: idempotencySchema,
        item_ref: z.string().min(1).max(200),
        reason: z.string().min(1).max(200),
      },
      outputSchema: resultOutputSchema,
      annotations: impact(false, false, false, true),
      _meta: silentMeta("補充容器…", "容器已補充並自動保存"),
    },
    async (input) => safeTool(async () => {
      const result = await service.refillContainer(
        input.game_id, input.expected_revision, input.idempotency_key, input.item_ref, input.reason,
      );
      return { ...result, game: toGameView(result.game), message: "容器已補充，進度已自動保存。" };
    }),
  );

  registerAppTool(
    server,
    "aegis_equip_item",
    {
      title: "裝備 AEGIS 物品",
      description: "裝備一個背包物品實例；原子更換欄位、把舊裝備送回背包，並同步裝備效果。",
      inputSchema: {
        game_id: gameIdSchema,
        expected_revision: z.number().int().nonnegative(),
        idempotency_key: idempotencySchema,
        instance_id: z.string().min(1).max(200),
        slot: z.string().min(1).max(100),
      },
      outputSchema: resultOutputSchema,
      annotations: impact(false, false, false, true),
      _meta: silentMeta("裝備物品…", "裝備已更新並自動保存"),
    },
    async (input) => safeTool(async () => {
      const result = await service.equipItem(
        input.game_id, input.expected_revision, input.idempotency_key, input.instance_id, input.slot,
      );
      return { ...result, game: toGameView(result.game), message: "裝備狀態已更新，進度已自動保存。" };
    }),
  );

  registerAppTool(
    server,
    "aegis_unequip_item",
    {
      title: "卸除 AEGIS 裝備",
      description: "卸除一個裝備欄位；原子移除裝備效果，並把同一物品實例送回背包。",
      inputSchema: {
        game_id: gameIdSchema,
        expected_revision: z.number().int().nonnegative(),
        idempotency_key: idempotencySchema,
        slot: z.string().min(1).max(100),
      },
      outputSchema: resultOutputSchema,
      annotations: impact(false, false, false, true),
      _meta: silentMeta("卸除裝備…", "裝備已卸除並自動保存"),
    },
    async (input) => safeTool(async () => {
      const result = await service.unequipItem(
        input.game_id, input.expected_revision, input.idempotency_key, input.slot,
      );
      return { ...result, game: toGameView(result.game), message: "裝備已卸除並返回背包，進度已自動保存。" };
    }),
  );

  registerAppTool(
    server,
    "aegis_show_dashboard",
    {
      title: "顯示 AEGIS 儀表板",
      description: "在本回合所有狀態變更完成後唯一一次顯示綜合面板。應傳入 prepare_turn 簽發的 turnId；若舊版客戶端 schema 尚未提供 turn_id，伺服器會原子認領目前有效回合。過期 turnId 或同一回合的第二次呼叫仍會被拒絕。",
      inputSchema: { game_id: gameIdSchema, turn_id: turnIdSchema.optional() },
      outputSchema: resultOutputSchema,
      annotations: impact(false, false, false, false),
      _meta: {
        ui: { resourceUri: WIDGET_URI },
        "openai/outputTemplate": WIDGET_URI,
        "openai/toolInvocation/invoking": "讀取 AEGIS 狀態…",
        "openai/toolInvocation/invoked": "AEGIS 儀表板已更新",
      },
    },
    async ({ game_id, turn_id }) => safeTool(async () => ({
      dashboard: await service.dashboard(game_id, turn_id),
    })),
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

function silentMeta(invoking: string, invoked: string) {
  return {
    "openai/toolInvocation/invoking": invoking,
    "openai/toolInvocation/invoked": invoked,
  };
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
