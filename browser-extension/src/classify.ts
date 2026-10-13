import { extractIssueKey } from './core/issueKey';

export interface TabWork {
  /** Jira issue key the tab is about, or an unassigned key (see `unassignedKey`). */
  key: string;
  /** Hostname, kept instead of the URL so browsing history is never stored. */
  source: string;
  /** What kind of page this is, for the review screen. */
  kind: 'issue' | 'pull-request' | 'branch' | 'page';
  /** A short human label (a PR title) that can seed the worklog comment. */
  label?: string;
  /** Stable id for the label, so the same PR isn't listed twice. */
  labelId?: string;
}

export interface ClassifyContext {
  /** Hostname of the configured Jira site, e.g. `team.atlassian.net`. */
  jiraHost: string | null;
  /** Known Jira project keys; makes matching precise and case-insensitive. */
  projectKeys: string[];
}

const PR_PATHS: [RegExp, TabWork['kind']][] = [
  [/^\/[^/]+\/[^/]+\/pull\/\d+/, 'pull-request'], // GitHub
  [/\/-\/merge_requests\/\d+/, 'pull-request'], // GitLab
  [/^\/[^/]+\/[^/]+\/pull-requests\/\d+/, 'pull-request'], // Bitbucket
  [/^\/[^/]+\/[^/]+\/(tree|compare|commits?)\//, 'branch'], // GitHub branch views
  [/\/-\/(tree|compare|commits)\//, 'branch'], // GitLab branch views
  [/^\/[^/]+\/[^/]+\/branch\//, 'branch'], // Bitbucket
];

/**
 * Works out which Jira issue (if any) a tab is about. Returns null for tabs
 * that aren't tied to an issue; those are never recorded.
 */
export function classifyTab(rawUrl: string | undefined, title: string | undefined, ctx: ClassifyContext): TabWork | null {
  if (!rawUrl) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return null;
  }
  const source = url.hostname;
  const keys = ctx.projectKeys;
  const pageTitle = title ?? '';
  const isJira = (source === ctx.jiraHost || source.endsWith('.atlassian.net')) && !url.pathname.startsWith('/wiki');

  if (isJira) {
    const fromPath = /\/browse\/([A-Za-z][A-Za-z0-9_]+-\d+)/.exec(url.pathname)?.[1];
    const fromQuery = url.searchParams.get('selectedIssue') ?? url.searchParams.get('issueKey');
    const key = extractIssueKey(fromPath?.toUpperCase()) ?? extractIssueKey(fromQuery?.toUpperCase());
    return key ? { key, source, kind: 'issue' } : null;
  }

  const decodedPath = safeDecode(url.pathname);
  for (const [pattern, kind] of PR_PATHS) {
    if (pattern.test(url.pathname)) {
      const found = extractIssueKey(pageTitle, keys) ?? extractIssueKey(decodedPath, keys);
      if (kind !== 'pull-request') {
        return found ? { key: found, source, kind } : null;
      }
      // Pull requests without a key are still work: they're kept as unassigned
      // time under the PR title, so it can be matched to an issue at review.
      const match = pattern.exec(url.pathname)!;
      const labelId = `${source}${url.pathname.slice(0, match.index + match[0].length)}`;
      return { key: found ?? unassignedKey(labelId), source, kind, label: cleanTitle(pageTitle), labelId };
    }
  }

  // Anything else (Confluence, docs, design tools): only when a key is plainly visible.
  const key = extractIssueKey(pageTitle, keys) ?? extractIssueKey(decodedPath, keys);
  return key ? { key, source, kind: 'page' } : null;
}

/** "PAY-7 Add refunds by dev · Pull Request #42 · org/repo · GitHub" -> "PAY-7 Add refunds by dev (#42)". */
export function cleanTitle(title: string): string {
  const github = /^(.*?) by \S+ · Pull Request (#\d+) · .*$/.exec(title) ?? /^(.*?) · Pull Request (#\d+) · .*$/.exec(title);
  if (github) {
    return `${github[1].trim()} (${github[2]})`;
  }
  const gitlab = /^(.*?) \((!\d+)\) · Merge requests? · .*$/.exec(title);
  if (gitlab) {
    return `${gitlab[1].trim()} (${gitlab[2]})`;
  }
  return title.split(/ [·|–—-] /)[0].trim().slice(0, 200);
}

/**
 * Bucket for unassigned work on one page, e.g. a PR whose title has no key.
 * It's a short hash so the page address itself is never stored.
 */
export function unassignedKey(labelId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < labelId.length; i++) {
    h = Math.imul(h ^ labelId.charCodeAt(i), 0x01000193);
  }
  return `~${(h >>> 0).toString(36)}`;
}

export function isUnassignedKey(key: string): boolean {
  return key.startsWith('~');
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
