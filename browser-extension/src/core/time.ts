const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** Local calendar day as YYYY-MM-DD. */
export function localDay(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Epoch ms of local midnight at the start of `day` (YYYY-MM-DD). */
export function dayStart(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

/** Epoch ms of local midnight at the end of `day`. */
export function dayEnd(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d + 1).getTime();
}

/**
 * Jira's worklog `started` format: `2026-10-13T09:05:00.000+0800`
 * (local time with a numeric offset and no colon in it).
 */
export function jiraStarted(t: number): string {
  const d = new Date(t);
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
  );
}

/** `6h 10m`, `45m`, `0m`. */
export function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) {
    return `${m}m`;
  }
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Parses `HH:MM` into minutes after midnight, or null if empty/invalid. */
export function parseClock(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/**
 * Parses what a developer types for a duration: `1h 30m`, `1.5h`, `90m`, `90`
 * (minutes) or `1:30`. Returns seconds, or null if it can't be read.
 */
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (!s) {
    return null;
  }
  const clock = /^(\d+):([0-5]\d)$/.exec(s);
  if (clock) {
    return (Number(clock[1]) * 60 + Number(clock[2])) * 60;
  }
  if (/^\d+(\.\d+)?$/.test(s)) {
    return Math.round(Number(s) * 60);
  }
  const unit = /^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m)?$/.exec(s);
  if (unit && (unit[1] || unit[2])) {
    return Math.round((Number(unit[1] ?? 0) * 60 + Number(unit[2] ?? 0)) * 60);
  }
  return null;
}
