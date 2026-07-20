import { AegisError } from "./errors.js";
import type {
  CalendarMonthDefinition,
  GameState,
  GameTimeSnapshot,
  JsonObject,
  WorldCalendar,
} from "./types.js";

export const DEFAULT_CALENDAR: WorldCalendar = {
  calendarId: "aelvia-stars-calendar",
  eraName: "群星曆",
  hoursPerDay: 24,
  minutesPerHour: 60,
  months: [
    { monthId: "sprout", name: "芽月", days: 30, seasonId: "spring" },
    { monthId: "bloom", name: "花月", days: 31, seasonId: "spring" },
    { monthId: "rain", name: "雨月", days: 30, seasonId: "spring" },
    { monthId: "ember", name: "炎月", days: 31, seasonId: "summer" },
    { monthId: "sun", name: "日月", days: 30, seasonId: "summer" },
    { monthId: "thunder", name: "雷月", days: 31, seasonId: "summer" },
    { monthId: "harvest", name: "穗月", days: 30, seasonId: "autumn" },
    { monthId: "frost", name: "霜月", days: 31, seasonId: "autumn" },
    { monthId: "leaf", name: "葉月", days: 30, seasonId: "autumn" },
    { monthId: "cold", name: "寒月", days: 31, seasonId: "winter" },
    { monthId: "snow", name: "雪月", days: 30, seasonId: "winter" },
    { monthId: "star", name: "星月", days: 31, seasonId: "winter" },
  ],
  seasons: [
    { seasonId: "spring", name: "春季" },
    { seasonId: "summer", name: "夏季" },
    { seasonId: "autumn", name: "秋季" },
    { seasonId: "winter", name: "冬季" },
  ],
};

export const DEFAULT_CLOCK: GameTimeSnapshot = {
  year: 742,
  monthId: "sprout",
  day: 1,
  minuteOfDay: 8 * 60,
};

export function normalizeClockState(state: GameState, allowLegacy = false): void {
  const calendar = normalizeCalendar(state.world.calendar, allowLegacy);
  state.world.calendar = calendar as unknown as JsonObject;
  const existing = asObject(state.player.clock);
  const fallback = defaultClockFor(calendar);
  const migrated = allowLegacy && Object.keys(existing).length === 0
    ? parseLegacyClock(state.player.date, state.player.time, calendar)
    : undefined;
  const clock = normalizeClock(existing, calendar, migrated ?? fallback, allowLegacy);
  state.player.clock = snapshotObject(clock);
  synchronizeLegacyClockCaches(state, calendar, clock);
}

export function resetGameClock(state: GameState): GameTimeSnapshot {
  const calendar = normalizeCalendar(state.world.calendar, false, "INVALID_STATE");
  const clock = defaultClockFor(calendar);
  state.player.clock = snapshotObject(clock);
  synchronizeLegacyClockCaches(state, calendar, clock);
  return clock;
}

export function validateClockState(state: GameState): void {
  const calendar = normalizeCalendar(state.world.calendar, false, "INVALID_STATE");
  normalizeClock(asObject(state.player.clock), calendar, DEFAULT_CLOCK, false, "INVALID_STATE");
  const expected = structuredClone(state);
  synchronizeLegacyClockCaches(expected, calendar, clockSnapshot(state));
  for (const key of ["date", "time", "season"] as const) {
    if (state.player[key] !== expected.player[key]) {
      throw new AegisError("INVALID_STATE", `player.${key} 必須由權威 GameClock 衍生。`);
    }
  }
}

