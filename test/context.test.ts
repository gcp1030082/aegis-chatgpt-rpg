import { describe, expect, it } from "vitest";
import { defaultGameState } from "../src/domain/default-state.js";
import { classifyAction, detectRuntime, prepareTurn } from "../src/domain/context.js";

describe("runtime context", () => {
  it("detects initialization and combat", () => {
    expect(detectRuntime("創建隨機角色", "auto")).toBe("initialization");
    expect(classifyAction("我拔劍攻擊哥布林", "auto", "normal")).toContain("combat");
  });

  it("includes revision and commit contract", () => {
    const state = defaultGameState("main");
    state.revision = 7;
    const turnId = "11111111-1111-4111-8111-111111111111";
    const turn = prepareTurn(state, "我觀察酒館裡的人", turnId);
    expect(turn.turnId).toBe(turnId);
    expect(turn.revision).toBe(7);
    expect(turn.runtimeContext).toContain("expected_revision=7");
    expect(turn.runtimeContext).toContain(`turn_id=${turnId}`);
    expect(turn.runtimeContext).toContain("aegis_apply_state_diff");
    expect(turn.runtimeContext).toContain("世界本體固定為艾爾維亞");
    expect(turn.runtimeContext).toContain("不得在任何 State Diff 或 outcome_diff 傳入 world");
    expect(turn.actionTags).toContain("exploration");
  });
});
