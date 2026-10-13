import { buildDrafts, totalUnloggedMs } from './core/drafts';
import { shouldRemind } from './core/reminder';
import { buildSessions } from './core/sessions';
import { dayEnd, dayStart, localDay, parseClock, parseDuration } from './core/time';
import type { Draft } from './core/types';
import { extractIssueKey } from './core/issueKey';
import { JiraClient, type IssueSummary } from './jira';
import type { Settings, Store } from './storage';

/** How far back the review shows unlogged days. */
export const REVIEW_DAYS = 14;

export interface PostInput {
  day: string;
  sourceKey: string;
  rawMs: number;
  targetKey: string;
  duration: string;
  started: number;
  comment: string;
}

export interface ReviewState {
  drafts: Draft[];
  today: string;
  totalMs: number;
  todayMs: number;
  setupMessage: string | null;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Everything the popup, review page and options page ask the background for. */
export class Service {
  private summaries = new Map<string, string | null>();

  constructor(
    private readonly store: Store,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly now: () => number = Date.now,
  ) {}

  async drafts(): Promise<Draft[]> {
    const s = await this.store.settings();
    const [heartbeats, notes, settled] = await Promise.all([
      this.store.heartbeats(REVIEW_DAYS, this.now()),
      this.store.notes(),
      this.store.settled(),
    ]);
    return buildDrafts(buildSessions(heartbeats, s.idleMinutes * 60000), notes, settled, {
      roundMinutes: s.roundMinutes,
      minSessionMinutes: s.minSessionMinutes,
    });
  }

  async state(): Promise<ReviewState> {
    const drafts = await this.drafts();
    const today = localDay(this.now());
    const client = await this.client();
    return {
      drafts,
      today,
      totalMs: totalUnloggedMs(drafts),
      todayMs: totalUnloggedMs(drafts, today),
      setupMessage: typeof client === 'string' ? client : null,
    };
  }

  async client(settings?: Settings): Promise<JiraClient | string> {
    const s = settings ?? (await this.store.settings());
    if (!s.siteUrl) {
      return 'Add your Jira site in Settings to start.';
    }
    try {
      return new JiraClient({ siteUrl: s.siteUrl, email: s.email || undefined, apiToken: s.apiToken || undefined }, this.fetchImpl);
    } catch (err) {
      return (err as Error).message;
    }
  }

  private async requireClient(): Promise<JiraClient> {
    const client = await this.client();
    if (typeof client === 'string') {
      throw new Error(client);
    }
    return client;
  }

  /** Checks the connection and caches project keys for precise matching. */
  async connect(): Promise<string> {
    const client = await this.requireClient();
    const me = await client.myself();
    const keys = await client.projectKeys();
    await this.store.setProjectKeys(keys);
    const how = client.usesToken ? 'with your API token' : 'with your browser session';
    return `Connected as ${me.displayName} ${how}. ${keys.length} project${keys.length === 1 ? '' : 's'} found.`;
  }

  async post(input: PostInput): Promise<string> {
    const targetKey = extractIssueKey(input.targetKey.trim().toUpperCase());
    if (!targetKey) {
      throw new Error('Pick a Jira issue first.');
    }
    const seconds = parseDuration(input.duration);
    if (seconds === null || seconds < 60) {
      throw new Error('Enter a duration like 1h 30m.');
    }
    const client = await this.requireClient();
    const rawMs = await this.clamp(input.day, input.sourceKey, input.rawMs);
    const worklogId = await client.addWorklog(targetKey, { started: input.started, seconds, comment: input.comment });
    await this.store.addSettled({
      day: input.day,
      sourceKey: input.sourceKey,
      rawMs,
      action: 'posted',
      targetKey,
      worklogId,
      postedSeconds: seconds,
      at: this.now(),
    });
    return worklogId;
  }

  async discard(day: string, sourceKey: string, rawMs: number): Promise<void> {
    await this.store.addSettled({
      day,
      sourceKey,
      rawMs: await this.clamp(day, sourceKey, rawMs),
      action: 'discarded',
      at: this.now(),
    });
  }

  async search(query: string): Promise<IssueSummary[]> {
    if (query.trim().length < 2) {
      return [];
    }
    const client = await this.requireClient();
    return (await client.searchIssues(query.trim())).slice(0, 8);
  }

  async issueSummaries(keys: string[]): Promise<Record<string, string | null>> {
    const client = await this.client();
    const result: Record<string, string | null> = {};
    for (const key of [...new Set(keys)].filter(Boolean)) {
      if (!this.summaries.has(key) && typeof client !== 'string') {
        try {
          this.summaries.set(key, (await client.issue(key))?.summary ?? null);
        } catch {
          continue;
        }
      }
      if (this.summaries.has(key)) {
        result[key] = this.summaries.get(key) ?? null;
      }
    }
    return result;
  }

  /** Seconds you already logged by hand per issue and day (worklogs this tool didn't post). */
  async manualLogs(items: { key: string; day: string }[]): Promise<Record<string, number>> {
    const client = await this.client();
    if (typeof client === 'string') {
      return {};
    }
    const me = await client.myself();
    const ours = new Set((await this.store.settled()).map((e) => e.worklogId).filter(Boolean));
    const result: Record<string, number> = {};
    for (const { key, day } of items) {
      try {
        const logs = await client.worklogs(key, dayStart(day), dayEnd(day));
        const seconds = logs
          .filter((w) => w.authorAccountId === me.accountId && !ours.has(w.id))
          .reduce((sum, w) => sum + w.timeSpentSeconds, 0);
        if (seconds > 0) {
          result[`${key}|${day}`] = seconds;
        }
      } catch {
        // Missing or hidden issue; the summary lookup reports it.
      }
    }
    return result;
  }

  /** Issues touched in Jira today that have no tracked time yet. */
  async suggestions(): Promise<IssueSummary[]> {
    const client = await this.client();
    if (typeof client === 'string') {
      return [];
    }
    const today = localDay(this.now());
    const tracked = new Set((await this.drafts()).filter((d) => d.day === today).map((d) => d.sourceKey));
    const settledToday = new Set((await this.store.settled()).filter((e) => e.day === today).map((e) => e.targetKey ?? e.sourceKey));
    try {
      const touched = await client.touchedSince(dayStart(today));
      return touched.filter((i) => !tracked.has(i.key) && !settledToday.has(i.key)).slice(0, 5);
    } catch {
      return [];
    }
  }

  /** True once per day, at or after the reminder time, when something is unlogged today. */
  async reminderDue(): Promise<{ due: boolean; todayMs: number }> {
    const s = await this.store.settings();
    const drafts = await this.drafts();
    const todayMs = totalUnloggedMs(drafts, localDay(this.now()));
    const due = shouldRemind({
      now: this.now(),
      reminderMinutes: parseClock(s.reminderTime),
      lastRemindedDay: await this.store.lastRemindedDay(),
      unloggedTodayMs: todayMs,
    });
    if (due) {
      await this.store.setLastRemindedDay(localDay(this.now()));
    }
    return { due, todayMs };
  }

  private async clamp(day: string, sourceKey: string, rawMs: number): Promise<number> {
    const draft = (await this.drafts()).find((d) => d.day === day && d.sourceKey === sourceKey);
    return Math.max(0, Math.min(rawMs, draft?.rawMs ?? rawMs));
  }
}
