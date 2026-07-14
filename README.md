# AEGIS ChatGPT RPG

AEGIS 是一個以 ChatGPT 作為敘事與判定引擎、以 MCP Server 保存權威世界狀態的開放世界文字 RPG。

這個 Repository 是從 `AEGIS Companion v6.7.7` 單檔 HTML 遷移出的第一個可執行版本。原始 HTML 完整保留在 `legacy/`；新的 ChatGPT App 不再依賴複製／貼上 State，而是讓 ChatGPT 透過 MCP 工具讀取、驗證與提交資料。

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/gcp1030082/aegis-chatgpt-rpg)

## 目前狀態

`v0.5.1` 個人試玩版已具備：

- Streamable HTTP MCP endpoint：本機 `/mcp`，部署時 `/mcp/<秘密>`
- ChatGPT 內嵌單一 AEGIS 綜合面板；手機以「角色／冒險／知識」二級導覽切換
- 地圖、人物與圖鑑玩家介面，只呈現已知資料、漸進知識、來源與可信程度
- `mapId`、`npcId`、`entryId` 唯一識別與交叉引用驗證；NPC 秘密及對話逐字稿禁止進入玩家知識狀態
- `prepare_turn` 與狀態查詢保持靜默，只有回合末的 `show_dashboard` 可以渲染面板
- `prepare_turn` 簽發持久化 `turnId`；檔案與 PostgreSQL 儲存層會原子拒絕過期回合及同一回合第二次 `show_dashboard`
- 面板依 `gameId + turnId + revision` 拒絕同回合重複或較舊更新，並允許新回合在未產生 revision 時正常顯示；頁籤切換不呼叫工具、不推進時間
- 可展開的背包物品詳情，以及「全部／消耗品／裝備／雜物／特殊」五個頁籤
- 每件實體物品的唯一 Instance ID，以及背包與裝備欄互斥的權威位置
- 原子化裝備、卸除與更換；裝備加成與物品位置同步更新
- 獨立技能與裝備分頁、動態技能分類，並相容既有中文部位與舊資料格式
- 分離的物品／技能說明、結構化效果、取得來源與限制資料
- 飽食度與補水度、生存階段、遊戲時間消耗、飲食與可補充容器
- 每回合自動呈現最新角色摘要，包含生命、魔力、體力、生存數值、日期、時間與地點
- 每次成功交易綁定自動保存；一般玩家不提供手動存檔或讀檔回溯
- 明確的陣列完整替換語意、固定欄位型別驗證與 `NO_STATE_CHANGE`
- 原子化玩家重設，清除玩家進度並保留世界設定與開發者災難復原快照
- 權威遊戲狀態與壓縮 Runtime Context
- 原子式 State Diff
- Revision optimistic concurrency control
- Idempotency key 防止工具重試造成重複結算
- 本機 JSON 檔案儲存
- PostgreSQL JSONB 生產儲存
- Render Blueprint、Docker 與 GitHub Actions CI
- 舊版 v6.7.7 管理介面：本機可選，正式部署預設關閉
- 型別檢查、單元測試與 MCP 端到端測試

## 架構

```text
玩家訊息
  ↓
ChatGPT ── 靜默 aegis_prepare_turn ──→ MCP Server ──→ 權威 State
  │                                      │
  ├─ 判定與繁中敘事                      ├─ Validator
  │                                      ├─ Revision / Idempotency
  └── 專用操作或 State Diff ────────────→└─ 交易＋自動保存
                                               │
ChatGPT Widget ←── 回合末唯一一次 show_dashboard ─┘
```

ChatGPT 負責理解玩家意圖、合理判定與敘事；MCP Server 負責資料真實性、持久化、驗證與衝突處理。任何寫入失敗時，模型不得把變更描述成已發生。

## MCP 工具

