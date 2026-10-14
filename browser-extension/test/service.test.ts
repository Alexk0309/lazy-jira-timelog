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

  it('matches against your ticket list and remembers answers to its questions', async () => {
    const store = await aiStore();
    await store.updateTickets(() => ({
      manualOrder: false,
      tickets: [
        { key: 'OPS-12', summary: 'Payout CSV for ops', status: 'To Do', statusCategory: 'new', issueType: 'Story', created: 2, flagged: false, addedAt: 0 },
        { key: 'OPS-13', summary: 'CSV encoding bug', status: 'To Do', statusCategory: 'new', issueType: 'Bug', created: 1, flagged: true, addedAt: 0 },
      ],
    }));
    const reply = JSON.stringify({
      rows: [{ id: '~pr51', comment: 'Fixed CSV export.', key: 'OPS-12' }],
      questions: [{ for: '~pr51', question: 'Which CSV ticket?', options: ['OPS-12', 'OPS-13'] }],
    });
    const apis = fakeApis(reply);
    const service = new Service(store, apis.fetchImpl, () => base + 120 * MIN, async () => {});
    const day = (await service.drafts())[0].day;

    const result = await service.aiSuggest(day);
    expect(result.rows.find((r) => r.id === '~pr51')?.key).toBe('OPS-12');
    expect(result.questions.map((q) => q.options.map((o) => o.key))).toEqual([['OPS-12', 'OPS-13']]);
    // Flagged first, ahead of the newer unflagged ticket.
    expect(apis.prompt().indexOf('"key": "OPS-13"')).toBeLessThan(apis.prompt().indexOf('"key": "OPS-12"'));

    const at = (await store.aiState())!.at;
    await service.answerAiQuestion(at, 0, 'OPS-13');
    await service.answerAiQuestion(at, 5, 'OPS-12');
    expect((await store.aiState())?.answers).toEqual({ 0: 'OPS-13' });
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
        expect(JSON.parse(init?.body as string).fields).toEqual(['summary', 'timetracking']);
        return json({ issues: [{ key: 'PAY-7', fields: { summary: 'Refunds', timetracking: { originalEstimateSeconds: 7200, timeSpentSeconds: 3600 } } }], isLast: true });
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
    expect(logs).toEqual([
      { id: '1', key: 'PAY-7', summary: 'Refunds', started: day(9), seconds: 3600, comment: 'Built refunds', estimate: { original: 7200, remaining: 3600, spent: 3600 } },
    ]);
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

  it('moves a worklog to another issue by adding it there and deleting the original', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    let failDelete = false;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (init?.method === 'DELETE') {
        return failDelete && url.includes('/PAY-7/') ? json({ errorMessages: ['You cannot delete this worklog'] }, 403) : new Response(null, { status: 204 });
      }
      return json({ id: '2' }, 201);
    });
    const store = new Store(new FakeKv());
    await store.saveSettings({ siteUrl: 'https://team.atlassian.net' });
    await store.addSettled({ day: '2026-10-14', sourceKey: 'PAY-7', rawMs: 3600_000, action: 'posted', targetKey: 'PAY-7', worklogId: '1', postedSeconds: 3600, at: 0 });
    const service = new Service(store, fetchImpl);

    await expect(service.editWorklog({ key: 'PAY-7', id: '1', newKey: 'nope', started: day(9), duration: '1h', comment: '' })).rejects.toThrow(/issue/);
    expect(calls).toHaveLength(0);

    const moved = await service.editWorklog({ key: 'PAY-7', id: '1', newKey: 'ops-12', started: day(9), duration: '1h', comment: 'Rotated keys' });
    expect(moved).toEqual({ key: 'OPS-12', id: '2' });
    expect(calls.map((c) => `${c.init?.method} ${new URL(c.url).pathname}`)).toEqual(['POST /rest/api/3/issue/OPS-12/worklog', 'DELETE /rest/api/3/issue/PAY-7/worklog/1']);
    expect(JSON.parse(calls[0].init?.body as string)).toMatchObject({ timeSpentSeconds: 3600, started: started(day(9)) });
    expect(await store.settled()).toMatchObject([{ worklogId: '2', targetKey: 'OPS-12', sourceKey: 'PAY-7' }]);

    // Same issue: a plain edit.
    calls.length = 0;
    expect(await service.editWorklog({ key: 'OPS-12', id: '2', newKey: 'OPS-12', started: day(9), duration: '1h', comment: '' })).toEqual({ key: 'OPS-12', id: '2' });
    expect(calls.map((c) => c.init?.method)).toEqual(['PUT']);

    // When the original can't be deleted, the copy is taken back out.
    calls.length = 0;
    failDelete = true;
    await expect(service.editWorklog({ key: 'PAY-7', id: '5', newKey: 'OPS-12', started: day(9), duration: '1h', comment: '' })).rejects.toThrow(/stays there/);
    expect(calls.map((c) => `${c.init?.method} ${new URL(c.url).pathname}`)).toEqual([
      'POST /rest/api/3/issue/OPS-12/worklog',
      'DELETE /rest/api/3/issue/PAY-7/worklog/5',
      'DELETE /rest/api/3/issue/OPS-12/worklog/2',
    ]);
  });
});

