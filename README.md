# AEGIS ChatGPT RPG

AEGIS 是一個以 ChatGPT 作為敘事與判定引擎、以 MCP Server 保存權威世界狀態的開放世界文字 RPG。

這個 Repository 是從 `AEGIS Companion v6.7.7` 單檔 HTML 遷移出的第一個可執行版本。原始 HTML 完整保留在 `legacy/`；新的 ChatGPT App 不再依賴複製／貼上 State，而是讓 ChatGPT 透過 MCP 工具讀取、驗證與提交資料。

## 目前狀態

`v0.1.0` MVP 已具備：

- Streamable HTTP MCP endpoint：`/mcp`
- ChatGPT 內嵌 AEGIS 儀表板
- 權威遊戲狀態與壓縮 Runtime Context
- 原子式 State Diff
- Revision optimistic concurrency control
- Idempotency key 防止工具重試造成重複結算
- 手動 Save Slots 與讀檔
- 本機 JSON 檔案儲存
- PostgreSQL JSONB 生產儲存
- 舊版 v6.7.7 管理介面：`/admin`
- 型別檢查、單元測試與 MCP 端到端測試

## 架構

```text
玩家訊息
  ↓
ChatGPT ── aegis_prepare_turn ──→ MCP Server ──→ 權威 State
  │                                      │
  ├─ 判定與繁中敘事                      ├─ Validator
  │                                      ├─ Revision / Idempotency
  └── aegis_apply_state_diff ───────────→└─ File 或 PostgreSQL

ChatGPT Widget ←── aegis_show_dashboard ── MCP Server
```

ChatGPT 負責理解玩家意圖、合理判定與敘事；MCP Server 負責資料真實性、持久化、驗證與衝突處理。任何寫入失敗時，模型不得把變更描述成已發生。

## MCP 工具

| 工具 | 類型 | 用途 |
|---|---|---|
| `aegis_create_game` | 寫入 | 建立新遊戲，不覆蓋既有 `game_id` |
| `aegis_get_game_state` | 唯讀 | 查詢完整權威狀態，不推進時間 |
| `aegis_prepare_turn` | 唯讀 | 每個遊戲回合第一步，取得 Revision、相關狀態與規則 |
| `aegis_apply_state_diff` | 寫入 | 驗證並原子提交一回合的 State Diff |
| `aegis_create_save` | 寫入 | 建立狀態快照 |
| `aegis_list_saves` | 唯讀 | 列出遊戲存檔 |
| `aegis_load_save` | 破壞性寫入 | 用指定快照覆蓋目前狀態 |
| `aegis_show_dashboard` | 唯讀＋UI | 在 ChatGPT 顯示角色、背包、任務與存檔 |

## 本機執行

需求：Node.js 20 以上。

```bash
npm install
cp .env.example .env
npm run dev
```

健康檢查：`http://localhost:8787/healthz`

MCP endpoint：`http://localhost:8787/mcp`

舊版管理介面：`http://localhost:8787/admin`

## 測試

```bash
npm run check
npm run build
```

MCP Inspector：

```bash
npx @modelcontextprotocol/inspector@latest \
  --server-url http://localhost:8787/mcp \
  --transport http
```

## 儲存方式

### 本機檔案

預設將 JSON 寫入 `./data/games` 與 `./data/saves`。適合開發與單機測試。

```env
AEGIS_STORAGE_DRIVER=file
AEGIS_DATA_DIR=./data
```

### PostgreSQL

正式部署建議使用 PostgreSQL。Server 會自動建立 `aegis_games` 與 `aegis_saves` 資料表，State 以 JSONB 保存。

```env
AEGIS_STORAGE_DRIVER=postgres
DATABASE_URL=postgresql://user:password@host:5432/aegis
DATABASE_SSL=true
```

也可以用 Docker Compose 啟動本機 PostgreSQL 與 App：

```bash
docker compose up --build
```

## 連接 ChatGPT

1. 將 MCP Server 部署至可由 ChatGPT 存取的 HTTPS 網址，或在開發時使用安全 Tunnel。
2. 在 ChatGPT 網頁版開啟 Developer mode。
3. 前往 Settings → Plugins，建立 developer-mode app。
4. MCP URL 填入 `https://你的網域/mcp`。
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
- 部署、HTTPS endpoint 與 ChatGPT 實機測試

## 官方開發依據

- [OpenAI Apps SDK Quickstart](https://developers.openai.com/apps-sdk/quickstart)
- [Build your MCP server](https://developers.openai.com/apps-sdk/build/mcp-server)
- [Managing State](https://developers.openai.com/apps-sdk/build/state-management)
- [Connect from ChatGPT](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt)
