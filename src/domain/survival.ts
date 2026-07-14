import type { JsonObject, JsonValue } from "./types.js";
import { isObject } from "./validation.js";

export const SURVIVAL_ACTIVITIES = [
  "normal", "rest", "sleep", "travel", "combat", "running", "heavy_labor",
] as const;
export type SurvivalActivity = (typeof SURVIVAL_ACTIVITIES)[number];

export const SURVIVAL_ENVIRONMENTS = ["temperate", "hot", "cold"] as const;
export type SurvivalEnvironment = (typeof SURVIVAL_ENVIRONMENTS)[number];

export interface SurvivalSnapshot {
  hunger: number;
  hydration: number;
  elapsedGameMinutes: number;
}

export interface SurvivalTransition {
  metric: "hunger" | "hydration";
  from: string;
  to: string;
  label: string;
}

const ACTIVITY_FACTORS: Record<SurvivalActivity, [number, number]> = {
  normal: [1, 1],
  rest: [0.75, 0.75],
  sleep: [0.65, 0.65],
  travel: [1.25, 1.25],
  combat: [1.5, 1.5],
  running: [1.6, 1.7],
  heavy_labor: [1.5, 1.5],
};

const ENVIRONMENT_FACTORS: Record<SurvivalEnvironment, [number, number]> = {
  temperate: [1, 1],
  hot: [1, 1.5],
  cold: [1, 0.75],
};

export function survivalView(player: JsonObject): JsonObject {
  const snapshot = survivalSnapshot(player);
  const hungerStage = survivalStage(snapshot.hunger);
  const hydrationStage = survivalStage(snapshot.hydration);
  const hungerEffects = stageEffects(hungerStage);
  const hydrationEffects = stageEffects(hydrationStage);
  return {
    ...snapshot,
    hungerStatus: survivalLabel("hunger", snapshot.hunger),
    hydrationStatus: survivalLabel("hydration", snapshot.hydration),
    hungerStage,
    hydrationStage,
    effects: {
      staminaRecoveryMultiplier: Math.min(hungerEffects.recovery, hydrationEffects.recovery),
      actionEfficiencyMultiplier: Math.min(hungerEffects.action, hydrationEffects.action),
      focusMultiplier: Math.min(hungerEffects.focus, hydrationEffects.focus),
      ongoingHealthRisk: hungerEffects.risk || hydrationEffects.risk,
    },
  };
}

export function survivalSnapshot(player: JsonObject): SurvivalSnapshot {
  const survival = isObject(player.survival) ? player.survival : {};
  return {
    hunger: finiteNumber(survival.hunger, 100),
    hydration: finiteNumber(survival.hydration, 100),
    elapsedGameMinutes: finiteNumber(survival.elapsedGameMinutes, 0),
  };
}

export function survivalPatch(snapshot: SurvivalSnapshot): JsonObject {
  return {
    hunger: round2(clamp(snapshot.hunger, 0, 100)),
    hydration: round2(clamp(snapshot.hydration, 0, 100)),
    elapsedGameMinutes: Math.max(0, Math.round(snapshot.elapsedGameMinutes)),
  };
}

export function calculateTimeSurvival(
  player: JsonObject,
  hours: number,
  activity: SurvivalActivity,
  environment: SurvivalEnvironment,
  extraHungerCost = 0,
  extraHydrationCost = 0,
  balance: JsonObject = {},
) {
  return calculateTimeSurvivalMinutes(
    player,
    Math.round(hours * 60),
    activity,
    environment,
    extraHungerCost,
    extraHydrationCost,
    balance,
  );
}

export function calculateTimeSurvivalMinutes(
  player: JsonObject,
  elapsedMinutes: number,
  activity: SurvivalActivity,
  environment: SurvivalEnvironment,
  extraHungerCost = 0,
  extraHydrationCost = 0,
  balance: JsonObject = {},
) {
  const before = survivalSnapshot(player);
  const hours = elapsedMinutes / 60;
  const [activityHunger, activityHydration] = ACTIVITY_FACTORS[activity];
  const [environmentHunger, environmentHydration] = ENVIRONMENT_FACTORS[environment];
  const modifiers = collectRateModifiers(player);
  const hungerPerHour = balanceRate(balance.hungerPerGameHour, 2);
  const hydrationPerHour = balanceRate(balance.hydrationPerGameHour, 3);
  const hungerCost = round2(
    hours * hungerPerHour * activityHunger * environmentHunger * modifiers.hunger + extraHungerCost,
  );
  const hydrationCost = round2(
    hours * hydrationPerHour * activityHydration * environmentHydration * modifiers.hydration + extraHydrationCost,
  );
  const after: SurvivalSnapshot = {
    hunger: clamp(before.hunger - hungerCost, 0, 100),
    hydration: clamp(before.hydration - hydrationCost, 0, 100),
    elapsedGameMinutes: before.elapsedGameMinutes + elapsedMinutes,
  };
  return {
    before,
    after,
    hungerCost,
    hydrationCost,
    modifiers: modifiers.reasons,
    transitions: survivalTransitions(before, after),
  };
}

