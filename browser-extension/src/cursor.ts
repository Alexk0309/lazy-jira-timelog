type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const CURSOR_API = 'https://api.cursor.com';

export interface CursorModel {
  id: string;
  displayName: string;
}

export interface RunOptions {
  /** Model id from `models()`; empty uses the person's Cursor default. */
  model?: string;
  pollMs?: number;
  timeoutMs?: number;
  /** Called on every poll; the background uses it to stay awake. */
  onPoll?: () => unknown;
}

interface RunBody {
  id: string;
  status: 'CREATING' | 'RUNNING' | 'FINISHED' | 'ERROR' | 'CANCELLED' | 'EXPIRED';
  result?: string;
}

export class CursorError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Minimal client for Cursor's Cloud Agents API, called directly with a user
 * API key. The Cursor SDK wraps the same API but needs Node, so it can't run
 * in a browser extension.
 */
export class CursorClient {
  private readonly base: string;

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch,
    base = CURSOR_API,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    if (!apiKey.trim()) {
      throw new Error('Add your Cursor API key in Settings first.');
    }
    this.base = base.replace(/\/+$/, '');
  }

  async models(): Promise<CursorModel[]> {
    const body = await this.request<{ items?: CursorModel[] }>('GET', '/v1/models');
    return (body.items ?? []).map((m) => ({ id: m.id, displayName: m.displayName ?? m.id }));
  }

  /**
   * Starts a short-lived agent with no repository, waits for its reply and
   * deletes it again so it doesn't clutter the person's Cursor agent list.
   */
  async ask(prompt: string, options: RunOptions = {}): Promise<string> {
    const { pollMs = 2000, timeoutMs = 180_000 } = options;
    const created = await this.request<{ agent: { id: string }; run: RunBody }>('POST', '/v1/agents', {
      name: 'Timelog: suggest worklogs',
      prompt: { text: prompt },
      ...(options.model ? { model: { id: options.model } } : {}),
    });
    const agentId = created.agent.id;
    try {
      let run = created.run;
      const deadline = Date.now() + timeoutMs;
      while (run.status === 'CREATING' || run.status === 'RUNNING') {
        if (Date.now() > deadline) {
          await this.request('POST', `/v1/agents/${agentId}/runs/${run.id}/cancel`).catch(() => undefined);
          throw new CursorError('Cursor took too long to answer. Try again in a moment.', 0);
        }
        await options.onPoll?.();
        await this.sleep(pollMs);
        run = await this.request<RunBody>('GET', `/v1/agents/${agentId}/runs/${run.id}`);
      }
      if (run.status !== 'FINISHED' || !run.result) {
        throw new CursorError(`Cursor's agent stopped without an answer (${run.status.toLowerCase()}).`, 0);
      }
      return run.result;
    } finally {
      await this.request('DELETE', `/v1/agents/${agentId}`).catch(() => undefined);
    }
  }

  private async request<T>(method: string, path: string, json?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.base + path, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.apiKey.trim()}`,
          ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        credentials: 'omit',
        body: json !== undefined ? JSON.stringify(json) : undefined,
      });
    } catch (err) {
      throw new CursorError(`Could not reach Cursor: ${(err as Error).message}`, 0);
    }
    if (!res.ok) {
      throw new CursorError(await describeError(res), res.status);
    }
    return (await res.json()) as T;
  }
}

async function describeError(res: Response): Promise<string> {
  let detail = '';
  try {
    const body = (await res.json()) as { error?: string | { message?: string }; message?: string };
    detail = (typeof body.error === 'string' ? body.error : body.error?.message) ?? body.message ?? '';
  } catch {
    // Non-JSON error body.
  }
  switch (res.status) {
    case 401:
      return 'Cursor rejected the API key (401). Create a user key in Cursor Dashboard → API Keys.';
    case 403:
      return `Cursor refused the request (403). Your team may need to allow agents without a repository. ${detail}`.trim();
    case 429:
      return 'Cursor is rate limiting requests (429). Try again in a minute.';
    default:
      return `Cursor returned ${res.status}. ${detail}`.trim();
  }
}
