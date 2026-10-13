import { jiraStarted } from './core/time';

/**
 * With email + API token the client uses Basic auth. Without them it uses the
 * Jira session already signed in to in this browser (cookies), so most people
 * need no token at all.
 */
export interface JiraCredentials {
  siteUrl: string;
  email?: string;
  apiToken?: string;
}

export interface JiraUser {
  accountId: string;
  displayName: string;
}

export interface IssueSummary {
  key: string;
  summary: string;
}

export interface Worklog {
  id: string;
  authorAccountId: string;
  started: string;
  timeSpentSeconds: number;
}

export class JiraError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'JiraError';
  }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Wraps plain text in the Atlassian Document Format that Jira v3 requires for comments. */
export function toAdf(text: string): unknown {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return {
    type: 'doc',
    version: 1,
    content: lines.map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] })),
  };
}

/** Minimal Jira Cloud REST v3 client for worklogs. */
export class JiraClient {
  private readonly base: string;

  constructor(
    private readonly creds: JiraCredentials,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.base = creds.siteUrl.trim().replace(/\/+$/, '');
    if (!/^https:\/\//.test(this.base) && !/^http:\/\/localhost(:\d+)?$/.test(this.base)) {
      throw new Error('Jira site URL must start with https://');
    }
  }

  get usesToken(): boolean {
    return !!(this.creds.email && this.creds.apiToken);
  }

  async myself(): Promise<JiraUser> {
    const body = await this.request<{ accountId: string; displayName: string }>('GET', '/rest/api/3/myself');
    return { accountId: body.accountId, displayName: body.displayName };
  }

  /** Project keys visible to the user, so lower-case branch names can be matched safely. */
  async projectKeys(): Promise<string[]> {
    const keys: string[] = [];
    let startAt = 0;
    for (let page = 0; page < 20; page++) {
      const body = await this.request<{ values: { key: string }[]; isLast?: boolean; total?: number }>(
        'GET',
        `/rest/api/3/project/search?startAt=${startAt}&maxResults=50`,
      );
      keys.push(...body.values.map((p) => p.key));
      startAt += body.values.length;
      if (body.isLast !== false || body.values.length === 0) {
        break;
      }
    }
    return keys;
  }

  async issue(key: string): Promise<IssueSummary | null> {
    try {
      const body = await this.request<{ key: string; fields: { summary: string } }>(
        'GET',
        `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary`,
      );
      return { key: body.key, summary: body.fields.summary };
    } catch (err) {
      if (err instanceof JiraError && err.status === 404) {
        return null;
      }
      throw err;
    }
  }

  /** Issue picker search, as used by Jira's own quick search. */
  async searchIssues(query: string): Promise<IssueSummary[]> {
    const body = await this.request<{ sections: { issues: { key: string; summaryText: string }[] }[] }>(
      'GET',
      `/rest/api/3/issue/picker?query=${encodeURIComponent(query)}&currentJQL=${encodeURIComponent('order by updated DESC')}`,
    );
    const seen = new Set<string>();
    const results: IssueSummary[] = [];
    for (const section of body.sections ?? []) {
      for (const issue of section.issues ?? []) {
        if (!seen.has(issue.key)) {
          seen.add(issue.key);
          results.push({ key: issue.key, summary: issue.summaryText });
        }
      }
    }
    return results;
  }

  /** Worklogs on an issue that started within [from, to). */
  async worklogs(key: string, from: number, to: number): Promise<Worklog[]> {
    const body = await this.request<{
      worklogs: { id: string; author?: { accountId: string }; started: string; timeSpentSeconds: number }[];
    }>('GET', `/rest/api/3/issue/${encodeURIComponent(key)}/worklog?startedAfter=${from}&startedBefore=${to}&maxResults=5000`);
    return body.worklogs.map((w) => ({
      id: w.id,
      authorAccountId: w.author?.accountId ?? '',
      started: w.started,
      timeSpentSeconds: w.timeSpentSeconds,
    }));
  }

  /**
   * Issues you moved or that are assigned to you and changed today. They show up
   * as suggestions in the review even when no time was tracked on them.
   */
  async touchedSince(from: number): Promise<IssueSummary[]> {
    const day = jqlDate(from);
    const jql = `(status CHANGED BY currentUser() AFTER "${day}") OR (assignee = currentUser() AND updated >= "${day}") ORDER BY updated DESC`;
    const body = await this.request<{ issues: { key: string; fields: { summary: string } }[] }>(
      'POST',
      '/rest/api/3/search/jql',
      { jql, fields: ['summary'], maxResults: 50 },
    );
    return (body.issues ?? []).map((i) => ({ key: i.key, summary: i.fields.summary }));
  }

  /** Open issues assigned to you, the only candidates AI matching may suggest. */
  async assignedToMe(): Promise<IssueSummary[]> {
    const jql = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';
    const body = await this.request<{ issues: { key: string; fields: { summary: string } }[] }>(
      'POST',
      '/rest/api/3/search/jql',
      { jql, fields: ['summary'], maxResults: 50 },
    );
    return (body.issues ?? []).map((i) => ({ key: i.key, summary: i.fields.summary }));
  }

  async addWorklog(key: string, input: { started: number; seconds: number; comment: string }): Promise<string> {
    const body = await this.request<{ id: string }>(
      'POST',
      `/rest/api/3/issue/${encodeURIComponent(key)}/worklog?adjustEstimate=auto&notifyUsers=false`,
      {
        started: jiraStarted(input.started),
        timeSpentSeconds: input.seconds,
        comment: toAdf(input.comment),
      },
    );
    return body.id;
  }

  private async request<T>(method: string, path: string, json?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      // Jira rejects cookie-authenticated writes from other origins without this.
      'X-Atlassian-Token': 'no-check',
    };
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (this.usesToken) {
      headers.Authorization = `Basic ${btoa(`${this.creds.email}:${this.creds.apiToken}`)}`;
    }
    let res: Response;
    try {
      res = await this.fetchImpl(this.base + path, {
        method,
        headers,
        credentials: this.usesToken ? 'omit' : 'include',
        body: json !== undefined ? JSON.stringify(json) : undefined,
      });
    } catch (err) {
      throw new JiraError(`Could not reach Jira: ${(err as Error).message}`, 0);
    }
    if (!res.ok) {
      throw new JiraError(await describeError(res), res.status);
    }
    return (await res.json()) as T;
  }
}

async function describeError(res: Response): Promise<string> {
  let detail = '';
  try {
    const body = (await res.json()) as { errorMessages?: string[]; errors?: Record<string, string> };
    detail = [...(body.errorMessages ?? []), ...Object.values(body.errors ?? {})].join(' ');
  } catch {
    // Non-JSON error body; fall back to the status text.
  }
  switch (res.status) {
    case 401:
      return 'Jira says you are not signed in (401). Sign in to Jira in this browser, or check the email and API token in Settings.';
    case 403:
      return `Jira refused the request (403). You may lack the "Work on issues" permission. ${detail}`.trim();
    case 404:
      return `Not found in Jira (404). ${detail}`.trim();
    default:
      return `Jira returned ${res.status} ${res.statusText}. ${detail}`.trim();
  }
}

/** JQL date literal (yyyy/MM/dd HH:mm) in local time. */
function jqlDate(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
