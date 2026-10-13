import { localDay } from './time';
import type { Heartbeat, Session } from './types';

/** Signal written when the editor window loses focus. */
export const BLUR_SIGNAL = 'blur';

/**
 * Joins heartbeats into sessions of continuous activity.
 *
 * Time between two heartbeats counts as active when the gap is at most
 * `idleMs`; a longer gap ends the session. After a `blur` heartbeat (the
 * window lost focus) only `blurGraceMs` of the following gap counts, so a
 * quick look at docs in the browser still counts but a long break does not.
 * When the issue, repo or branch changes (or the day rolls over), the gap up
 * to the switch goes to the previous session and a new one starts.
 */
export function buildSessions(heartbeats: Heartbeat[], idleMs: number, blurGraceMs = 2 * 60000): Session[] {
  const sorted = [...heartbeats].sort((a, b) => a.t - b.t);
  const sessions: Session[] = [];
  let current: Session | null = null;

  const open = (hb: Heartbeat): Session => ({
    key: hb.key,
    repo: hb.repo,
    branch: hb.branch,
    start: hb.t,
    end: hb.t,
    activeMs: 0,
  });

  let blurred = false;

  for (const hb of sorted) {
    const wasBlurred = blurred;
    blurred = hb.signal === BLUR_SIGNAL;
    if (!current) {
      // A blur on its own does not start a session.
      current = blurred ? null : open(hb);
      continue;
    }
    const gap = hb.t - current.end;
    if (wasBlurred && gap > blurGraceMs) {
      current.activeMs += Math.min(blurGraceMs, idleMs);
      sessions.push(current);
      current = blurred ? null : open(hb);
      continue;
    }
    if (gap > idleMs) {
      sessions.push(current);
      current = blurred ? null : open(hb);
      continue;
    }
    current.activeMs += gap;
    current.end = hb.t;
    if (blurred) {
      // Attribution stays with the session that lost focus.
      continue;
    }
    const switched =
      hb.key !== current.key ||
      hb.repo !== current.repo ||
      hb.branch !== current.branch ||
      localDay(hb.t) !== localDay(current.start);
    if (switched) {
      sessions.push(current);
      current = open(hb);
    }
  }
  if (current) {
    sessions.push(current);
  }
  return sessions.filter((s) => s.activeMs > 0);
}
