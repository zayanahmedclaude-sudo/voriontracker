import type { ShiftType } from './roles';

export type TimeWindow = { startIso: string; endIso: string };
export type ShiftWindow = { start: Date; end: Date };

export const BUSINESS_TIME_ZONE = 'Asia/Karachi';

function addDays(date: string, days: number) {
  const [year, month, day] = date.split('-').map(Number);
  const base = new Date(Date.UTC(year, month - 1, day + days));
  return base.toISOString().slice(0, 10);
}

function formatPartsInTimeZone(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const values: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }

  return values;
}

function getTimeZoneOffsetMs(date: Date, timeZone: string) {
  const parts = formatPartsInTimeZone(date, timeZone);
  const utcEquivalent = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );

  return utcEquivalent - date.getTime();
}

export function zonedDateTimeToUtc(date: string, time: string, timeZone: string) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute, second] = time.split(':').map(Number);
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const firstOffset = getTimeZoneOffsetMs(guess, timeZone);
  const firstPass = new Date(guess.getTime() - firstOffset);
  const secondOffset = getTimeZoneOffsetMs(firstPass, timeZone);

  if (secondOffset === firstOffset) return firstPass;
  return new Date(guess.getTime() - secondOffset);
}

export function getLocalDateInTimeZone(date: Date, timeZone: string) {
  const parts = formatPartsInTimeZone(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function getShiftDateInTimeZone(date: Date, timeZone: string = BUSINESS_TIME_ZONE) {
  const parts = formatPartsInTimeZone(date, timeZone);
  const localDate = `${parts.year}-${parts.month}-${parts.day}`;
  const hour = Number(parts.hour);

  if (hour < 19) return addDays(localDate, -1);
  return localDate;
}

export function getBusinessDayRange(date: string, timeZone: string = BUSINESS_TIME_ZONE) {
  const start = zonedDateTimeToUtc(date, '19:00:00', timeZone);
  const end = zonedDateTimeToUtc(addDays(date, 1), '19:00:00', timeZone);

  return {
    start,
    end,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

export function getWindowDateInTimeZone(date: Date, startHour: number, timeZone: string = BUSINESS_TIME_ZONE) {
  const parts = formatPartsInTimeZone(date, timeZone);
  const localDate = `${parts.year}-${parts.month}-${parts.day}`;
  const hour = Number(parts.hour);

  if (hour < startHour) return addDays(localDate, -1);
  return localDate;
}

export function getTimelineWindowForDate(date: string, timeZone: string = BUSINESS_TIME_ZONE) {
  const start = zonedDateTimeToUtc(date, '16:00:00', timeZone);
  const end = zonedDateTimeToUtc(addDays(date, 1), '07:00:00', timeZone);

  return {
    start,
    end,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

export function getClientShiftWindows(date: string, shiftType: ShiftType): TimeWindow[] {
  const firstHalf = {
    startIso: `${date}T20:00:00+05:00`,
    endIso: `${addDays(date, 1)}T00:00:00+05:00`,
  };
  const secondHalf = {
    startIso: `${addDays(date, 1)}T01:00:00+05:00`,
    endIso: `${addDays(date, 1)}T05:00:00+05:00`,
  };

  if (shiftType === 'first_half') return [firstHalf];
  if (shiftType === 'second_half') return [secondHalf];
  return [firstHalf, secondHalf];
}

export function getUtcRangeForLocalDate(date: string, timeZone: string) {
  const start = zonedDateTimeToUtc(date, '00:00:00', timeZone);
  const end = zonedDateTimeToUtc(addDays(date, 1), '00:00:00', timeZone);

  return {
    start,
    end,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

export function getShiftWindowsForDate(date: string, shiftType: ShiftType): ShiftWindow[] {
  return getClientShiftWindows(date, shiftType).map((window) => ({
    start: new Date(window.startIso),
    end: new Date(window.endIso),
  }));
}

export function getShiftRangeForDate(date: string, shiftType: ShiftType) {
  const windows = getShiftWindowsForDate(date, shiftType);
  const start = new Date(Math.min(...windows.map((window) => window.start.getTime())));
  const end = new Date(Math.max(...windows.map((window) => window.end.getTime())));

  return {
    start,
    end,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

export function isTimestampWithinShiftWindows(timestamp: string | Date, windows: ShiftWindow[]) {
  const value = new Date(timestamp).getTime();
  return windows.some((window) => value >= window.start.getTime() && value < window.end.getTime());
}
