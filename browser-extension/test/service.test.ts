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

describe('Service.aiSuggest', () => {
  async function aiStore() {
    const store = await seeded();
    await store.saveSettings({ cursorApiKey: 'key_1' });
    const pr = '~pr51';
    for (let m = 60; m <= 100; m++) {
      await store.addHeartbeat({ t: base + m * MIN, repo: 'github.com', branch: pr, key: pr, signal: 'tick' });
    }
    await store.addNote({ t: base + 60 * MIN, repo: 'github.com', branch: pr, hash: 'github.com/acme/api/pull/51', subject: 'Fix payout CSV export (#51)' });
    return store;
  }

  function fakeApis(reply: string) {
    let prompt = '';
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/rest/api/3/search/jql')) {
        expect(JSON.parse(init?.body as string).jql).toMatch(/^assignee = currentUser\(\) AND statusCategory != Done/);
        return json({ issues: [{ key: 'PAY-8', fields: { summary: 'Payout reports for finance' } }] });
      }
      if (url.includes('/rest/api/3/issue/PAY-7')) return json({ key: 'PAY-7', fields: { summary: 'Refund flow' } });
      if (url.endsWith('/v1/agents') && init?.method === 'POST') {
        prompt = JSON.parse(init.body as string).prompt.text;
        return json({ agent: { id: 'bc-1' }, run: { id: 'run-1', status: 'FINISHED', result: reply } });
      }
      return json({});
    });
    return { fetchImpl, prompt: () => prompt };
  }

  it('sends the day to Cursor and keeps only matches to assigned issues', async () => {
    const store = await aiStore();
    const reply = '{"rows":[{"id":"PAY-7","comment":"Built refunds."},{"id":"~pr51","comment":"Fixed CSV export.","key":"PAY-8","reason":"payout export"}]}';
    const apis = fakeApis(reply);
    const service = new Service(store, apis.fetchImpl, () => base + 120 * MIN, async () => {});
    const day = (await service.drafts())[0].day;

    const { rows: suggestions } = await service.aiSuggest(day);
    expect(suggestions.map((s) => [s.id, s.key ?? null, s.comment])).toEqual([
      ['PAY-7', null, 'Built refunds.'],
      ['~pr51', 'PAY-8', 'Fixed CSV export.'],
    ]);
    expect(apis.prompt()).toContain('Fix payout CSV export (#51)');
    expect(apis.prompt()).toContain('"issue": null');
    expect(apis.prompt()).not.toContain('acme/api');
    expect((await store.aiState())?.status).toBe('done');
  });

  it('passes a day summary and the existing issues named in it', async () => {
    const store = await aiStore();
    await store.setProjectKeys(['PAY', 'OPS']);
    const reply = '{"rows":[],"added":[{"key":"OPS-3","minutes":60,"comment":"Rotated credentials."},{"key":"OPS-404","minutes":30,"comment":"Ghost."}]}';
    const apis = fakeApis(reply);
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/rest/api/3/issue/OPS-3')) return json({ key: 'OPS-3', fields: { summary: 'Rotate staging credentials' } });
      if (url.includes('/rest/api/3/issue/OPS-404')) return json({ errorMessages: ['nope'] }, 404);
      return apis.fetchImpl(url, init);
    });
    const service = new Service(store, fetchImpl, () => base + 120 * MIN, async () => {});
    const day = (await service.drafts())[0].day;

    const result = await service.aiSuggest(day, 'Rotated creds on ops-3 for 1h, then looked at OPS-404');
    expect(apis.prompt()).toContain('"personSummary": "Rotated creds on ops-3');
    expect(apis.prompt()).toContain('"key": "OPS-3"');
    expect(apis.prompt()).not.toContain('"key": "OPS-404"');
    expect(result.added).toEqual([
      { key: 'OPS-3', summary: 'Rotate staging credentials', minutes: 60, comment: 'Rotated credentials.' },
      { minutes: 30, comment: 'Ghost.' },
    ]);
    expect((await store.aiState())?.added).toHaveLength(2);

    await service.consumeAiEntry((await store.aiState())!.at, 0);
    expect((await store.aiState())?.consumed).toEqual([0]);
  });

  it('works from a summary alone on a day with nothing tracked', async () => {
    const store = await aiStore();
    const apis = fakeApis('{"added":[{"minutes":45,"comment":"Sprint planning."}]}');
    const service = new Service(store, apis.fetchImpl, () => base + 120 * MIN, async () => {});
    await expect(service.aiSuggest('2026-10-01')).rejects.toThrow(/nothing to fill in/);
    expect((await service.aiSuggest('2026-10-01', 'Sprint planning 45m')).added).toEqual([{ minutes: 45, comment: 'Sprint planning.' }]);
    expect(apis.prompt()).toContain('"rows": []');
  });

  it('records a failure so the popup can show it later', async () => {
    const store = await aiStore();
    const service = new Service(store, fakeApis('no json here').fetchImpl, () => base + 120 * MIN, async () => {});
    const day = (await service.drafts())[0].day;
    await expect(service.aiSuggest(day)).rejects.toThrow(/expected format/);
    expect(await store.aiState()).toMatchObject({ status: 'error' });
  });

  it('needs a Cursor key', async () => {
    const service = new Service(await seeded(), vi.fn(), () => base + 60 * MIN);
    const day = (await service.drafts())[0].day;
    await expect(service.aiSuggest(day)).rejects.toThrow(/Cursor API key/);
  });
});

