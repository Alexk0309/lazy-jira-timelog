import { describe, expect, it, vi } from 'vitest';
import { Service } from '../src/service';
import { Store } from '../src/storage';
import { FakeKv } from './fakeKv';

const MIN = 60_000;
const base = new Date(2026, 9, 13, 9, 0).getTime();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

async function seeded() {
  const store = new Store(new FakeKv());
  await store.saveSettings({ siteUrl: 'https://team.atlassian.net' });
  for (let m = 0; m <= 50; m++) {
    await store.addHeartbeat({ t: base + m * MIN, repo: 'team.atlassian.net', branch: 'PAY-7', key: 'PAY-7', signal: 'tick' });
  }
  return store;
}

describe('Service', () => {
  it('builds drafts from browser heartbeats', async () => {
    const service = new Service(await seeded(), vi.fn(), () => base + 60 * MIN);
    const state = await service.state();
    expect(state.drafts.map((d) => [d.sourceKey, d.seconds / 60, d.comment])).toEqual([['PAY-7', 45, 'Worked on PAY-7']]);
    expect(state.setupMessage).toBeNull();
  });

  it('asks for a site before anything else', async () => {
    const service = new Service(new Store(new FakeKv()), vi.fn());
    expect((await service.state()).setupMessage).toMatch(/Jira site/);
  });

  it('posts with the browser session by default and settles the time', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return json({ id: '77' }, 201);
    });
    const store = await seeded();
    const service = new Service(store, fetchMock, () => base + 60 * MIN);
    const [draft] = await service.drafts();
    await service.post({ day: draft.day, sourceKey: 'PAY-7', rawMs: draft.rawMs, targetKey: 'pay-7', duration: '1h', started: draft.started, comment: 'Refunds' });

    const { url, init } = calls[0];
    expect(url).toBe('https://team.atlassian.net/rest/api/3/issue/PAY-7/worklog?adjustEstimate=auto&notifyUsers=false');
    expect(init?.credentials).toBe('include');
    expect((init?.headers as Record<string, string>)['X-Atlassian-Token']).toBe('no-check');
    expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(JSON.parse(init?.body as string).timeSpentSeconds).toBe(3600);
    expect(await service.drafts()).toEqual([]);
  });

  it('uses Basic auth when a token is set', async () => {
    const fetchMock = vi.fn(async () => json({ accountId: 'a', displayName: 'Dev' }));
    const store = new Store(new FakeKv());
    await store.saveSettings({ siteUrl: 'https://team.atlassian.net', email: 'dev@x.com', apiToken: 'tok' });
    const client = await new Service(store, fetchMock).client();
    if (typeof client === 'string') throw new Error(client);
    await client.myself();
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa('dev@x.com:tok')}`);
    expect(init.credentials).toBe('omit');
  });

  it('rejects bad input before calling Jira', async () => {
    const fetchMock = vi.fn();
    const service = new Service(await seeded(), fetchMock, () => base + 60 * MIN);
    const input = { day: '2026-10-13', sourceKey: 'PAY-7', rawMs: 1, started: base, comment: '' };
    await expect(service.post({ ...input, targetKey: '', duration: '1h' })).rejects.toThrow(/issue/);
    await expect(service.post({ ...input, targetKey: 'PAY-7', duration: 'soon' })).rejects.toThrow(/duration/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('suggests issues touched today that have no tracked time', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/search/jql')) {
        expect(JSON.parse(init?.body as string).jql).toContain('status CHANGED BY currentUser()');
        return json({ issues: [{ key: 'PAY-7', fields: { summary: 'Refunds' } }, { key: 'OPS-2', fields: { summary: 'Rotate keys' } }] });
      }
      return json({}, 404);
    });
    const service = new Service(await seeded(), fetchMock, () => base + 60 * MIN);
    expect(await service.suggestions()).toEqual([{ key: 'OPS-2', summary: 'Rotate keys' }]);
  });

  it('reminds once after the reminder time', async () => {
    const store = await seeded();
    const at = { t: base + 60 * MIN };
    const service = new Service(store, vi.fn(), () => at.t);
    expect((await service.reminderDue()).due).toBe(false);
    at.t = new Date(2026, 9, 13, 17, 45).getTime();
    expect(await service.reminderDue()).toEqual({ due: true, todayMs: 45 * MIN });
    expect((await service.reminderDue()).due).toBe(false);
  });
});
