import { localDay } from './time';
import type { CommitRecord, Draft, Session, SettledEntry } from './types';

export interface DraftOptions {
  roundMinutes: number;
  minSessionMinutes: number;
}

/** Rounds to the nearest step, never below one step for non-zero time. */
export function roundToStep(ms: number, stepMinutes: number): number {
  const stepSec = Math.max(1, stepMinutes) * 60;
  const sec = ms / 1000;
  if (sec <= 0) {
    return 0;
  }
  return Math.max(stepSec, Math.round(sec / stepSec) * stepSec);
}

const MAX_COMMENT_SUBJECTS = 8;

/**
 * Turns sessions into one draft worklog per day and issue, minus anything
 * already posted or discarded. Unassigned time uses sourceKey "".
 */
export function buildDrafts(
  sessions: Session[],
  commits: CommitRecord[],
  settled: SettledEntry[],
  options: DraftOptions,
): Draft[] {
  const minSessionMs = options.minSessionMinutes * 60000;
  const groups = new Map<string, { day: string; sourceKey: string; sessions: Session[] }>();

  for (const s of sessions) {
    if (s.activeMs < minSessionMs) {
      continue;
    }
    const day = localDay(s.start);
    const sourceKey = s.key ?? '';
    const id = `${day}|${sourceKey}`;
    let group = groups.get(id);
    if (!group) {
      group = { day, sourceKey, sessions: [] };
      groups.set(id, group);
    }
    group.sessions.push(s);
  }

  const drafts: Draft[] = [];
  for (const { day, sourceKey, sessions: groupSessions } of groups.values()) {
    const totalMs = groupSessions.reduce((sum, s) => sum + s.activeMs, 0);
    const settledMs = settled
      .filter((e) => e.day === day && e.sourceKey === sourceKey)
      .reduce((sum, e) => sum + e.rawMs, 0);
    const rawMs = totalMs - settledMs;
    // Leftovers smaller than a minimum session (or a minute) are noise.
    if (rawMs < Math.max(minSessionMs, 60000)) {
      continue;
    }
    const where = new Set(groupSessions.map((s) => `${s.repo}\u0000${s.branch ?? ''}`));
    const branches = [...new Set(groupSessions.map((s) => s.branch).filter((b): b is string => !!b))];
    const subjects = [
      ...new Set(
        commits
          .filter((c) => localDay(c.t) === day && where.has(`${c.repo}\u0000${c.branch ?? ''}`))
          .sort((a, b) => a.t - b.t)
          .map((c) => c.subject.trim())
          .filter(Boolean),
      ),
    ].slice(0, MAX_COMMENT_SUBJECTS);

    drafts.push({
      day,
      sourceKey,
      rawMs,
      seconds: roundToStep(rawMs, options.roundMinutes),
      started: Math.min(...groupSessions.map((s) => s.start)),
      comment: subjects.length > 0 ? subjects.join('\n') : defaultComment(branches),
      branches,
    });
  }

  return drafts.sort((a, b) => (a.day === b.day ? a.sourceKey.localeCompare(b.sourceKey) : b.day.localeCompare(a.day)));
}

function defaultComment(branches: string[]): string {
  return branches.length > 0 ? `Worked on ${branches.join(', ')}` : 'Development work';
}

/** Total unsettled time across drafts, using the rounded durations. */
export function totalUnloggedMs(drafts: Draft[], day?: string): number {
  return drafts.filter((d) => !day || d.day === day).reduce((sum, d) => sum + d.seconds * 1000, 0);
}
