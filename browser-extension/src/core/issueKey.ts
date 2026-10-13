import type { CommitRecord } from './types';

// Jira keys: project key (letter, then letters/digits/underscore) + number.
// Lookarounds stop matches inside longer words such as "XPAY-12" -> "PAY-12".
const KEY_PATTERN = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9_]+-[1-9]\d*)(?![A-Za-z0-9])/g;

// Common branch-name tokens that look like keys but are not.
const NOT_KEYS = new Set(['UTF-8', 'UTF-16', 'ISO-8601', 'SHA-1', 'SHA-256', 'RFC-1', 'ES-2015']);

/**
 * Returns the first Jira issue key in `text`, upper-cased, or null.
 *
 * With `projectKeys`, only those projects count and case is ignored, so
 * lower-case branches like `feature/pay-142-refunds` work. Without them only
 * upper-case keys count, otherwise `fix-42` or `release-2` would match.
 */
export function extractIssueKey(text: string | null | undefined, projectKeys?: string[]): string | null {
  if (!text) {
    return null;
  }
  const allowed = projectKeys && projectKeys.length > 0 ? new Set(projectKeys.map((k) => k.toUpperCase())) : null;
  for (const match of text.matchAll(KEY_PATTERN)) {
    const key = match[1].toUpperCase();
    if (NOT_KEYS.has(key)) {
      continue;
    }
    if (allowed ? !allowed.has(key.slice(0, key.lastIndexOf('-'))) : match[1] !== key) {
      continue;
    }
    return key;
  }
  return null;
}

export interface ResolveInput {
  branch: string | null;
  repo: string;
  /** Commits recorded on this repo, any order. */
  commits: CommitRecord[];
  /** Per-repo fallback from settings, may be empty. */
  defaultIssue: string;
  projectKeys?: string[];
}

/**
 * Picks the issue key for current activity, in the design's priority order:
 * branch name, then the latest commit on this branch that names a key, then
 * the repo default. Null means the time is collected as Unassigned.
 */
export function resolveIssueKey(input: ResolveInput): string | null {
  const fromBranch = extractIssueKey(input.branch, input.projectKeys);
  if (fromBranch) {
    return fromBranch;
  }
  if (input.branch) {
    const onBranch = input.commits
      .filter((c) => c.repo === input.repo && c.branch === input.branch)
      .sort((a, b) => b.t - a.t);
    for (const commit of onBranch) {
      const key = extractIssueKey(commit.subject, input.projectKeys);
      if (key) {
        return key;
      }
    }
  }
  return extractIssueKey(input.defaultIssue?.toUpperCase()) ?? null;
}