| 工具 | 類型 | 用途 |
|---|---|---|
| `aegis_create_game` | 寫入 | 建立新遊戲，不覆蓋既有 `game_id` |
| `aegis_get_game_state` | 靜默唯讀 | 查詢完整權威狀態，不渲染面板、不推進時間 |
| `aegis_prepare_turn` | 靜默控制 | 每個遊戲回合第一步，取得 Revision、相關狀態與規則，並簽發不改變遊戲 State 的 `turnId` |
| `aegis_apply_state_diff` | 寫入 | 驗證並原子提交一回合的 State Diff |
| `aegis_reset_player` | 破壞性寫入 | 原子重設玩家資料，保留世界與存檔快照 |
| `aegis_advance_time` | 寫入 | 依遊戲內經過時間、活動與環境結算生存消耗，並可原子提交旅行事件結果 |
| `aegis_apply_survival_event` | 寫入 | 以明確原因套用事件造成的飽食／補水增減 |
| `aegis_use_item` | 寫入 | 使用消耗品並同步修改數量／容量與生存狀態 |
| `aegis_refill_container` | 寫入 | 在既有合理來源補充可重複使用容器 |
| `aegis_equip_item` | 寫入 | 以唯一物品實例原子裝備或更換指定部位 |
| `aegis_unequip_item` | 寫入 | 原子卸除指定部位並把同一實例送回背包 |
| `aegis_show_dashboard` | 唯一 UI＋原子鎖 | 帶入本回合 `turnId`，在所有寫入完成後顯示角色、背包、裝備、技能、任務、地圖、人物、圖鑑與自動保存狀態 |

物品的持久分類值固定為 `consumable`、`equipment`、`misc`、`special`；「全部」只存在於介面，不會寫入物品資料。直接傳入 `inventory`、`quests`、`player.skills` 或歷史子欄位陣列時，代表完整替換，空陣列代表清空。裝備欄只能透過專用裝備工具修改，避免同一物品同時出現在背包與裝備欄。

一般玩家只有一條持續進度。成功的永久狀態交易即代表自動保存完成；資料層仍可保存僅供災難復原、遷移與除錯使用的內部快照，但 MCP 玩家工具不會列出或讀取它們。

地圖、人物與圖鑑是玩家知識投影，不是世界全知資料。新地點、新 NPC 或新知識必須與事件結果在同一筆成功交易中寫入後，才能出現在敘述與面板；沒有權威路線資料時，介面只會說明尚無資料，不會生成精確地圖。

## 本機執行

需求：Node.js 20 以上。

```bash
npm install
cp .env.example .env
npm run dev
```

健康檢查：`http://localhost:8787/healthz`

MCP endpoint：`http://localhost:8787/mcp`

若要開啟舊版管理介面，在 `.env` 設定 `AEGIS_ENABLE_LEGACY_ADMIN=true`，再前往 `http://localhost:8787/admin`。

## 測試

```bash
npm run check
npm run build
```

若要對指定 PostgreSQL 執行不碰既有遊戲資料的端到端驗收，可另設測試連線後執行：

```bash
AEGIS_POSTGRES_E2E_URL="postgresql://..." npm run verify:postgres
```

驗收程式會使用隨機 `game_id` 測試狀態、災難復原快照、重啟後持久性、並發面板鎖，再清除自己的測試資料。需要 SSL 時加上 `AEGIS_POSTGRES_E2E_SSL=true`。

只有手機或沒有本機終端機時，可在 GitHub Repository 的 Actions secrets 新增 `AEGIS_POSTGRES_E2E_URL`，值填 Render PostgreSQL 的 External Database URL；接著手動執行 **PostgreSQL E2E** workflow。Secret 不會寫入 Repository，workflow 會強制使用 SSL，並執行同一套隨機資料驗收與清理流程。

MCP Inspector：

```bash
npx @modelcontextprotocol/inspector@latest \
  --server-url http://localhost:8787/mcp \
  --transport http
```

## 儲存方式

### 本機檔案

預設將權威進度寫入 `./data/games`，並可將開發者災難復原快照寫入 `./data/saves`。適合開發與單機測試。

```env
AEGIS_STORAGE_DRIVER=file
AEGIS_DATA_DIR=./data
```

### PostgreSQL

