import { describe, expect, it } from "vitest";
import { advanceGameClock, calendarOf, clockSnapshot, normalizeClockState } from "../src/domain/clock.js";
import { applyStateDiff } from "../src/domain/diff.js";
import { defaultGameState, MIGRATION_KEY, migrateGameState } from "../src/domain/default-state.js";
import type { JsonObject } from "../src/domain/types.js";

const options = {
  maxDiffBytes: 512 * 1024,
  maxStateBytes: 2 * 1024 * 1024,
  idempotencyKey: "clock-test",
};

describe("authoritative world calendar and GameClock", () => {
  it("ships a complete calendar and formats authoritative legacy caches", () => {
    const state = defaultGameState("main");
    const calendar = calendarOf(state);
    expect(calendar.months).toHaveLength(12);
    expect(new Set(calendar.months.map((month) => month.monthId)).size).toBe(12);
    expect(state.player).toMatchObject({
      clock: { year: 742, monthId: "sprout", day: 1, minuteOfDay: 480 },
      date: "群星曆742年・芽月1日",
      time: "上午 08:00",
      season: "春季",
    });
  });

  it("advances within a day and across day, month, season, and year boundaries", () => {
    const state = defaultGameState("main");
    state.player.clock = { year: 9, monthId: "sprout", day: 30, minuteOfDay: 23 * 60 + 50 };
    normalizeClockState(state);
    expect(advanceGameClock(state, 20)).toEqual({ year: 9, monthId: "bloom", day: 1, minuteOfDay: 10 });
    expect(state.player).toMatchObject({ date: "群星曆9年・花月1日", time: "上午 12:10", season: "春季" });

    state.player.clock = { year: 9, monthId: "rain", day: 30, minuteOfDay: 23 * 60 + 50 };
    normalizeClockState(state);
    expect(advanceGameClock(state, 20).monthId).toBe("ember");
    expect(state.player.season).toBe("夏季");

    state.player.clock = { year: 9, monthId: "star", day: 31, minuteOfDay: 23 * 60 + 59 };
    normalizeClockState(state);
    expect(advanceGameClock(state, 1)).toEqual({ year: 10, monthId: "sprout", day: 1, minuteOfDay: 0 });
  });

  it("honors different month lengths", () => {
    const state = defaultGameState("main");
    state.world.calendar = {
      calendarId: "test-calendar", eraName: "測試曆", hoursPerDay: 10, minutesPerHour: 100,
      months: [
        { monthId: "short", name: "短月", days: 2, seasonId: "a" },
        { monthId: "long", name: "長月", days: 4, seasonId: "b" },
      ],
      seasons: [{ seasonId: "a", name: "前季" }, { seasonId: "b", name: "後季" }],
    };
    state.player.clock = { year: 1, monthId: "short", day: 2, minuteOfDay: 999 };
    normalizeClockState(state);
    expect(advanceGameClock(state, 1)).toEqual({ year: 1, monthId: "long", day: 1, minuteOfDay: 0 });
    expect(state.player.season).toBe("後季");
  });

  it("migrates legacy date and time text once into a structured clock", () => {
    const legacy = defaultGameState("legacy-clock");
    markLegacy(legacy);
    delete legacy.player.clock;
    delete legacy.world.calendar;
    legacy.player.date = "群星曆745年・霜月17日";
    legacy.player.time = "下午 03:25";
    const migrated = migrateGameState(legacy);
    expect(clockSnapshot(migrated)).toEqual({ year: 745, monthId: "frost", day: 17, minuteOfDay: 15 * 60 + 25 });
    expect(migrated.player).toMatchObject({ date: "群星曆745年・霜月17日", time: "下午 03:25", season: "秋季" });
  });

  it("replaces a legacy custom calendar with Aelvia and resets to a valid Aelvia clock", () => {
    const legacy = defaultGameState("custom-legacy-clock");
    markLegacy(legacy);
    legacy.world.calendar = {
      calendarId: "ten-hour-calendar", eraName: "十時曆", hoursPerDay: 10, minutesPerHour: 100,
      months: [
        { monthId: "first", name: "首月", days: 2 },
        { monthId: "second", name: "次月", days: 3 },
      ],
    };
    delete legacy.player.clock;
    legacy.player.date = "";
    legacy.player.time = "";
    const migrated = migrateGameState(legacy);
    expect(clockSnapshot(migrated)).toEqual({ year: 742, monthId: "sprout", day: 1, minuteOfDay: 480 });
    expect(migrated.world).toMatchObject({ worldId: "aelvia", name: "艾爾維亞" });
    expect(migrated.player).toMatchObject({ date: "群星曆742年・芽月1日", time: "上午 08:00" });
  });

  it("rejects direct writes to clock and derived date caches", () => {
    const state = defaultGameState("main");
    expect(() => applyStateDiff(state, { player: { clock: { year: 1 } } }, options)).toThrow(/權威世界時鐘/);
    expect(() => applyStateDiff(state, { player: { date: "任意日期" } }, options)).toThrow(/權威世界時鐘/);
    expect(() => applyStateDiff(state, {
      map: [{
        mapId: "m", name: "地點", kind: "place", discovery: "known",
        firstLearnedAtRevision: 999,
      }],
    }, options)).toThrow(/伺服器管理/);
  });
});

function markLegacy(state: ReturnType<typeof defaultGameState>): void {
  state.schemaVersion = "6.7.7-mcp.5.2";
  state.version = "6.7.7-mcp.5.2";
  delete (state.engine.migrations as JsonObject)[MIGRATION_KEY];
}
