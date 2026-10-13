import { describe, expect, it, vi } from 'vitest';
import { CursorClient } from '../src/cursor';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function fakeCursor(statuses: string[], result = '{"rows":[]}') {
  const calls: { method: string; url: string; body?: unknown; auth?: string }[] = [];
  let poll = 0;
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(init.body as string) : undefined, auth: (init?.headers as Record<string, string>).Authorization });
    if (method === 'POST' && url.endsWith('/v1/agents')) {
      return json({ agent: { id: 'bc-1' }, run: { id: 'run-1', status: 'CREATING' } });
    }
    if (method === 'GET' && url.endsWith('/runs/run-1')) {
      const status = statuses[Math.min(poll++, statuses.length - 1)];
      return json({ id: 'run-1', status, ...(status === 'FINISHED' ? { result } : {}) });
    }
    return json({ id: 'bc-1' });
  });
  return { calls, fetchImpl };
}

describe('CursorClient', () => {
  it('starts a no-repo agent, waits for the answer and deletes the agent', async () => {
    const { calls, fetchImpl } = fakeCursor(['RUNNING', 'FINISHED'], 'answer');
    const onPoll = vi.fn();
    const client = new CursorClient('key_123', fetchImpl, 'https://api.cursor.com', async () => {});
    expect(await client.ask('hello', { model: 'composer-2', onPoll })).toBe('answer');

    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://api.cursor.com/v1/agents', auth: 'Bearer key_123' });
    expect(calls[0].body).toEqual({ name: 'Timelog: suggest worklogs', prompt: { text: 'hello' }, model: { id: 'composer-2' } });
    expect((calls[0].body as Record<string, unknown>).repos).toBeUndefined();
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: 'https://api.cursor.com/v1/agents/bc-1' });
    expect(onPoll).toHaveBeenCalledTimes(2);
  });

  it('reports a failed run and still cleans up', async () => {
    const { calls, fetchImpl } = fakeCursor(['ERROR']);
    const client = new CursorClient('key', fetchImpl, undefined, async () => {});
    await expect(client.ask('hi')).rejects.toThrow(/stopped without an answer \(error\)/);
    expect(calls.at(-1)?.method).toBe('DELETE');
  });

  it('gives up after the timeout and cancels the run', async () => {
    const { calls, fetchImpl } = fakeCursor(['RUNNING']);
    const client = new CursorClient('key', fetchImpl, undefined, async () => {});
    await expect(client.ask('hi', { timeoutMs: -1 })).rejects.toThrow(/too long/);
    expect(calls.some((c) => c.url.endsWith('/runs/run-1/cancel'))).toBe(true);
  });

  it('explains a rejected key', async () => {
    const client = new CursorClient('bad', async () => json({ error: 'unauthorized' }, 401));
    await expect(client.models()).rejects.toThrow(/rejected the API key/);
  });

  it('requires a key', () => {
    expect(() => new CursorClient('  ')).toThrow(/Cursor API key/);
  });
});