正式部署建議使用 PostgreSQL。Server 會自動建立 `aegis_games` 與僅供內部復原的 `aegis_saves` 資料表，State 以 JSONB 保存。

```env
AEGIS_STORAGE_DRIVER=postgres
DATABASE_URL=postgresql://user:password@host:5432/aegis
DATABASE_SSL=true
```

也可以用 Docker Compose 啟動本機 PostgreSQL 與 App：

```bash
POSTGRES_PASSWORD=請自行設定本機密碼 docker compose up --build
```

## 免費個人試玩部署

Repository 內的 `render.yaml` 可以一次建立 HTTPS Web Service 與 PostgreSQL：

1. 點擊頁首的 **Deploy to Render**。
2. 用 GitHub 登入並允許 Render 存取此私人 Repository。
3. 為 `AEGIS_MCP_PATH_SECRET` 輸入 16–128 字元的隨機秘密。
4. 部署完成後，MCP URL 為 `https://你的服務.onrender.com/mcp/你的秘密`。

手機逐步說明與免費方案限制請見 [`docs/deploy-render.md`](docs/deploy-render.md)。Render 免費 PostgreSQL 會在建立 30 天後到期，因此這條路徑只用於本次試玩；之後可將 `DATABASE_URL` 改接長期 PostgreSQL。

## 連接 ChatGPT

1. 將 MCP Server 部署至可由 ChatGPT 存取的 HTTPS 網址，或在開發時使用安全 Tunnel。
2. 在 ChatGPT 網頁版開啟 Developer mode。
3. 前往 Settings → Plugins，建立 developer-mode app。
4. MCP URL 填入 `https://你的網域/mcp`；若設定了秘密路徑，則填入 `https://你的網域/mcp/你的秘密`。
5. 開啟新對話，從工具選單加入 AEGIS。

範例：

```text
使用 AEGIS 建立 game_id 為 main 的新遊戲，然後替我隨機創建一名男性角色。
```

```text
在 main 繼續遊戲：我先觀察四周，不採取其他行動。
```

```text
顯示 main 的 AEGIS 儀表板。
```

## 資料安全

- 不要把 `.env`、資料庫密碼或 Token 提交到 Git。
- 個人部署務必設定 `AEGIS_MCP_PATH_SECRET`，並把完整 MCP URL 當成密碼保管。
- 正式部署預設不提供 `/admin`；只有明確設定 `AEGIS_ENABLE_LEGACY_ADMIN=true` 才會開啟。
- `file` driver 不適合無持久磁碟的 Serverless 平台。
- 目前 MVP 是私人開發模式，尚未加入多人帳號 OAuth。公開部署前必須完成使用者身分隔離、存取控制、隱私政策與濫用防護。
- `game_id` 不是密碼，不能把難猜的 ID 當成授權機制。

## Legacy Companion

`legacy/aegis_companion_v6_7_7.html` 與上傳原檔的 SHA-256 相同：

```text
b5105e1b912e9a2818d84159f49b80379d9eb7f546c62886514b8a224d8196b0
```

它目前作為資料格式參照與舊存檔管理介面保留。後續里程碑會加入正式的 Legacy State 匯入器，將瀏覽器 `localStorage` 存檔遷移到 MCP 儲存層。

## 下一階段

- 將 v6.7.7 Schema Registry 與 Runtime Rules 全量拆分成版本化檔案
- Legacy JSON 匯入與 Migration Report
- OAuth 與每位玩家的資料隔離
- 世界背景事件與非玩家回合 Simulation Queue
- State Diff JSON Schema 與更細緻的數值／裝備／任務驗證
- 將試玩資料庫遷移到不會在 30 天後到期的 PostgreSQL

## 官方開發依據

- [OpenAI Apps SDK Quickstart](https://developers.openai.com/apps-sdk/quickstart)
- [Build your MCP server](https://developers.openai.com/apps-sdk/build/mcp-server)
- [Managing State](https://developers.openai.com/apps-sdk/build/state-management)
- [Connect from ChatGPT](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt)
