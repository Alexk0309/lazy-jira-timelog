import { buildPrompt, parseSuggestions, type AiInput, type AiResult } from './ai';
import * as list from './core/tickets';
import type { TicketList } from './core/tickets';
import { buildDrafts, totalUnloggedMs } from './core/drafts';
import { shouldRemind } from './core/reminder';
import { buildSessions } from './core/sessions';
import { dayEnd, dayStart, localDay, parseClock, parseDuration } from './core/time';
import type { Estimate } from './core/estimate';
import type { Draft } from './core/types';
import { extractIssueKey, extractIssueKeys } from './core/issueKey';
import { CURSOR_API, CursorClient } from './cursor';
import { JiraClient, type IssueSummary, type LoggedWork } from './jira';
import type { AiState, Settings, Store } from './storage';

/** How far back the review shows unlogged days. */
export const REVIEW_DAYS = 14;

/** A "Fill in with AI" run older than this is treated as abandoned. */
const AI_RUN_TIMEOUT_MS = 4 * 60_000;

export interface PostInput {
  day: string;
  sourceKey: string;
  rawMs: number;
  targetKey: string;
  duration: string;
  started: number;
  comment: string;
}

export interface WorklogEdit {
  key: string;
  id: string;
  /** Epoch ms. */
  started: number;
  duration: string;
  comment: string;
}

/** What the review and calendar show next to an issue key. */
export interface IssueInfo {
  summary: string;
  estimate?: Estimate;
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
    private readonly sleep?: (ms: number) => Promise<void>,
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

  private async cursor(): Promise<{ client: CursorClient; model: string }> {
    const s = await this.store.settings();
    const base = s.cursorApiUrl || CURSOR_API;
    if (!/^https:\/\//.test(base) && !/^http:\/\/localhost(:\d+)?$/.test(base)) {
      throw new Error('Cursor API URL must start with https://');
    }
    return { client: new CursorClient(s.cursorApiKey, this.fetchImpl, base, this.sleep), model: s.cursorModel };
  }

  /** Checks the Cursor key and lists the models it can use. */
  async testCursor(): Promise<{ message: string; models: { id: string; displayName: string }[] }> {
    const { client } = await this.cursor();
    const models = await client.models();
    return { message: `Cursor key works. ${models.length} model${models.length === 1 ? '' : 's'} available.`, models };
  }

  async aiState(): Promise<AiState | undefined> {
    return this.store.aiState();
  }

  /**
   * Asks Cursor to write a comment for each of the day's entries and to match
   * unassigned time to one of your open, assigned issues. With a summary of
   * the day it also adjusts times you mention and proposes entries for work
   * nothing tracked. Nothing is logged.
   */
  async aiSuggest(day: string, summary = '', keepAlive?: () => unknown): Promise<AiResult> {
    const running = await this.store.aiState();
    if (running?.status === 'running' && this.now() - running.at < AI_RUN_TIMEOUT_MS) {
      throw new Error('Cursor is still working on the last request.');
    }
    summary = summary.trim();
    const { client, model } = await this.cursor();
    const drafts = (await this.drafts()).filter((d) => d.day === day);
    if (drafts.length === 0 && !summary) {
      throw new Error('There is nothing to fill in for this day. Describe your day to add entries.');
    }
    const jira = await this.requireClient();
    await this.store.setAiState({ day, status: 'running', at: this.now() });
    try {
      const assigned = await jira.assignedToMe();
      // Your ticket list steers matching: tickets on it may be used even when they aren't assigned to you.
      const saved = list.prioritized(await this.store.tickets()).map((t) => ({
        key: t.key,
        summary: t.summary,
        flagged: t.flagged,
        ...(t.parentSummary ? { parent: t.parentSummary } : {}),
      }));
      const keys = drafts.map((d) => issueKeyOf(d.sourceKey)).filter((k): k is string => !!k);
      // Keys you typed yourself may be used even when they aren't assigned to you, if they exist.
      const known = new Set([...assigned, ...saved].map((i) => i.key));
      const typed = extractIssueKeys(summary, await this.store.projectKeys()).filter((k) => !known.has(k));
      const summaries = await this.issueSummaries([...keys, ...typed]);
      const mentioned = typed.filter((k) => summaries[k]).map((k) => ({ key: k, summary: summaries[k] as string }));
      const notes = (await this.store.notes()).filter((n) => localDay(n.t) === day);
      const input: AiInput = {
        day,
        assigned,
        saved,
        summary,
        mentioned,
        rows: drafts.map((d) => {
          const key = issueKeyOf(d.sourceKey);
          const seen = [...new Set(notes.filter((n) => n.branch === d.sourceKey).map((n) => n.subject))];
          return {
            id: d.sourceKey,
            key,
            minutes: Math.round(d.seconds / 60),
            title: (key ? summaries[key] : null) ?? seen[0] ?? '',
            notes: seen,
          };
        }),
      };
      const reply = await client.ask(buildPrompt(input), { model, onPoll: keepAlive });
      const result = parseSuggestions(reply, input);
      await this.store.setAiState({
        day,
        status: 'done',
        at: this.now(),
        suggestions: result.rows,
        added: result.added,
        questions: result.questions,
      });
      return result;
    } catch (err) {
      await this.store.setAiState({ day, status: 'error', at: this.now(), error: (err as Error).message });
      throw err;
    }
  }

