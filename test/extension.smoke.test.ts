import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activate } from '../src/extension';
import { Uri, fake } from './fakeVscode';

const flush = () => new Promise((r) => setTimeout(r, 30));
const at = (min: number) => new Date(2026, 9, 13, 9, 0).getTime() + min * 60_000;

function jiraFetch(calls: { method: string; url: string; body?: any }[]) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.endsWith('/rest/api/3/myself')) return reply({ accountId: 'me', displayName: 'Dev' });
    if (url.includes('/project/search')) return reply({ values: [{ key: 'PAY' }], isLast: true });
    if (url.includes('/worklog') && method === 'POST') return reply({ id: '900' }, 201);
    if (url.includes('/worklog')) return reply({ worklogs: [{ id: '1', author: { accountId: 'me' }, started: '', timeSpentSeconds: 1800 }] });
    if (url.includes('/issue/PAY-7')) return reply({ key: 'PAY-7', fields: { summary: 'Refund flow' } });
    return reply({}, 404);
  });
}

let subscriptions: { dispose(): unknown }[] = [];
afterEach(() => {
  subscriptions.forEach((s) => s.dispose());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('extension end to end (fake editor)', () => {
  it('tracks a branch, proposes a worklog and posts it to Jira on confirm', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at(0));
    const calls: { method: string; url: string; body?: any }[] = [];
    vi.stubGlobal('fetch', jiraFetch(calls));

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ljt-e2e-'));
    fake.config = { siteUrl: 'https://team.atlassian.net', email: 'dev@example.com' };
    const state = new Map<string, unknown>();
    const context = {
      globalStorageUri: Uri.file(dir),
      extensionUri: Uri.file('/ext'),
      subscriptions: [] as { dispose(): unknown }[],
      globalState: { get: (k: string, d?: unknown) => (state.has(k) ? state.get(k) : d), update: async (k: string, v: unknown) => void state.set(k, v) },
      secrets: { get: async () => 'tok', store: async () => {}, delete: async () => {} },
    };
    subscriptions = context.subscriptions;
    await activate(context as never);
    await flush();

    // An hour of editing on feature/PAY-7-refunds, one edit a minute, plus a commit.
    for (let min = 1; min <= 60; min++) {
      vi.setSystemTime(at(min));
      fake.events.textChange.fire({ document: { uri: fake.activeDocUri }, contentChanges: [{}] });
      if (min === 30) {
        fake.repo.state.HEAD = { name: 'feature/PAY-7-refunds', commit: 'c2' };
        fake.repoChange.fire();
      }
      await flush();
    }
    // A long break in another app ends the session.
    fake.events.windowState.fire({ focused: false });
    fake.focused = false;
    await flush();

    await fake.commands.get('lazyJiraTimelog.openReview')!();
    fake.webview.toHost.fire({ type: 'ready' });
    await flush();
    await flush();

    const stateMsg = fake.webview.fromHost.find((m) => m.type === 'state');
    expect(stateMsg.setupMessage).toBeNull();
    expect(stateMsg.rows).toHaveLength(1);
    const row = stateMsg.rows[0];
    expect(row).toMatchObject({ sourceKey: 'PAY-7', targetKey: 'PAY-7', duration: '1h', comment: 'PAY-7 commit c2' });
    expect(fake.webview.fromHost).toContainEqual({ type: 'summary', key: 'PAY-7', summary: 'Refund flow', missing: false });
    expect(fake.webview.fromHost.find((m) => m.type === 'manual')?.text).toBe('You already logged 30m here that day');

    fake.webview.toHost.fire({ type: 'post', rows: [{ id: row.id, targetKey: 'PAY-7', duration: '1h 15m', comment: 'Refund endpoint', rawMs: row.rawMs }] });
    await flush();
    await flush();

    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toContain('/rest/api/3/issue/PAY-7/worklog');
    expect(post?.body.timeSpentSeconds).toBe(4500);
    expect(post?.body.started).toMatch(/^2026-10-13T09:00:00\.000/);
    expect(fake.webview.fromHost).toContainEqual({ type: 'rowDone', id: row.id, message: 'Logged 1h 15m to PAY-7' });

    const settled = (await fs.readFile(path.join(dir, 'settled.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(settled).toMatchObject([{ day: '2026-10-13', sourceKey: 'PAY-7', action: 'posted', worklogId: '900', postedSeconds: 4500 }]);

    // Reopening the review shows nothing left to log.
    fake.webview.fromHost = [];
    fake.webview.toHost.fire({ type: 'refresh' });
    await flush();
    expect(fake.webview.fromHost.find((m) => m.type === 'state').rows).toEqual([]);

    await fs.rm(dir, { recursive: true, force: true });
  });
});