export function advanceGameClock(
  state: GameState,
  elapsedMinutes: number,
): GameTimeSnapshot {
  if (!Number.isInteger(elapsedMinutes) || elapsedMinutes <= 0) {
    throw new AegisError("INVALID_DIFF", "經過時間必須是正整數分鐘。");
  }
  const calendar = calendarOf(state);
  const clock = clockSnapshot(state);
  let year = clock.year;
  let monthIndex = calendar.months.findIndex((month) => month.monthId === clock.monthId);
  let day = clock.day;
  let minuteOfDay = clock.minuteOfDay + elapsedMinutes;
  const minutesPerDay = calendar.hoursPerDay * calendar.minutesPerHour;

  while (minuteOfDay >= minutesPerDay) {
    minuteOfDay -= minutesPerDay;
    day += 1;
    const month = calendar.months[monthIndex];
    if (!month) throw new AegisError("INVALID_STATE", "GameClock 指向不存在的月份。");
    if (day > month.days) {
      day = 1;
      monthIndex += 1;
      if (monthIndex >= calendar.months.length) {
        monthIndex = 0;
        year += 1;
      }
    }
  }

  const month = calendar.months[monthIndex];
  if (!month) throw new AegisError("INVALID_STATE", "世界曆法沒有可用月份。");
  const next = { year, monthId: month.monthId, day, minuteOfDay };
  state.player.clock = snapshotObject(next);
  synchronizeLegacyClockCaches(state, calendar, next);
  return next;
}

export function clockSnapshot(state: GameState): GameTimeSnapshot {
  const value = asObject(state.player.clock);
  return {
    year: number(value.year),
    monthId: typeof value.monthId === "string" ? value.monthId : "",
    day: number(value.day),
    minuteOfDay: number(value.minuteOfDay),
  };
}

export function snapshotObject(value: GameTimeSnapshot): JsonObject {
  return {
    year: value.year,
    monthId: value.monthId,
    day: value.day,
    minuteOfDay: value.minuteOfDay,
  };
}

export function calendarOf(state: GameState): WorldCalendar {
  return normalizeCalendar(state.world.calendar, false, "INVALID_STATE");
}

export function formatGameDate(calendar: WorldCalendar, clock: GameTimeSnapshot): string {
  const month = calendar.months.find((candidate) => candidate.monthId === clock.monthId);
  return `${calendar.eraName}${clock.year}年・${month?.name ?? "未知月份"}${clock.day}日`;
}

