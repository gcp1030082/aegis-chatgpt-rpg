import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";

describe("AEGIS dashboard widget", () => {
  it("ships expandable inventory details plus equipment and skill tabs", async () => {
    const html = await readFile(resolve("public/aegis-widget.html"), "utf8");

    expect(html).toContain('data-tab="inventory"');
    expect(html).toContain('data-tab="equipment"');
    expect(html).toContain('data-tab="skills"');
    expect(html).toContain("點擊物品可查看數量、效果、來源與完整資料");
    expect(html).toContain('version: "0.2.0"');
    expect(html).toContain("function renderInventory");
    expect(html).toContain("function renderEquipment");
    expect(html).toContain("function renderSkills");
    expect(html).toContain("其他資料");
    expect(html).not.toContain("innerHTML");
  });

  it("contains syntactically valid widget JavaScript", async () => {
    const html = await readFile(resolve("public/aegis-widget.html"), "utf8");
    const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
    if (!script) throw new Error("找不到 widget module script");
    expect(() => new Script(script)).not.toThrow();
  });
});
