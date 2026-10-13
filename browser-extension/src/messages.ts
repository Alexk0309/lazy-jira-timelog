import type { AiSuggestion } from './ai';
import type { IssueSummary } from './jira';
import type { PostInput, ReviewState } from './service';
import type { AiState, Settings } from './storage';
import type { Tracking } from './tracker';

/** Requests the extension pages send to the background worker, and what each returns. */
export interface Api {
  state: { req: void; res: ReviewState & { tracking: Tracking | null } };
  post: { req: PostInput; res: string };
  discard: { req: { day: string; sourceKey: string; rawMs: number }; res: void };
  search: { req: { query: string }; res: IssueSummary[] };
  summaries: { req: { keys: string[] }; res: Record<string, string | null> };
  manualLogs: { req: { items: { key: string; day: string }[] }; res: Record<string, number> };
  suggestions: { req: void; res: IssueSummary[] };
  getSettings: { req: void; res: Settings };
  saveSettings: { req: Partial<Settings>; res: Settings };
  connect: { req: void; res: string };
  testCursor: { req: void; res: { message: string; models: { id: string; displayName: string }[] } };
  aiSuggest: { req: { day: string }; res: AiSuggestion[] };
  aiState: { req: void; res: AiState | undefined };
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
