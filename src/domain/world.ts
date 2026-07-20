import { isDeepStrictEqual } from "node:util";
import { DEFAULT_CALENDAR } from "./clock.js";
import { AegisError } from "./errors.js";
import type { JsonObject } from "./types.js";

export const AELVIA_WORLD_ID = "aelvia";
export const AELVIA_WORLD_VERSION = "aelvia-v1";

export function canonicalWorldState(): JsonObject {
  return {
    worldId: AELVIA_WORLD_ID,
    worldVersion: AELVIA_WORLD_VERSION,
    name: "艾爾維亞",
    genre: "劍與魔法的異世界",
    era: "群星曆的中世紀魔法時代",
    civilization: "人類王國、精靈領地、矮人城邦、獸人部族與其他多種族文明並存",
    technology: "中世紀工藝與魔導技術並行",
    magic: "魔力、屬性魔法、神聖術、精靈術、召喚術、鍊金術與魔導具共同存在",
    currency: "銅幣、銀幣與金幣",
    language: "大陸通用語與各種族語言",
    religion: "多神信仰、地方信仰與精靈崇拜並存",
    startRegion: "艾爾維亞大陸；具體起點由角色建立流程決定",
    calendar: structuredClone(DEFAULT_CALENDAR) as unknown as JsonObject,
    survivalBalance: {
      hungerPerGameHour: 2,
      hydrationPerGameHour: 3,
    },
    elements: [
      "冒險者公會與委託",
      "地下城、迷宮與古代遺跡",
      "魔物、魔獸、龍與精靈",
      "王國、帝國、城邦與邊境領地",
      "多種族社會與跨種族文化",
      "教會、魔法學院、商會與職人工坊",
      "鍊金術、魔導具、附魔與製作",
      "異世界來訪者、失落文明與未知領域",
    ],
    notes: "艾爾維亞是不可由玩家工具改寫的固定世界本體；角色進度與玩家已知的地圖、人物、任務及圖鑑可獨立重設。",
  };
}

export function validateCanonicalWorld(world: JsonObject): void {
  if (!isDeepStrictEqual(world, canonicalWorldState())) {
    throw new AegisError(
      "INVALID_STATE",
      "world 必須維持伺服器定義的艾爾維亞固定世界；玩家工具不得修改世界本體。",
    );
  }
}
