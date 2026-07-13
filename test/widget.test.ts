import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";

describe("AEGIS dashboard widget", () => {
  it("ships the localized authoritative panel, five inventory categories, equipment, skills, and auto-save", async () => {
    const html = await readFile(resolve("public/aegis-widget.html"), "utf8");

    expect(html).toContain('data-tab="inventory"');
    expect(html).toContain('data-tab="equipment"');
    expect(html).toContain('data-tab="skills"');
    expect(html).toContain("點擊物品可查看數量、效果、來源與完整資料");
    expect(html).toContain('version: "0.4.0"');
    for (const category of ["all", "consumable", "equipment", "misc", "special"]) {
      expect(html).toContain(`data-inventory-category="${category}"`);
    }
    expect(html).toContain("飽食度");
    expect(html).toContain("補水度");
    expect(html).toContain('["體力", resourceValue(player, "sp")]');
    expect(html).toContain("進度已自動保存");
    expect(html).toContain("function survivalStatus");
    expect(html).toContain("function renderInventory");
    expect(html).toContain("function renderEquipment");
    expect(html).toContain("function renderSkills");
    expect(html).toContain("function renderSkillTabs");
    expect(html).toContain("function formatAcquisition");
    expect(html).toContain("function formatItemEffects");
    expect(html).toContain('consumable: "消耗品"');
    expect(html).toContain('good: "狀態良好"');
    expect(html).toContain("其他資料");
    expect(html).not.toContain('data-tab="saves"');
    expect(html).not.toContain("存檔列表");
    expect(html).not.toContain("`rev ${game.revision}`");
    expect(html).not.toContain("innerHTML");
  });

  it("contains syntactically valid widget JavaScript", async () => {
    const html = await readFile(resolve("public/aegis-widget.html"), "utf8");
    const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
    if (!script) throw new Error("找不到 widget module script");
    expect(() => new Script(script)).not.toThrow();
  });

  it("does not expose internal enum names in static player-facing markup and has a safe translation fallback", async () => {
    const html = await readFile(resolve("public/aegis-widget.html"), "utf8");
    const markup = html.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<script[\s\S]*?<\/script>/, "");
    for (const internal of ["consumable", "equipment", "misc", "special", "hungerStage", "focusMultiplier"]) {
      expect(markup).not.toContain(`>${internal}<`);
    }
    expect(html).toContain("[AEGIS i18n] 缺少欄位翻譯");
    expect(html).toContain('return "擴充資料"');
    expect(html).not.toContain('return String(key).replace');
  });
});
