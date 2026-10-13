import { describe, expect, it } from 'vitest';
import { formatDuration, jiraStarted, localDay, parseClock, parseDuration } from '../src/core/time';
import { shouldRemind } from '../src/core/reminder';

describe('time helpers', () => {
  it('formats Jira started timestamps with a numeric offset', () => {
    const t = new Date(2026, 9, 13, 9, 5, 7, 12).getTime();
    expect(jiraStarted(t)).toMatch(/^2026-10-13T09:05:07\.012[+-]\d{4}$/);
  });

  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0m');
    expect(formatDuration(45 * 60000)).toBe('45m');
    expect(formatDuration(120 * 60000)).toBe('2h');
    expect(formatDuration(370 * 60000)).toBe('6h 10m');
  });

  it('parses typed durations', () => {
    expect(parseDuration('1h 30m')).toBe(5400);
    expect(parseDuration('1.5h')).toBe(5400);
    expect(parseDuration('90m')).toBe(5400);
    expect(parseDuration('90')).toBe(5400);
    expect(parseDuration('1:30')).toBe(5400);
    expect(parseDuration('2H')).toBe(7200);
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('soon')).toBeNull();
  });

  it('parses reminder clock times', () => {
    expect(parseClock('17:30')).toBe(1050);
    expect(parseClock('')).toBeNull();
    expect(parseClock('25:00')).toBeNull();
  });
});

describe('shouldRemind', () => {
  const at = (h: number, m: number) => new Date(2026, 9, 13, h, m).getTime();
  const base = { reminderMinutes: 17 * 60 + 30, lastRemindedDay: undefined, unloggedTodayMs: 3600_000 };

  it('reminds once, at or after the set time, when something is unlogged', () => {
    expect(shouldRemind({ ...base, now: at(17, 29) })).toBe(false);
    expect(shouldRemind({ ...base, now: at(17, 30) })).toBe(true);
    expect(shouldRemind({ ...base, now: at(19, 0) })).toBe(true);
    expect(shouldRemind({ ...base, now: at(19, 0), lastRemindedDay: localDay(at(9, 0)) })).toBe(false);
    expect(shouldRemind({ ...base, now: at(19, 0), unloggedTodayMs: 0 })).toBe(false);
    expect(shouldRemind({ ...base, now: at(19, 0), reminderMinutes: null })).toBe(false);
  });
});
