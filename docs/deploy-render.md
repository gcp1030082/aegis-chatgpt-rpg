# 使用 Render 部署個人試玩版

這個流程會建立一個免費 HTTPS Web Service 與一個免費 Render PostgreSQL，適合 AEGIS 的個人開發測試。

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/gcp1030082/aegis-chatgpt-rpg)

## 1. 建立服務

1. 用 GitHub 登入 Render。
2. 允許 Render 存取 `gcp1030082/aegis-chatgpt-rpg`。
3. 若按鈕沒有直接開啟 Blueprint，選擇 **New → Blueprint**，再選取此 Repository。
4. Render 會讀取根目錄的 `render.yaml`，準備建立 Web Service 與 PostgreSQL。
5. 在 `AEGIS_MCP_PATH_SECRET` 欄位輸入一組 16–128 字元的隨機秘密，只能使用英數、底線與連字號。不要公開這組秘密。
6. 選擇 **Deploy Blueprint**，等待 Web Service 顯示 `Live`。

## 2. 取得 MCP URL

假設 Render 服務網址是：

```text
https://aegis-chatgpt-rpg.onrender.com
```

而秘密是：

```text
你的隨機秘密
```

要交給 ChatGPT 的 MCP URL 就是：

```text
https://aegis-chatgpt-rpg.onrender.com/mcp/你的隨機秘密
```

秘密不會顯示在首頁或伺服器啟動記錄。遺失時可在 Render 的 Environment 頁面更新，之後同步更新 ChatGPT App URL。

## 3. 先喚醒免費服務

免費 Web Service 閒置後會休眠。連接 ChatGPT 前，先用瀏覽器開啟：

```text
https://你的服務.onrender.com/healthz
```

看到包含 `"ok":true` 的 JSON 後再連接 ChatGPT。

## 4. 連接 ChatGPT

1. 在 ChatGPT 網頁版前往 **Settings → Security and login**，開啟 Developer mode。
2. 前往 **Settings → Plugins** 或 `https://chatgpt.com/plugins`。
3. 建立 developer-mode app。
4. 名稱填 `AEGIS RPG`，MCP URL 填入第 2 節的完整秘密 URL。
5. 工具掃描成功後開啟新對話，從 `+ → More` 加入 AEGIS。
6. 輸入：

```text
使用 AEGIS 建立 game_id 為 main 的新遊戲，替我隨機建立一名男性角色，然後顯示儀表板。
```

## 免費方案限制

- Render 免費 Web Service 閒置 15 分鐘會休眠，重新喚醒約需一分鐘。
- Render 免費 PostgreSQL 建立 30 天後到期，且沒有備份，僅適合本次試玩。
- 到期前應升級資料庫或把 `DATABASE_URL` 換成長期 PostgreSQL（例如 Neon）。程式碼不需改寫。
- `AEGIS_MCP_PATH_SECRET` 是個人試玩保護，不是多人 OAuth。不要分享完整 MCP URL；公開發行前必須實作正式登入與使用者隔離。
