import { AegisError } from "./errors.js";
import type { JsonObject } from "./types.js";

const CATEGORY_ALIASES: Record<string, { id: string; label: string }> = {
  combat: { id: "combat", label: "戰鬥" }, "戰鬥": { id: "combat", label: "戰鬥" },
  magic: { id: "magic", label: "魔法" }, "魔法": { id: "magic", label: "魔法" },
  survival: { id: "survival", label: "求生" }, "求生": { id: "survival", label: "求生" },
  production: { id: "production", label: "生產" }, crafting: { id: "production", label: "生產" }, "生產": { id: "production", label: "生產" },
  knowledge: { id: "knowledge", label: "知識" }, "知識": { id: "knowledge", label: "知識" },
  social: { id: "social", label: "社交" }, "社交": { id: "social", label: "社交" },
  special: { id: "special", label: "特殊" }, "特殊": { id: "special", label: "特殊" },
  unique: { id: "unique", label: "唯一" }, "唯一": { id: "unique", label: "唯一" },
  other: { id: "other", label: "其他" }, "其他": { id: "other", label: "其他" },
};

export function normalizeSkills(values: JsonObject[], strict = false): JsonObject[] {
  return values.map((raw, index) => normalizeSkill({ ...raw }, `player.skills[${index}]`, strict));
}

export function normalizeSkill(skill: JsonObject, path: string, strict = false): JsonObject {
  const rawCategory = typeof skill.category === "string"
    ? skill.category.trim()
    : typeof skill.type === "string" ? skill.type.trim() : "";
  const alias = CATEGORY_ALIASES[rawCategory.toLowerCase()] ?? CATEGORY_ALIASES[rawCategory];
  if (alias) {
    skill.category = alias.id;
    skill.categoryLabel = alias.label;
  } else if (rawCategory) {
    const label = typeof skill.categoryLabel === "string" ? skill.categoryLabel.trim() : "";
    if (/^[\u3400-\u9fff]/u.test(rawCategory)) {
      skill.category = rawCategory;
      skill.categoryLabel = rawCategory;
    } else if (label && /[\u3400-\u9fff]/u.test(label)) {
      skill.category = rawCategory.toLowerCase();
      skill.categoryLabel = label;
    } else if (strict) {
      throw new AegisError("INVALID_DIFF", `${path}.category 的自訂分類必須提供繁體中文 categoryLabel。`);
    } else {
      skill.category = "other";
      skill.categoryLabel = "其他";
    }
  } else {
    skill.category = "other";
    skill.categoryLabel = "其他";
  }

  if (skill.tags !== undefined && !Array.isArray(skill.tags)) {
    throw new AegisError("INVALID_DIFF", `${path}.tags 必須是陣列。`);
  }
  if (Array.isArray(skill.tags) && skill.tags.some((tag) => typeof tag !== "string")) {
    throw new AegisError("INVALID_DIFF", `${path}.tags 必須是字串陣列。`);
  }
  if (skill.effects !== undefined) {
    if (!Array.isArray(skill.effects) || skill.effects.some((effect) => !isObject(effect))) {
      throw new AegisError("INVALID_DIFF", `${path}.effects 必須是物件陣列。`);
    }
    skill.effects.forEach((raw, index) => {
      const effect = raw as JsonObject;
      if (typeof effect.type !== "string" || !effect.type.trim()) {
        throw new AegisError("INVALID_DIFF", `${path}.effects[${index}].type 必須是非空字串。`);
      }
      if (effect.value !== undefined && (typeof effect.value !== "number" || !Number.isFinite(effect.value))) {
        throw new AegisError("INVALID_DIFF", `${path}.effects[${index}].value 必須是有限數字。`);
      }
    });
  }
  if (!isObject(skill.acquisition) && typeof skill.source === "string" && skill.source.trim()) {
    const initial = /初始技能|角色創建|角色建立/.test(skill.source);
    skill.acquisition = {
      type: initial ? "initial_skill" : "recorded_source",
      sourceName: initial ? "角色創建" : skill.source,
    };
  }
  if (isObject(skill.acquisition)) {
    if (typeof skill.acquisition.type !== "string" || !skill.acquisition.type.trim()) {
      if (strict) throw new AegisError("INVALID_DIFF", `${path}.acquisition.type 必須是非空字串。`);
      skill.acquisition.type = "recorded_source";
    }
    if (skill.acquisition.sourceName !== undefined && typeof skill.acquisition.sourceName !== "string") {
      throw new AegisError("INVALID_DIFF", `${path}.acquisition.sourceName 必須是字串。`);
    }
  } else if (skill.acquisition !== undefined) {
    throw new AegisError("INVALID_DIFF", `${path}.acquisition 必須是物件。`);
  }
  if (skill.category === "unique") {
    if (typeof skill.uniqueScope !== "string" || !skill.uniqueScope || typeof skill.uniqueHolderId !== "string" || !skill.uniqueHolderId) {
      throw new AegisError(
        strict ? "INVALID_DIFF" : "INVALID_STATE",
        `${path} 標記為唯一技能時，必須有 uniqueScope 與 uniqueHolderId 的權威紀錄。`,
      );
    }
  }
  return skill;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