describe('Service tickets', () => {
  const issue = (key: string, extra: Record<string, unknown> = {}) => ({
    key,
    fields: { summary: `Summary of ${key}`, status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } }, issuetype: { name: 'Story' }, created: '2026-10-01T09:00:00.000+0000', ...extra },
  });

  async function setup(handler: (url: string, init?: RequestInit) => Response | undefined) {
    const calls: { url: string; body?: { jql?: string } }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      return handler(url, init) ?? json({ errorMessages: ['not found'] }, 404);
    });
    const store = new Store(new FakeKv());
    await store.saveSettings({ siteUrl: 'https://team.atlassian.net' });
    await store.setProjectKeys(['PAY', 'OPS']);
    return { store, calls, service: new Service(store, fetchImpl, () => base) };
  }

  it('adds pasted keys in any case, with parent and status', async () => {
    const { service, calls } = await setup((url) =>
      url.endsWith('/search/jql') ? json({ issues: [issue('PAY-1'), issue('PAY-2', { parent: { key: 'PAY-1', fields: { summary: 'Epic' } } })], isLast: true }) : undefined,
    );
    const result = await service.addTickets('pay-1, https://team.atlassian.net/browse/PAY-2 and HR-9');
    expect(calls[0].body?.jql).toBe('key in (PAY-1, PAY-2)');
    expect(result.added.sort()).toEqual(['PAY-1', 'PAY-2']);
    expect(result.list.tickets.find((t) => t.key === 'PAY-2')).toMatchObject({ parentKey: 'PAY-1', parentSummary: 'Epic', status: 'In Progress', statusCategory: 'indeterminate' });
    expect(result.missing).toEqual([]);
  });

  it('reads titles and estimates for the review, marking unknown keys', async () => {
    const { service, calls } = await setup((url) => {
      if (url.endsWith('/search/jql')) return json({ errorMessages: ["An issue with key 'OPS-404' does not exist"] }, 400);
      if (url.includes('/issue/PAY-7?')) return json(issue('PAY-7', { timetracking: { originalEstimateSeconds: 14400, remainingEstimateSeconds: 10800, timeSpentSeconds: 3600 } }));
      if (url.includes('/issue/PAY-8?')) return json(issue('PAY-8', { timetracking: {} }));
      return undefined;
    });
    const info = await service.issues(['PAY-7', 'PAY-8', 'OPS-404', 'gh:org/repo#5', '']);
    expect(info).toEqual({
      'PAY-7': { summary: 'Summary of PAY-7', estimate: { original: 14400, remaining: 10800, spent: 3600 } },
      'PAY-8': { summary: 'Summary of PAY-8' },
      'OPS-404': null,
    });
    expect(calls[0].body).toMatchObject({ fields: expect.arrayContaining(['summary', 'timetracking']) });
  });

  it('falls back to one lookup per key when a key does not exist', async () => {
    const { service } = await setup((url) => {
      if (url.endsWith('/search/jql')) return json({ errorMessages: ["An issue with key 'OPS-404' does not exist"] }, 400);
      if (url.includes('/issue/OPS-1?')) return json(issue('OPS-1'));
      return undefined;
    });
    const result = await service.addTickets('OPS-1 OPS-404');
    expect(result.added).toEqual(['OPS-1']);
    expect(result.missing).toEqual(['OPS-404']);
  });

  it('explains when nothing pasted looks like a key', async () => {
    const { service, calls } = await setup(() => undefined);
    await expect(service.addTickets('hello" OR project = X')).rejects.toThrow(/No Jira keys/);
    expect(calls).toEqual([]);
  });

  it('fetches assigned tickets in one click and keeps flags across refreshes', async () => {
    const { service, calls } = await setup((url, init) => {
      const jql = JSON.parse((init?.body as string) ?? '{}').jql ?? '';
      if (jql.startsWith('assignee = currentUser()')) return json({ issues: [issue('PAY-7'), issue('PAY-8')], isLast: true });
      if (jql.startsWith('key in')) return json({ issues: [issue('PAY-7', { status: { name: 'Done', statusCategory: { key: 'done' } } }), issue('PAY-8')], isLast: true });
      return undefined;
    });
    expect((await service.addAssigned()).added).toEqual(['PAY-7', 'PAY-8']);
    expect((await service.addAssigned()).added).toEqual([]);
    await service.flagTickets(['PAY-8'], true);
    await service.reorderTickets(['PAY-8', 'PAY-7']);
    const list = await service.refreshTickets();
    expect(list.tickets.map((t) => [t.key, t.flagged, t.statusCategory])).toEqual([
      ['PAY-8', true, 'indeterminate'],
      ['PAY-7', false, 'done'],
    ]);
    expect(calls.at(-1)?.body?.jql).toBe('key in (PAY-8, PAY-7)');
    expect((await service.removeTickets(['PAY-7'])).tickets.map((t) => t.key)).toEqual(['PAY-8']);
  });
});
