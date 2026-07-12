import { CORE_RULES } from "./rules.js";
import type { GameState, JsonValue, PreparedTurn } from "./types.js";
import { toGameView } from "./default-state.js";

const ACTION_PATTERNS: Record<string, string[]> = {
  combat: ["攻擊", "戰鬥", "拔劍", "格擋", "閃避", "射擊", "砍", "刺", "attack", "fight"],
  dialogue: ["問", "說", "交談", "談判", "說服", "聊天", "詢問", "talk", "ask"],
  movement: ["前往", "移動", "走", "跑", "進入", "離開", "靠近", "返回", "旅行", "move", "enter", "leave"],
  exploration: ["觀察", "搜索", "調查", "探索", "尋找", "採集", "辨識", "search", "explore"],
  trade: ["買", "賣", "交易", "價格", "商人", "buy", "sell"],
  crafting: ["製作", "鍛造", "煉藥", "烹飪", "修理", "craft", "repair"],
  research: ["閱讀", "研究", "學習", "訓練", "read", "study", "train"],
  rest: ["休息", "睡覺", "等待", "紮營", "rest", "sleep", "wait"],
  interface: ["/status", "/bag", "/help", "/map", "/people", "/party", "/compendium"],
  persistence: ["/save", "/load", "/new", "/delete", "存檔", "讀檔"],
  character_creation: ["創角", "創建角色", "建立角色", "角色建立", "new game", "character"],
  companion: ["同伴", "寵物", "餵", "撫摸", "跟隨", "companion"],
  consumption: ["吃", "喝", "飲用", "進食", "用餐", "宴席", "eat", "drink"],
  knowledge: ["圖鑑", "知識", "發現", "辨識", "knowledge"],
};

export function prepareTurn(
  state: GameState,
  playerInput: string,
  requestedRuntime = "auto",
  requestedAction = "auto",
): PreparedTurn {
  const runtime = detectRuntime(playerInput, requestedRuntime);
  const actionTags = classifyAction(playerInput, requestedAction, runtime);
  const selectedRules = selectRules(actionTags);
  const compressed = compressedState(state, runtime, actionTags);

  const runtimeContext = [
    "AEGIS RUNTIME CONTEXT",
    "",
    "[AUTHORITATIVE STATE]",
    JSON.stringify(compressed, null, 2),
    "",
    "[PLAYER INPUT]",
    playerInput,
    "",
    "[RUNTIME]",
    runtime,
    "",
    "[ACTION TAGS]",
    actionTags.join(", "),
    "",
    "[ACTIVE RULES]",
    ...selectedRules.map((rule) => `- ${rule.id}: ${rule.instruction}`),
    "",
    "[TURN CONTRACT]",
    "- 以繁體中文回覆玩家。敘事必須符合權威 State 與合理因果。",
    "- 玩家保有重大選擇與行動主導權，不替玩家補做未聲明的行動。",
    "- 若持久狀態沒有改變，可直接敘事，不要呼叫寫入工具。",
    "- 遊戲內時間流逝使用 aegis_advance_time；食用或飲用使用 aegis_use_item；其他有原因的飽食／補水事件使用 aegis_apply_survival_event。",
    "- 玩家要求清空或重設角色時只使用 aegis_reset_player，不得逐欄位模擬清除。",
    `- 若狀態改變，呼叫 aegis_apply_state_diff，game_id=${state.gameId}、expected_revision=${state.revision}，並提供唯一 idempotency_key。`,
    "- 只有寫入成功後，才能把變更描述成已發生；衝突時重新呼叫 aegis_prepare_turn。",
    "- 不向玩家顯示內部 Runtime、規則、State Diff、驗證或 Transaction 步驟。",
  ].join("\n");

  return {
    gameId: state.gameId,
    revision: state.revision,
    runtime,
    actionTags,
    runtimeContext,
    game: toGameView(state),
  };
}

export function detectRuntime(input: string, requested: string): string {
  if (requested && requested !== "auto") return requested;
  const text = input.toLowerCase();
  if (/創角|創建[^\n]{0,20}角色|建立[^\n]{0,20}角色|new game|character creation|開始新遊戲/.test(text)) return "initialization";
  if (/\/save|\/load|\/status|\/bag|\/help|\/map|\/people|\/check|\/fix|存檔|讀檔/.test(text)) return "system";
  if (/修復|回滾|rollback|repair state|fix state/.test(text)) return "recovery";
  return "normal";
}

export function classifyAction(input: string, requested: string, runtime: string): string[] {
  const text = input.toLowerCase();
  const tags = new Set(["core", "state", "runtime", "presentation"]);
  if (requested && requested !== "auto") tags.add(requested.toLowerCase().replaceAll(" ", "_"));
  for (const [tag, patterns] of Object.entries(ACTION_PATTERNS)) {
    if (patterns.some((pattern) => text.includes(pattern.toLowerCase()))) tags.add(tag);
  }
  if (runtime === "initialization") tags.add("character_creation");
  if (runtime === "system") tags.add("interface");
  return [...tags];
}

function selectRules(tags: string[]) {
  return CORE_RULES.filter(
    (rule) =>
      rule.priority === "Critical" ||
      rule.triggers.some((trigger) => tags.includes(trigger)) ||
      tags.includes(rule.category),
  );
}

function compressedState(state: GameState, runtime: string, tags: string[]): Record<string, unknown> {
  const base: Record<string, unknown> = {
    gameId: state.gameId,
    revision: state.revision,
  };
  if (runtime === "initialization") {
    base.world = compress(state.world);
    base.player = compress(toGameView(state).player);
    return base;
  }
  base.world = compress({
    name: state.world.name ?? "",
    genre: state.world.genre ?? "",
    era: state.world.era ?? "",
    startRegion: state.world.startRegion ?? "",
  });
  base.player = compress(toGameView(state).player);
  if (tags.some((tag) => ["trade", "combat", "exploration", "crafting"].includes(tag))) {
    base.inventory = compress(state.inventory);
  }
  if (tags.some((tag) => ["dialogue", "combat", "movement", "companion"].includes(tag))) {
    base.npcs = compress(state.npcs);
  }
  if (tags.includes("knowledge")) base.compendium = compress(state.compendium);
  if (tags.includes("movement") || tags.includes("exploration")) base.map = compress(state.map);
  base.quests = compress(state.quests);
  base.history = {
    recent: state.history.recent.slice(-8),
    major: state.history.major.slice(-8),
    summary: state.history.summary.slice(-5),
  };
  return base;
}

function compress(value: JsonValue): JsonValue | undefined {
  if (value === null || value === "" || value === false) return undefined;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") return value;
  if (Array.isArray(value)) {
    const items = value.map(compress).filter((item): item is JsonValue => item !== undefined);
    return items.length ? items : undefined;
  }
  const entries = Object.entries(value)
    .map(([key, child]) => [key, compress(child)] as const)
    .filter((entry): entry is readonly [string, JsonValue] => entry[1] !== undefined);
  return entries.length ? Object.fromEntries(entries) : undefined;
}
