export interface RuntimeRule {
  id: string;
  category: string;
  priority: "Critical" | "High" | "Normal";
  triggers: string[];
  instruction: string;
}

export const CORE_RULES: RuntimeRule[] = [
  {
    id: "WORLD_001",
    category: "core",
    priority: "Critical",
    triggers: ["core"],
    instruction: "世界優先於劇情。世界不依附玩家，結果必須由既有狀態、角色能力與合理因果推出。",
  },
  {
    id: "STATE_001",
    category: "state",
    priority: "Critical",
    triggers: ["state"],
    instruction: "MCP 回傳的 Persistent State 是唯一權威資料。敘事不能自行建立、遺忘、複製或刪除持久狀態。",
  },
  {
    id: "STATE_002",
    category: "state",
    priority: "Critical",
    triggers: ["state"],
    instruction: "凡持久狀態改變，必須先成功呼叫 aegis_apply_state_diff；寫入失敗時不得宣稱變更已發生。",
  },
  {
    id: "PLAYER_001",
    category: "presentation",
    priority: "Critical",
    triggers: ["presentation"],
    instruction: "玩家擁有行動主導權。不得替玩家決定未輸入的重大選擇、台詞或長期目標。",
  },
  {
    id: "KNOWLEDGE_001",
    category: "knowledge",
    priority: "High",
    triggers: ["knowledge", "exploration", "dialogue"],
    instruction: "只呈現玩家能由感官、記憶、技能或可靠來源得知的資訊；未知事實不可直接揭露。",
  },
  {
    id: "COMBAT_001",
    category: "combat",
    priority: "High",
    triggers: ["combat"],
    instruction: "戰鬥結果必須考慮能力、裝備、環境、資訊與行動方法；不可為迎合劇情保證成功。",
  },
  {
    id: "ECONOMY_001",
    category: "trade",
    priority: "High",
    triggers: ["trade", "crafting"],
    instruction: "物品、貨幣與裝備變化必須守恆並同步更新；不得無原因產生或消失。",
  },
  {
    id: "TIME_001",
    category: "world",
    priority: "High",
    triggers: ["movement", "rest", "combat", "crafting"],
    instruction: "只有實際耗時的行動推進時間與 tick；介面查詢、讀檔與純說明不推進世界。",
  },
  {
    id: "SURVIVAL_001",
    category: "state",
    priority: "Critical",
    triggers: ["movement", "rest", "combat", "consumption"],
    instruction: "實際遊戲時間流逝必須呼叫 aegis_advance_time 結算飽食度與補水度；食用或飲用物品必須呼叫 aegis_use_item，不得只在敘述中處理。",
  },
  {
    id: "SURVIVAL_002",
    category: "survival",
    priority: "High",
    triggers: ["movement", "rest", "combat", "consumption"],
    instruction: "生存懲罰必須依狀態階段漸進；飽食度或補水度為 0 時不得立即死亡，只能在持續經過時間後產生合理生命或身體異常影響。",
  },
];
