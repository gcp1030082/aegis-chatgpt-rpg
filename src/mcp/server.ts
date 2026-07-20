import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asAegisError } from "../domain/errors.js";
import { APP_VERSION, toGameView } from "../domain/default-state.js";
import type { AegisService } from "../service.js";

const WIDGET_URI = "ui://widget/aegis-dashboard-v7.html";
const LEGACY_WIDGET_URI = "ui://widget/aegis-dashboard-v1.html";
const LEGACY_WIDGET_V2_URI = "ui://widget/aegis-dashboard-v2.html";
const LEGACY_WIDGET_V3_URI = "ui://widget/aegis-dashboard-v3.html";
const LEGACY_WIDGET_V4_URI = "ui://widget/aegis-dashboard-v4.html";
const LEGACY_WIDGET_V5_URI = "ui://widget/aegis-dashboard-v5.html";
const LEGACY_WIDGET_V6_URI = "ui://widget/aegis-dashboard-v6.html";
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
    { name: "aegis-rpg", version: APP_VERSION },
    {
      instructions:
        "AEGIS State 是單一流動世界的唯一權威。世界本體固定為艾爾維亞——一個包含多種族、魔法、魔物、地下城、公會、王國、宗教、鍊金與魔導技術的劍與魔法異世界；world 由伺服器管理，玩家與模型工具都不得改寫。每回合先靜默呼叫 aegis_prepare_turn；prepare_turn 與 get_game_state 不顯示面板，只有 aegis_show_dashboard 可顯示綜合面板。prepare_turn 簽發 turnId 但不改 State 或 revision。持久狀態必須先成功寫入才能敘述為既成事實；沒有真實變化不得虛構 revision。時間流逝沿用 aegis_advance_time，新呼叫優先使用整數 elapsed_minutes；旅行的 GameClock、生存、player.location.mapId、地圖、單向路線、人物、任務、圖鑑與歷史必須放在同一 outcome_diff 原子提交，且 history 不得重複主要旅行事件。player.location.mapId 是唯一權威位置，文字路徑與 date/time/season 皆由伺服器衍生，禁止直接修改 clock 或 metadata。map 使用 mapId、routeId、facilityId、dangerId 並區分 parentMapId 階層、路線危險與地點危險。game.npcs 只保存玩家已知資料，使用 npcId、infoId、serviceId、memoryId；禁止秘密、私密動機與逐字稿。quests 使用 questId。compendium 使用 entryId、categoryLabel、stage，以及具 factId、sources、confidence 的 facts；不得保存人物個體或世界全知資料。歷史使用具 eventId 的結構化事件。食用飲用使用 aegis_use_item；生存事件使用 aegis_apply_survival_event；裝備只使用 equip/unequip；玩家要求重設進度時只使用 reset_player，它會保留艾爾維亞並清除角色、物品、裝備、任務、歷史、地圖、人物知識、圖鑑與私密人物進度。物品 category 只能是 consumable、equipment、misc、special，每件實體物品具有唯一 instanceId；技能使用單一 category、繁中 categoryLabel、effects 與 acquisition。AEGIS 僅自動保存，不提供玩家手動存讀檔。完成所有必要寫入後，以本回合 turnId 恰好呼叫一次 aegis_show_dashboard；舊客戶端若沒有 turn_id 欄位可只傳 game_id，由伺服器原子認領有效回合。所有頁籤、節點點擊、拖曳、縮放與列表切換皆為純前端操作，不呼叫工具、不推進時間、不新增 revision。",
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
  registerAppResource(
    server,
    "aegis-dashboard-v6-compat",
    LEGACY_WIDGET_V6_URI,
    {},
    async () => dashboardResource(LEGACY_WIDGET_V6_URI),
  );

  registerAppTool(
    server,
    "aegis_create_game",
    {
      title: "建立 AEGIS 遊戲",
      description: "在固定世界艾爾維亞建立新的永久 AEGIS 遊戲；不會覆寫已存在的 game_id，也不能建立其他世界本體。",
      inputSchema: {
        game_id: gameIdSchema,
        title: z.string().max(100).optional().describe("冒險顯示名稱；不會改變固定世界艾爾維亞的名稱。"),
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
          `Resolve only this player action in the fixed Aelvia world. Never include world in a state diff. Use specialized write tools for time, item use, survival, equipment, or player reset, and aegis_apply_state_diff for other progress changes. Narrate completion only after the required write succeeds. After every write is finished, call aegis_show_dashboard exactly once with turn_id=${turn.turnId}; never show an intermediate revision or reuse an older turnId. If the client tool schema does not expose turn_id, call aegis_show_dashboard exactly once with game_id only so the server can atomically claim the active turn. Do not offer manual save or load.`,
      };
    }),
  );

  registerAppTool(
    server,
    "aegis_apply_state_diff",
    {
      title: "提交 AEGIS 狀態變更",
      description: "在永久進度確實改變時提交一個已準備回合；world 是固定的艾爾維亞世界本體，禁止修改。直接陣列代表完整覆寫，空陣列代表清空；增量修改使用明確操作。",
      inputSchema: {
        game_id: gameIdSchema,
        expected_revision: z.number().int().nonnegative().describe("aegis_prepare_turn 回傳的 revision。"),
        idempotency_key: idempotencySchema,
        diff: z.record(z.unknown()).describe(
          "只含 player、inventory、npcs、compendium、map、quests、history；world 是固定的艾爾維亞世界本體，禁止傳入。集合使用 replace/upsert/remove；直接陣列是完整替換。不得指定 player.clock/date/time/season 或伺服器 metadata。map 使用 mapId、kind、discovery；routes 使用 routeId/toMapId/estimatedMinutes/knowledgeStatus，facilities 與 knownDangers 使用穩定 ID。npcs 使用 npcId 與玩家已知的 relationship.label、location、knownInformation、services、memories。quests 使用 questId。compendium 使用 entryId/category/categoryLabel/stage/facts；每個 fact 需 factId、text、至少一項 sources 與 confidence。history 使用結構化事件。舊版 estimatedTravel、text、knownFacts 等欄位仍會在邊界正規化，但新呼叫應使用 v0.7.0 欄位。",
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
      description: "僅在玩家明確要求時原子重設角色進度、地圖、人物知識與圖鑑；固定世界艾爾維亞及僅供開發者使用的災難復原快照會保留。",
      inputSchema: {
        game_id: gameIdSchema,
        expected_revision: z.number().int().nonnegative(),
        idempotency_key: idempotencySchema,
        preserve_world: z.literal(true).default(true),
      },
      outputSchema: resultOutputSchema,
      annotations: impact(false, false, true, true),
      _meta: silentMeta("重設角色進度…", "角色進度已重設並自動保存"),
    },
    async ({ game_id, expected_revision, idempotency_key }) => safeTool(async () => {
      const reset = await service.resetPlayer(game_id, expected_revision, idempotency_key);
      return {
        game: toGameView(reset.game),
        changedPaths: reset.changedPaths,
        idempotentReplay: reset.idempotentReplay,
        message: reset.idempotentReplay
          ? "角色進度重設已完成，這是安全重試結果。"
          : "角色、物品、裝備、任務、歷史、地圖、人物知識、圖鑑與私密人物進度已原子重設；固定世界艾爾維亞保持不變。",
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
        elapsed_minutes: z.number().int().positive().max(43_200).optional().describe("新呼叫使用的整數遊戲分鐘。不得與 elapsed_hours 同時提供。"),
        elapsed_hours: z.number().positive().max(720).optional().describe("舊版相容欄位；新呼叫請改用 elapsed_minutes。"),
        activity: z.enum(["normal", "rest", "sleep", "travel", "combat", "running", "heavy_labor"]).default("normal"),
        environment: z.enum(["temperate", "hot", "cold"]).default("temperate"),
        reason: z.string().min(1).max(200),
        extra_hunger_cost: z.number().min(0).max(1000).default(0),
        extra_hydration_cost: z.number().min(0).max(1000).default(0),
        new_date: z.string().max(100).optional().describe("舊版相容輸入；伺服器會忽略並由 GameClock 產生日期。"),
        new_time: z.string().max(100).optional().describe("舊版相容輸入；伺服器會忽略並由 GameClock 產生時間。"),
        outcome_diff: z.record(z.unknown()).optional().describe(
          "與本次時間事件在同一交易提交的結果，可含 player（不得含 survival/clock/date/time/season）、inventory、npcs、compendium、map、quests，以及 history.append 的獨立事件；不得包含固定的 world，也不得重複加入主要時間或旅行事件。",
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
        input.elapsed_minutes,
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
    }), "AEGIS 綜合面板已依最新權威狀態產生。"),
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

async function safeTool(
  work: () => Promise<Record<string, unknown>>,
  successText?: string,
) {
  try {
    const result = await work();
    return {
      structuredContent: { result },
      content: [{ type: "text" as const, text: successText ?? JSON.stringify(result) }],
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
