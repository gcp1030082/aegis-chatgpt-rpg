import { describe, expect, it, vi } from "vitest";
import { defaultGameState, MIGRATION_KEY, migrateGameState } from "../src/domain/default-state.js";
import { applyStateDiff } from "../src/domain/diff.js";
import { formatHistoryEvent } from "../src/domain/history.js";
import type { JsonObject } from "../src/domain/types.js";

const options = (idempotencyKey: string) => ({
  maxDiffBytes: 512 * 1024,
  maxStateBytes: 2 * 1024 * 1024,
  idempotencyKey,
});

describe("structured history events", () => {
  it("formats supported events in Traditional Chinese without exposing raw JSON", () => {
    const cases: Array<[JsonObject, RegExp]> = [
      [{ type: "travel", toName: "淺谷入口", actualTravelMinutes: 95 }, /抵達淺谷入口.*1 小時 35 分鐘/],
      [{ type: "time_elapsed", elapsedMinutes: 30 }, /經過了30 分鐘/],
      [{ type: "item_used", itemName: "清水" }, /使用了清水/],
      [{ type: "quest_changed", questName: "銀脈草採集" }, /任務「銀脈草採集」已更新/],
      [{ type: "npc_information_learned", npcName: "布蘭" }, /從布蘭得知/],
      [{ type: "compendium_updated", entryName: "銀脈草" }, /圖鑑「銀脈草」已更新/],
    ];
    for (const [event, expected] of cases) {
      const display = formatHistoryEvent(event);
      expect(display).toMatch(expected);
      expect(display).not.toContain("{\"");
      expect(display).not.toContain("eventId");
    }
  });

  it("uses a safe fallback for unknown legacy event types", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(formatHistoryEvent({ type: "legacy_unknown", internal: "DO_NOT_RENDER" }))
      .toBe("發生了一項尚未分類的事件。");
    expect(warning).toHaveBeenCalled();
    warning.mockRestore();
  });

  it("assigns deterministic event IDs and final revision/game-time metadata", () => {
    const state = defaultGameState("history");
    const diff = {
      history: { append: [
        { type: "general", summary: "發現一枚舊徽章" },
        { type: "quest_changed", questName: "失落徽章", summary: "任務線索已更新" },
      ] },
    };
    const left = applyStateDiff(state, diff, options("history-seed")).game;
    const right = applyStateDiff(state, diff, options("history-seed")).game;
    expect(left.history.recent).toEqual(right.history.recent);
    expect(left.history.recent).toEqual([
      expect.objectContaining({ eventId: expect.stringMatching(/^event-/), revision: 1, gameTime: state.player.clock }),
      expect.objectContaining({ eventId: expect.stringMatching(/^event-/), revision: 1, gameTime: state.player.clock }),
    ]);
    expect(new Set(left.history.recent.map((raw) => (raw as JsonObject).eventId)).size).toBe(2);
  });

  it("rejects duplicate event IDs and unknown new event types", () => {
    const state = defaultGameState("history-errors");
    const first = applyStateDiff(state, {
      history: { append: [{ eventId: "event-fixed", type: "general", summary: "第一件事" }] },
    }, options("history-first")).game;
    expect(() => applyStateDiff(first, {
      history: { append: [{ eventId: "event-fixed", type: "general", summary: "重複事件" }] },
    }, options("history-duplicate"))).toThrow(/重複 eventId/);
    expect(() => applyStateDiff(first, {
      history: { append: [{ type: "unregistered_type", summary: "未註冊" }] },
    }, options("history-unknown"))).toThrow(/不是允許/);
  });

  it("migrates legacy strings and preserves unknown records for safe fallback rendering", () => {
    const legacy = defaultGameState("legacy-history");
    markLegacy(legacy);
    legacy.history.recent = ["抵達舊橋", { type: "legacy_unknown", rawPayload: { private: false } }];
    const migrated = migrateGameState(legacy);
    expect(migrated.history.recent[0]).toMatchObject({
      type: "general", summary: "抵達舊橋", eventId: expect.stringMatching(/^event-/), revision: 0,
    });
    expect(formatHistoryEvent(migrated.history.recent[1]!)).toBe("發生了一項尚未分類的事件。");
  });
});

function markLegacy(state: ReturnType<typeof defaultGameState>): void {
  state.schemaVersion = "6.7.7-mcp.5.2";
  state.version = "6.7.7-mcp.5.2";
  delete (state.engine.migrations as JsonObject)[MIGRATION_KEY];
}
