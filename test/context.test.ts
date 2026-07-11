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
    const turn = prepareTurn(state, "我觀察酒館裡的人");
    expect(turn.revision).toBe(7);
    expect(turn.runtimeContext).toContain("expected_revision=7");
    expect(turn.runtimeContext).toContain("aegis_apply_state_diff");
    expect(turn.actionTags).toContain("exploration");
  });
});
