import type { AiResult } from './ai';
import type { TicketList } from './core/tickets';
import type { IssueSummary, LoggedWork } from './jira';
import type { IssueInfo, PostInput, ReviewState, WorklogEdit } from './service';
import type { AiState, Settings } from './storage';
import type { Tracking } from './tracker';

/** Requests the extension pages send to the background worker, and what each returns. */
export interface Api {
  state: { req: void; res: ReviewState & { tracking: Tracking | null } };
  post: { req: PostInput; res: string };
  discard: { req: { day: string; sourceKey: string; rawMs: number }; res: void };
  search: { req: { query: string }; res: IssueSummary[] };
  summaries: { req: { keys: string[] }; res: Record<string, string | null> };
  issues: { req: { keys: string[] }; res: Record<string, IssueInfo | null> };
  manualLogs: { req: { items: { key: string; day: string }[] }; res: Record<string, number> };
  suggestions: { req: void; res: IssueSummary[] };
  getSettings: { req: void; res: Settings };
  saveSettings: { req: Partial<Settings>; res: Settings };
  connect: { req: void; res: string };
  testCursor: { req: void; res: { message: string; models: { id: string; displayName: string }[] } };
  aiSuggest: { req: { day: string; summary?: string }; res: AiResult };
  aiState: { req: void; res: AiState | undefined };
  consumeAiEntry: { req: { at: number; index: number }; res: void };
  answerAiQuestion: { req: { at: number; index: number; key: string }; res: void };
  tickets: { req: void; res: TicketList };
  addTickets: { req: { text: string }; res: { list: TicketList; added: string[]; missing: string[] } };
  addAssigned: { req: void; res: { list: TicketList; added: string[] } };
  refreshTickets: { req: void; res: TicketList };
  flagTickets: { req: { keys: string[]; flagged: boolean }; res: TicketList };
  removeTickets: { req: { keys: string[] }; res: TicketList };
  reorderTickets: { req: { keys: string[] }; res: TicketList };
  sortTickets: { req: void; res: TicketList };
  logged: { req: { from: number; to: number }; res: LoggedWork[] };
  editWorklog: { req: WorklogEdit; res: { key: string; id: string } };
  deleteWorklog: { req: { key: string; id: string }; res: void };
}

export type Request = { [K in keyof Api]: { type: K; payload: Api[K]['req'] } }[keyof Api];
export type Reply<T> = { ok: true; value: T } | { ok: false; error: string };

/** Typed call from a page to the background worker. Rejects with the worker's error message. */
export async function call<K extends keyof Api>(type: K, payload?: Api[K]['req']): Promise<Api[K]['res']> {
  const reply = (await chrome.runtime.sendMessage({ type, payload })) as Reply<Api[K]['res']> | undefined;
  if (!reply) {
    throw new Error('The extension background is not responding. Try reopening this page.');
  }
  if (!reply.ok) {
    throw new Error(reply.error);
  }
  return reply.value;
}
