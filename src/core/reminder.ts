import { localDay } from './time';

export interface ReminderInput {
  now: number;
  /** Minutes after local midnight, or null when reminders are off. */
  reminderMinutes: number | null;
  /** Day (YYYY-MM-DD) the last reminder was shown, if any. */
  lastRemindedDay: string | undefined;
  /** Unlogged time for today. */
  unloggedTodayMs: number;
}

/** One gentle reminder per day, at or after the configured time, only if there is something to log. */
export function shouldRemind(input: ReminderInput): boolean {
  if (input.reminderMinutes === null || input.unloggedTodayMs <= 0) {
    return false;
  }
  const today = localDay(input.now);
  if (input.lastRemindedDay === today) {
    return false;
  }
  const d = new Date(input.now);
  return d.getHours() * 60 + d.getMinutes() >= input.reminderMinutes;
}
