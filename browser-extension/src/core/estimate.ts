import { formatDuration } from './time';

/** Jira time tracking on one issue, in seconds. Only issues with an original estimate have one. */
export interface Estimate {
  original: number;
  remaining: number;
  spent: number;
}

/** Jira's `timetracking` field as the REST API returns it. */
export interface RawTimeTracking {
  originalEstimateSeconds?: number;
  remainingEstimateSeconds?: number;
  timeSpentSeconds?: number;
}

/** What an estimate bar shows. Fractions are of the whole bar. */
export interface Progress {
  logged: number;
  adding: number;
  over: boolean;
  label: string;
}

/** The issue's own estimate (not summed over sub-tasks), or undefined when it has none. */
export function toEstimate(raw: RawTimeTracking | undefined): Estimate | undefined {
  const original = raw?.originalEstimateSeconds ?? 0;
  if (!(original > 0)) {
    return undefined;
  }
  const spent = Math.max(0, raw?.timeSpentSeconds ?? 0);
  const remaining = Math.max(0, raw?.remainingEstimateSeconds ?? original - spent);
  return { original, remaining, spent };
}

/**
 * The bar for an estimate, filled the way Jira fills its own: logged out of
 * logged + remaining. `pendingSeconds` is time about to be logged; worklogs
 * are posted with adjustEstimate=auto, so it comes off the remaining time.
 */
export function estimateProgress(estimate: Estimate | undefined, pendingSeconds = 0): Progress | null {
  if (!estimate) {
    return null;
  }
  const pending = Math.max(0, pendingSeconds);
  const spentAfter = estimate.spent + pending;
  const remainingAfter = Math.max(0, estimate.remaining - pending);
  const total = spentAfter + remainingAfter;
  const fmt = (s: number) => formatDuration(s * 1000);
  return {
    logged: total > 0 ? estimate.spent / total : 0,
    adding: total > 0 ? pending / total : 0,
    over: spentAfter > estimate.original,
    label: pending > 0 ? `${fmt(estimate.spent)} + ${fmt(pending)} of ${fmt(estimate.original)}` : `${fmt(estimate.spent)} of ${fmt(estimate.original)}`,
  };
}

/**
 * The estimate after a worklog on the issue grew by `deltaSeconds` (negative
 * for less time or a delete), as Jira's adjustEstimate=auto changes it.
 */
export function adjustEstimate(estimate: Estimate, deltaSeconds: number): Estimate {
  return {
    original: estimate.original,
    spent: Math.max(0, estimate.spent + deltaSeconds),
    remaining: Math.max(0, estimate.remaining - deltaSeconds),
  };
}