describe('Service calendar', () => {
  const day = (h: number, m = 0) => new Date(2026, 9, 13, h, m).getTime();
  const started = (t: number) => {
    const d = new Date(t);
    const off = -d.getTimezoneOffset();
    const p = (n: number) => String(Math.abs(n)).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00.000${off >= 0 ? '+' : '-'}${p(Math.trunc(off / 60))}${p(off % 60)}`;
  };

  it('lists only your worklogs in the range, with plain-text comments', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${url}`);
      if (url.endsWith('/myself')) return json({ accountId: 'me', displayName: 'Alex' });
      if (url.endsWith('/search/jql')) {
        expect(JSON.parse(init?.body as string).jql).toMatch(/^worklogAuthor = currentUser\(\) AND worklogDate >= "2026-10-12"/);
        return json({ issues: [{ key: 'PAY-7', fields: { summary: 'Refunds' } }], isLast: true });
      }
      if (url.includes('/issue/PAY-7/worklog')) {
        return json({
          worklogs: [
            { id: '1', author: { accountId: 'me' }, started: started(day(9)), timeSpentSeconds: 3600, comment: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Built refunds' }] }] } },
            { id: '2', author: { accountId: 'someone' }, started: started(day(10)), timeSpentSeconds: 1800 },
            { id: '3', author: { accountId: 'me' }, started: started(day(23, 59) + 60_000), timeSpentSeconds: 900 },
          ],
        });
      }
      return json({}, 404);
    });
    const store = new Store(new FakeKv());
    await store.saveSettings({ siteUrl: 'https://team.atlassian.net' });
    const service = new Service(store, fetchImpl);
    const logs = await service.logged(day(0), day(0) + 86_400_000);
    expect(logs).toEqual([{ id: '1', key: 'PAY-7', summary: 'Refunds', started: day(9), seconds: 3600, comment: 'Built refunds' }]);
  });

  it('edits and deletes a worklog in Jira', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return init?.method === 'DELETE' ? new Response(null, { status: 204 }) : json({ id: '1' });
    });
    const store = new Store(new FakeKv());
    await store.saveSettings({ siteUrl: 'https://team.atlassian.net' });
    const service = new Service(store, fetchImpl);

    await expect(service.editWorklog({ key: 'PAY-7', id: '1', started: day(9), duration: 'soon', comment: '' })).rejects.toThrow(/duration/);
    await service.editWorklog({ key: 'PAY-7', id: '1', started: day(9, 30), duration: '1h 15m', comment: 'Refunds' });
    expect(calls[0].init?.method).toBe('PUT');
    expect(calls[0].url).toBe('https://team.atlassian.net/rest/api/3/issue/PAY-7/worklog/1?adjustEstimate=auto&notifyUsers=false');
    expect(JSON.parse(calls[0].init?.body as string)).toMatchObject({ timeSpentSeconds: 4500, started: started(day(9, 30)) });

    await service.deleteWorklog('PAY-7', '1');
    expect(calls[1].init?.method).toBe('DELETE');
    expect(calls[1].url).toBe('https://team.atlassian.net/rest/api/3/issue/PAY-7/worklog/1?adjustEstimate=auto&notifyUsers=false');
  });
});