export function formatGameTime(calendar: WorldCalendar, clock: GameTimeSnapshot): string {
  const hour = Math.floor(clock.minuteOfDay / calendar.minutesPerHour);
  const minute = clock.minuteOfDay % calendar.minutesPerHour;
  if (calendar.hoursPerDay === 24 && calendar.minutesPerHour === 60) {
    const period = hour < 12 ? "上午" : "下午";
    const displayHour = hour % 12 || 12;
    return `${period} ${String(displayHour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }
  return `第 ${hour} 時 ${String(minute).padStart(2, "0")} 分`;
}

export function seasonName(calendar: WorldCalendar, clock: GameTimeSnapshot): string {
  const seasonId = calendar.months.find((month) => month.monthId === clock.monthId)?.seasonId;
  if (!seasonId) return "";
  return calendar.seasons?.find((season) => season.seasonId === seasonId)?.name ?? "";
}

function synchronizeLegacyClockCaches(
  state: GameState,
  calendar: WorldCalendar,
  clock: GameTimeSnapshot,
): void {
  state.player.date = formatGameDate(calendar, clock);
  state.player.time = formatGameTime(calendar, clock);
  state.player.season = seasonName(calendar, clock);
}

function normalizeCalendar(
  raw: unknown,
  allowLegacy: boolean,
  code: "INVALID_DIFF" | "INVALID_STATE" = "INVALID_DIFF",
): WorldCalendar {
  if ((!raw || typeof raw !== "object" || Array.isArray(raw)) && allowLegacy) {
    return structuredClone(DEFAULT_CALENDAR);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AegisError(code, "world.calendar 必須是完整曆法物件。");
  }
  const value = raw as Record<string, unknown>;
  if (allowLegacy && (
    typeof value.calendarId !== "string" || !value.calendarId.trim() ||
    typeof value.eraName !== "string" || !value.eraName.trim() ||
    !Array.isArray(value.months) || value.months.length < 2
  )) {
    const fallback = structuredClone(DEFAULT_CALENDAR);
    if (typeof value.calendarId === "string" && value.calendarId.trim()) fallback.calendarId = value.calendarId.trim();
    if (typeof value.eraName === "string" && value.eraName.trim()) fallback.eraName = value.eraName.trim();
    return fallback;
  }
  const calendarId = requiredText(value.calendarId, "world.calendar.calendarId", code);
  const eraName = requiredText(value.eraName, "world.calendar.eraName", code);
  const hoursPerDay = positiveInteger(value.hoursPerDay, "world.calendar.hoursPerDay", code, 48);
  const minutesPerHour = positiveInteger(value.minutesPerHour, "world.calendar.minutesPerHour", code, 120);
  if (!Array.isArray(value.months) || value.months.length < 2 || value.months.length > 24) {
    throw new AegisError(code, "world.calendar.months 必須包含 2～24 個完整月份。");
  }
  const monthIds = new Set<string>();
  const months: CalendarMonthDefinition[] = value.months.map((rawMonth, index) => {
    if (!rawMonth || typeof rawMonth !== "object" || Array.isArray(rawMonth)) {
      throw new AegisError(code, `world.calendar.months[${index}] 必須是物件。`);
    }
    const month = rawMonth as Record<string, unknown>;
    const monthId = requiredText(month.monthId, `world.calendar.months[${index}].monthId`, code);
    if (monthIds.has(monthId)) throw new AegisError(code, `世界曆法存在重複 monthId：${monthId}。`);
    monthIds.add(monthId);
    const normalized: CalendarMonthDefinition = {
      monthId,
      name: requiredText(month.name, `world.calendar.months[${index}].name`, code),
      days: positiveInteger(month.days, `world.calendar.months[${index}].days`, code, 400),
    };
    if (typeof month.seasonId === "string" && month.seasonId.trim()) normalized.seasonId = month.seasonId.trim();
    return normalized;
  });
  const seasons = value.seasons === undefined ? undefined : normalizeSeasons(value.seasons, code);
  if (seasons) {
    const seasonIds = new Set(seasons.map((season) => season.seasonId));
    for (const month of months) {
      if (month.seasonId && !seasonIds.has(month.seasonId)) {
        throw new AegisError(code, `月份 ${month.monthId} 引用了未知 seasonId：${month.seasonId}。`);
      }
    }
  }
  return { calendarId, eraName, hoursPerDay, minutesPerHour, months, ...(seasons ? { seasons } : {}) };
}

function normalizeSeasons(raw: unknown, code: "INVALID_DIFF" | "INVALID_STATE") {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 12) {
    throw new AegisError(code, "world.calendar.seasons 必須是非空陣列。");
  }
  const seen = new Set<string>();
  return raw.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new AegisError(code, `world.calendar.seasons[${index}] 必須是物件。`);
    }
    const value = item as Record<string, unknown>;
    const seasonId = requiredText(value.seasonId, `world.calendar.seasons[${index}].seasonId`, code);
    if (seen.has(seasonId)) throw new AegisError(code, `世界曆法存在重複 seasonId：${seasonId}。`);
    seen.add(seasonId);
    return { seasonId, name: requiredText(value.name, `world.calendar.seasons[${index}].name`, code) };
  });
}

function normalizeClock(
  raw: Record<string, unknown>,
  calendar: WorldCalendar,
  fallback: GameTimeSnapshot,
  allowLegacy: boolean,
  code: "INVALID_DIFF" | "INVALID_STATE" = "INVALID_DIFF",
): GameTimeSnapshot {
  if (allowLegacy && Object.keys(raw).length === 0) return structuredClone(fallback);
  const year = nonnegativeInteger(raw.year, "player.clock.year", code);
  const monthId = requiredText(raw.monthId, "player.clock.monthId", code);
  const month = calendar.months.find((candidate) => candidate.monthId === monthId);
  if (!month) throw new AegisError(code, `player.clock.monthId 引用了未知月份 ${monthId}。`);
  const day = positiveInteger(raw.day, "player.clock.day", code, month.days);
  const minuteOfDay = nonnegativeInteger(raw.minuteOfDay, "player.clock.minuteOfDay", code);
  if (minuteOfDay >= calendar.hoursPerDay * calendar.minutesPerHour) {
    throw new AegisError(code, "player.clock.minuteOfDay 超出單日範圍。");
  }
  return { year, monthId, day, minuteOfDay };
}

function parseLegacyClock(
  rawDate: unknown,
  rawTime: unknown,
  calendar: WorldCalendar,
): GameTimeSnapshot | undefined {
  const date = typeof rawDate === "string" ? rawDate.trim() : "";
  const time = typeof rawTime === "string" ? rawTime.trim() : "";
  if (!date && !time) return undefined;
  const fallback = defaultClockFor(calendar);
  const year = Number(date.match(/(\d+)\s*年/u)?.[1] ?? DEFAULT_CLOCK.year);
  const namedMonth = calendar.months.find((month) => date.includes(month.name));
  const numericMonth = Number(date.match(/(?:年|^)[^\d]{0,8}(\d+)\s*月/u)?.[1] ?? 0);
  const month = namedMonth ?? calendar.months[numericMonth - 1] ?? calendar.months[0];
  if (!month) return undefined;
  const dayMatch = date.match(/(\d+)\s*日/u);
  const day = Math.max(1, Math.min(month.days, Number(dayMatch?.[1] ?? fallback.day)));
  const timeMatch = time.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/u);
  let hour = Number(timeMatch?.[1] ?? Math.floor(fallback.minuteOfDay / calendar.minutesPerHour));
  const minute = Number(timeMatch?.[2] ?? fallback.minuteOfDay % calendar.minutesPerHour);
  if (/下午|晚上/u.test(time) && hour < 12) hour += 12;
  if (/上午/u.test(time) && hour === 12) hour = 0;
  const minuteOfDay = Math.max(0, Math.min(
    calendar.hoursPerDay * calendar.minutesPerHour - 1,
    hour * calendar.minutesPerHour + minute,
  ));
  return { year: Number.isInteger(year) && year >= 0 ? year : DEFAULT_CLOCK.year, monthId: month.monthId, day, minuteOfDay };
}

function defaultClockFor(calendar: WorldCalendar): GameTimeSnapshot {
  const firstMonth = calendar.months[0];
  if (!firstMonth) throw new AegisError("INVALID_STATE", "世界曆法沒有可用月份。");
  const minutesPerDay = calendar.hoursPerDay * calendar.minutesPerHour;
  return {
    year: DEFAULT_CLOCK.year,
    monthId: calendar.months.some((month) => month.monthId === DEFAULT_CLOCK.monthId)
      ? DEFAULT_CLOCK.monthId
      : firstMonth.monthId,
    day: Math.min(DEFAULT_CLOCK.day, firstMonth.days),
    minuteOfDay: Math.min(8 * calendar.minutesPerHour, minutesPerDay - 1),
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requiredText(value: unknown, path: string, code: "INVALID_DIFF" | "INVALID_STATE"): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new AegisError(code, `${path} 必須是非空字串。`);
  return text;
}

function positiveInteger(
  value: unknown,
  path: string,
  code: "INVALID_DIFF" | "INVALID_STATE",
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new AegisError(code, `${path} 必須是 1～${maximum} 的整數。`);
  }
  return value;
}

function nonnegativeInteger(value: unknown, path: string, code: "INVALID_DIFF" | "INVALID_STATE"): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new AegisError(code, `${path} 必須是非負整數。`);
  }
  return value;
}

function number(value: unknown): number {
  return typeof value === "number" ? value : Number.NaN;
}