  /** Marks one AI-added entry as logged or removed so reopening the popup doesn't bring it back. */
  async consumeAiEntry(at: number, index: number): Promise<void> {
    const state = await this.store.aiState();
    if (state?.at === at && !state.consumed?.includes(index)) {
      await this.store.setAiState({ ...state, consumed: [...(state.consumed ?? []), index] });
    }
  }

  /** Remembers your answer to one of Cursor's questions so reopening the popup doesn't ask again. */
  async answerAiQuestion(at: number, index: number, key: string): Promise<void> {
    const state = await this.store.aiState();
    if (state?.at === at && state.questions?.[index]) {
      await this.store.setAiState({ ...state, answers: { ...state.answers, [index]: key } });
    }
  }

  // ---------- Your ticket list ----------

  tickets(): Promise<TicketList> {
    return this.store.tickets();
  }

  /** Adds every issue key found in `text` (one key, or a pasted list). */
  async addTickets(text: string): Promise<{ list: TicketList; added: string[]; missing: string[] }> {
    const projectKeys = await this.store.projectKeys();
    // Without project keys only upper-case keys count, so accept what was pasted in any case.
    const keys = extractIssueKeys(projectKeys.length > 0 ? text : text.toUpperCase(), projectKeys);
    if (keys.length === 0) {
      throw new Error('No Jira keys found. Paste keys like PAY-12, separated by spaces or new lines.');
    }
    const details = await (await this.requireClient()).ticketDetails(keys);
    const found = new Set(details.map((d) => d.key));
    const result = await this.saveFound(details);
    return { ...result, missing: keys.filter((k) => !found.has(k)) };
  }

  /** One click: every open issue assigned to you goes on the list. */
  async addAssigned(): Promise<{ list: TicketList; added: string[] }> {
    const client = await this.requireClient();
    return this.saveFound(await client.ticketsByJql('assignee = currentUser() AND statusCategory != Done ORDER BY created DESC', 100));
  }

  /** Re-reads summary, status and parent of everything on the list. */
  async refreshTickets(): Promise<TicketList> {
    const keys = (await this.store.tickets()).tickets.map((t) => t.key);
    const details = keys.length > 0 ? await (await this.requireClient()).ticketDetails(keys) : [];
    return this.store.updateTickets((current) => list.refreshTickets(current, details));
  }

  flagTickets(keys: string[], flagged: boolean): Promise<TicketList> {
    return this.store.updateTickets((current) => list.setFlag(current, keys, flagged));
  }

  removeTickets(keys: string[]): Promise<TicketList> {
    return this.store.updateTickets((current) => list.removeTickets(current, keys));
  }

  reorderTickets(keys: string[]): Promise<TicketList> {
    return this.store.updateTickets((current) => list.reorderTickets(current, keys));
  }

  sortTickets(): Promise<TicketList> {
    return this.store.updateTickets((current) => list.sortByCreated(current));
  }

  private async saveFound(details: list.TicketDetails[]): Promise<{ list: TicketList; added: string[] }> {
    // Jira is read before the queued write so tracking never waits on the network.
    let added: string[] = [];
    const next = await this.store.updateTickets((current) => {
      const result = list.addTickets(current, details, this.now());
      added = result.added;
      return result.list;
    });
    return { list: next, added };
  }

  /** Your worklogs that started within [from, to), for the calendar. */
  async logged(from: number, to: number): Promise<LoggedWork[]> {
    const client = await this.requireClient();
    const logs = await client.myWorklogs(from, to);
    for (const log of logs) {
      this.summaries.set(log.key, log.summary);
    }
    return logs;
  }

  async editWorklog(edit: WorklogEdit): Promise<void> {
    const seconds = parseDuration(edit.duration);
    if (seconds === null || seconds < 60) {
      throw new Error('Enter a duration like 1h 30m.');
    }
    if (!Number.isFinite(edit.started)) {
      throw new Error('Enter a start time.');
    }
    const client = await this.requireClient();
    await client.updateWorklog(edit.key, edit.id, { started: edit.started, seconds, comment: edit.comment });
  }

  /**
   * Deletes a worklog in Jira. Time this tool posted stays settled, so it
   * doesn't come back as something to log.
   */
  async deleteWorklog(key: string, id: string): Promise<void> {
    const client = await this.requireClient();
    await client.deleteWorklog(key, id);
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
    for (const key of [...new Set(keys)].filter((k) => issueKeyOf(k))) {
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

  /**
   * Title and time tracking of each issue, read fresh so estimates reflect what
   * was just logged. Keys Jira doesn't know map to null; on errors keys are left out.
   */
  async issues(keys: string[]): Promise<Record<string, IssueInfo | null>> {
    const wanted = [...new Set(keys.map((k) => issueKeyOf(k)).filter((k): k is string => !!k))];
    const client = await this.client();
    if (wanted.length === 0 || typeof client === 'string') {
      return {};
    }
    let details: list.TicketDetails[];
    try {
      details = await client.ticketDetails(wanted);
    } catch {
      return {};
    }
    const result: Record<string, IssueInfo | null> = Object.fromEntries(wanted.map((k) => [k, null]));
    for (const d of details) {
      this.summaries.set(d.key, d.summary);
      result[d.key] = { summary: d.summary, ...(d.estimate ? { estimate: d.estimate } : {}) };
    }
    for (const key of wanted) {
      if (result[key] === null) {
        this.summaries.set(key, null);
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

/** The Jira key a draft bucket stands for, or null for unassigned time. */
function issueKeyOf(sourceKey: string): string | null {
  return sourceKey && extractIssueKey(sourceKey) === sourceKey ? sourceKey : null;
}
