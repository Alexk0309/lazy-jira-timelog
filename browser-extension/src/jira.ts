import { type Estimate, type RawTimeTracking, toEstimate } from './core/estimate';
import type { TicketDetails } from './core/tickets';
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
  /** Plain text of the worklog comment. */
  comment: string;
}

/** A worklog you logged, as the calendar shows it. */
export interface LoggedWork {
  id: string;
  key: string;
  summary: string;
  /** Epoch ms. */
  started: number;
  seconds: number;
  comment: string;
  /** The issue's time tracking, when it has an estimate. */
  estimate?: Estimate;
}

/** Fields a worklog edit may change. Jira can't move a worklog to another issue. */
export interface WorklogChange {
  started: number;
  seconds: number;
  comment: string;
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

/** Reads the text back out of an Atlassian Document Format comment, one line per block. */
export function fromAdf(doc: unknown): string {
  if (typeof doc === 'string') {
    return doc;
  }
  const lines: string[] = [];
  const inline = (node: unknown): string => {
    const n = node as { type?: string; text?: string; content?: unknown[]; attrs?: { text?: string } };
    if (!n || typeof n !== 'object') {
      return '';
    }
    if (n.type === 'text') {
      return n.text ?? '';
    }
    if (n.type === 'hardBreak') {
      return '\n';
    }
    if (n.type === 'mention' || n.type === 'emoji') {
      return n.attrs?.text ?? '';
    }
    return (n.content ?? []).map(inline).join('');
  };
  const block = (node: unknown): void => {
    const n = node as { type?: string; content?: unknown[] };
    if (!n || typeof n !== 'object') {
      return;
    }
    if (n.type === 'doc' || n.type === 'bulletList' || n.type === 'orderedList' || n.type === 'listItem' || n.type === 'blockquote') {
      (n.content ?? []).forEach(block);
      return;
    }
    const text = inline(n).trim();
    if (text) {
      lines.push(text);
    }
  };
  block(doc);
  return lines.join('\n');
}

/** Parses Jira's `2026-10-13T09:05:00.000+0800` (no colon in the offset). */
export function parseJiraTime(value: string): number {
  return Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
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
      worklogs: { id: string; author?: { accountId: string }; started: string; timeSpentSeconds: number; comment?: unknown }[];
    }>('GET', `/rest/api/3/issue/${encodeURIComponent(key)}/worklog?startedAfter=${from}&startedBefore=${to}&maxResults=5000`);
    return body.worklogs.map((w) => ({
      id: w.id,
      authorAccountId: w.author?.accountId ?? '',
      started: w.started,
      timeSpentSeconds: w.timeSpentSeconds,
      comment: w.comment ? fromAdf(w.comment) : '',
    }));
  }

  /**
   * Your own worklogs that started within [from, to), across all issues.
   * JQL finds the issues (padded a day each side for time zones), then each
   * issue's worklogs are read and filtered to you and the exact range.
   */
  async myWorklogs(from: number, to: number): Promise<LoggedWork[]> {
    const me = await this.myself();
    const jql = `worklogAuthor = currentUser() AND worklogDate >= "${jqlDay(from - 86_400_000)}" AND worklogDate <= "${jqlDay(to + 86_400_000)}"`;
    const issues: (IssueSummary & { estimate?: Estimate })[] = [];
    let nextPageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const body = await this.request<{
        issues?: { key: string; fields: { summary: string; timetracking?: RawTimeTracking } }[];
        nextPageToken?: string;
        isLast?: boolean;
      }>('POST', '/rest/api/3/search/jql', { jql, fields: ['summary', 'timetracking'], maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) });
      issues.push(...(body.issues ?? []).map((i) => ({ key: i.key, summary: i.fields.summary, estimate: toEstimate(i.fields.timetracking) })));
      nextPageToken = body.nextPageToken;
      if (!nextPageToken || body.isLast) {
        break;
      }
    }
    const result: LoggedWork[] = [];
    for (const issue of issues) {
      for (const w of await this.worklogs(issue.key, from, to)) {
        const started = parseJiraTime(w.started);
        if (w.authorAccountId === me.accountId && started >= from && started < to) {
          result.push({
            id: w.id,
            key: issue.key,
            summary: issue.summary,
            started,
            seconds: w.timeSpentSeconds,
            comment: w.comment,
            ...(issue.estimate ? { estimate: issue.estimate } : {}),
          });
        }
      }
    }
    return result.sort((a, b) => a.started - b.started);
  }

  async updateWorklog(key: string, id: string, change: WorklogChange): Promise<void> {
    await this.request(
      'PUT',
      `/rest/api/3/issue/${encodeURIComponent(key)}/worklog/${encodeURIComponent(id)}?adjustEstimate=auto&notifyUsers=false`,
      { started: jiraStarted(change.started), timeSpentSeconds: change.seconds, comment: toAdf(change.comment) },
    );
  }

  async deleteWorklog(key: string, id: string): Promise<void> {
    await this.request(
      'DELETE',
      `/rest/api/3/issue/${encodeURIComponent(key)}/worklog/${encodeURIComponent(id)}?adjustEstimate=auto&notifyUsers=false`,
    );
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

  /** Full details of the given issues; keys Jira doesn't know are left out. */
  async ticketDetails(keys: string[]): Promise<TicketDetails[]> {
    // Only well-formed keys go into JQL, so nothing typed can change the query.
    const valid = [...new Set(keys.map((k) => k.trim().toUpperCase()))].filter((k) => /^[A-Z][A-Z0-9_]+-[1-9]\d*$/.test(k));
    const found: TicketDetails[] = [];
    for (let i = 0; i < valid.length; i += 50) {
      const batch = valid.slice(i, i + 50);
      try {
        found.push(...(await this.ticketsByJql(`key in (${batch.join(', ')})`, batch.length)));
      } catch (err) {
        // JQL fails as a whole when one key doesn't exist, so look the batch up one by one.
        if (!(err instanceof JiraError) || err.status !== 400) {
          throw err;
        }
        for (const key of batch) {
          try {
            found.push(toTicket(await this.request<RawIssue>('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${TICKET_FIELDS.join(',')}`)));
          } catch (inner) {
            if (!(inner instanceof JiraError) || (inner.status !== 404 && inner.status !== 403)) {
              throw inner;
            }
          }
        }
      }
    }
    return found;
  }

  /** Issues matching a JQL query, with what the ticket list shows. */
  async ticketsByJql(jql: string, max = 100): Promise<TicketDetails[]> {
    const found: TicketDetails[] = [];
    let nextPageToken: string | undefined;
    for (let page = 0; page < 10 && found.length < max; page++) {
      const body = await this.request<{ issues?: RawIssue[]; nextPageToken?: string; isLast?: boolean }>('POST', '/rest/api/3/search/jql', {
        jql,
        fields: TICKET_FIELDS,
        maxResults: Math.min(100, max - found.length),
        ...(nextPageToken ? { nextPageToken } : {}),
      });
      found.push(...(body.issues ?? []).map(toTicket));
      nextPageToken = body.nextPageToken;
      if (!nextPageToken || body.isLast) {
        break;
      }
    }
    return found.slice(0, max);
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
    // DELETE answers 204 with no body.
    const text = res.status === 204 ? '' : await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

const TICKET_FIELDS = ['summary', 'status', 'issuetype', 'parent', 'created', 'timetracking'];

interface RawIssue {
  key: string;
  fields: {
    summary?: string;
    status?: { name?: string; statusCategory?: { key?: string } };
    issuetype?: { name?: string };
    parent?: { key?: string; fields?: { summary?: string } };
    created?: string;
    timetracking?: RawTimeTracking;
  };
}

function toTicket(issue: RawIssue): TicketDetails {
  const f = issue.fields ?? {};
  const created = f.created ? parseJiraTime(f.created) : NaN;
  return {
    key: issue.key,
    summary: f.summary ?? '',
    status: f.status?.name ?? '',
    statusCategory: f.status?.statusCategory?.key ?? '',
    issueType: f.issuetype?.name ?? '',
    ...(f.parent?.key ? { parentKey: f.parent.key, parentSummary: f.parent.fields?.summary ?? '' } : {}),
    created: Number.isFinite(created) ? created : 0,
    // Always set, so a refresh clears an estimate that was removed in Jira.
    estimate: toEstimate(f.timetracking),
  };
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

/** JQL day literal (yyyy-MM-dd) in local time. */
function jqlDay(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** JQL date literal (yyyy/MM/dd HH:mm) in local time. */
function jqlDate(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
