/** One activity signal from the editor. Persisted as one JSON line. */
export interface Heartbeat {
  /** Epoch milliseconds. */
  t: number;
  /** Repository root (or workspace folder) the activity belongs to. */
  repo: string;
  /** Current branch, or null outside git / detached HEAD. */
  branch: string | null;
  /** Jira issue key the time is attributed to, or null for Unassigned. */
  key: string | null;
  /** What produced the signal (edit, save, focus, terminal, debug, ...). */
  signal: string;
}

/** A commit made while working, used for issue keys and worklog comments. */
export interface CommitRecord {
  t: number;
  repo: string;
  branch: string | null;
  hash: string;
  subject: string;
}

/** Continuous activity on one issue. */
export interface Session {
  key: string | null;
  repo: string;
  branch: string | null;
  start: number;
  end: number;
  activeMs: number;
}

/**
 * Time already dealt with (posted to Jira or discarded) for one source bucket.
 * `sourceKey` is the bucket the time came from ("" = Unassigned); the worklog
 * may have gone to a different `targetKey` if the developer reassigned it.
 */
export interface SettledEntry {
  day: string;
  sourceKey: string;
  rawMs: number;
  action: 'posted' | 'discarded';
  targetKey?: string;
  worklogId?: string;
  postedSeconds?: number;
  at: number;
}

/** A proposed worklog shown in the review panel. */
export interface Draft {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  /** Source bucket ("" = Unassigned). */
  sourceKey: string;
  /** Unsettled raw active time, after dropping short sessions. */
  rawMs: number;
  /** Suggested duration after rounding. */
  seconds: number;
  /** Earliest activity in this bucket that day; becomes the worklog's `started`. */
  started: number;
  comment: string;
  branches: string[];
}