function balanceRate(value: JsonValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? clamp(value, 0, 100) : fallback;
}

export function adjustSurvival(
  player: JsonObject,
  hungerDelta: number,
  hydrationDelta: number,
) {
  const before = survivalSnapshot(player);
  const after: SurvivalSnapshot = {
    hunger: clamp(before.hunger + hungerDelta, 0, 100),
    hydration: clamp(before.hydration + hydrationDelta, 0, 100),
    elapsedGameMinutes: before.elapsedGameMinutes,
  };
  return {
    before,
    after,
    appliedHungerDelta: round2(after.hunger - before.hunger),
    appliedHydrationDelta: round2(after.hydration - before.hydration),
    transitions: survivalTransitions(before, after),
  };
}

export function survivalTransitions(
  before: Pick<SurvivalSnapshot, "hunger" | "hydration">,
  after: Pick<SurvivalSnapshot, "hunger" | "hydration">,
): SurvivalTransition[] {
  const result: SurvivalTransition[] = [];
  for (const metric of ["hunger", "hydration"] as const) {
    const from = survivalStage(before[metric]);
    const to = survivalStage(after[metric]);
    if (from !== to) result.push({ metric, from, to, label: survivalLabel(metric, after[metric]) });
  }
  return result;
}

export function survivalStage(value: number): "good" | "mild" | "moderate" | "severe" | "critical" {
  if (value <= 0) return "critical";
  if (value <= 24) return "severe";
  if (value <= 49) return "moderate";
  if (value <= 74) return "mild";
  return "good";
}

export function survivalLabel(metric: "hunger" | "hydration", value: number): string {
  const stage = survivalStage(value);
  if (stage === "good") return "狀態良好";
  if (metric === "hunger") {
    return { mild: "稍有飢餓", moderate: "明顯飢餓", severe: "嚴重飢餓", critical: "極端飢餓" }[stage];
  }
  return { mild: "稍有口渴", moderate: "明顯口渴", severe: "嚴重脫水", critical: "極度缺水" }[stage];
}

function collectRateModifiers(player: JsonObject) {
  let hunger = 1;
  let hydration = 1;
  const reasons: string[] = [];
  const sources: JsonObject[] = [];
  const survival = isObject(player.survival) ? player.survival : {};
  if (Array.isArray(survival.modifiers)) {
    sources.push(...survival.modifiers.filter(isObject));
  }
  if (Array.isArray(player.skills)) sources.push(...player.skills.filter(isObject));
  if (Array.isArray(player.activeEquipmentModifiers)) {
    sources.push(...player.activeEquipmentModifiers.filter(isObject));
  } else if (isObject(player.equippedItems)) {
    sources.push(...Object.values(player.equippedItems).filter(isObject));
  }

  for (const source of sources) {
    const modifier = isObject(source.survivalModifier) ? source.survivalModifier : source;
    const hungerFactor = rateMultiplier(modifier.hungerRateMultiplier);
    const hydrationFactor = rateMultiplier(modifier.hydrationRateMultiplier);
    if (hungerFactor !== 1 || hydrationFactor !== 1) {
      hunger *= hungerFactor;
      hydration *= hydrationFactor;
      reasons.push(String(source.name ?? modifier.reason ?? source.id ?? "生存修正"));
    }
  }
  return { hunger: clamp(hunger, 0, 5), hydration: clamp(hydration, 0, 5), reasons };
}

function stageEffects(stage: ReturnType<typeof survivalStage>) {
  if (stage === "critical") return { recovery: 0.25, action: 0.65, focus: 0.5, risk: true };
  if (stage === "severe") return { recovery: 0.5, action: 0.8, focus: 0.75, risk: false };
  if (stage === "moderate") return { recovery: 0.75, action: 1, focus: 1, risk: false };
  return { recovery: 1, action: 1, focus: 1, risk: false };
}

function rateMultiplier(value: JsonValue | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? clamp(value, 0, 5) : 1;
}

function finiteNumber(value: JsonValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
