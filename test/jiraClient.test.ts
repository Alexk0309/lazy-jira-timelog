import { describe, expect, it, vi } from 'vitest';
import { JiraClient, JiraError, toAdf } from '../src/jira/client';

const creds = { siteUrl: 'https://team.atlassian.net/', email: 'dev@example.com', apiToken: 'tok' };
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('JiraClient', () => {
  it('posts a worklog with basic auth, Jira started format and an ADF comment', async () => {
    const fetchMock = vi.fn(async () => json(201, { id: '10042' }));
    const client = new JiraClient(creds, fetchMock);
    const started = new Date(2026, 9, 13, 9, 0).getTime();
    const id = await client.addWorklog('PAY-1', { started, seconds: 3600, comment: 'Add refund endpoint\nValidate amounts' });

    expect(id).toBe('10042');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://team.atlassian.net/rest/api/3/issue/PAY-1/worklog?adjustEstimate=auto&notifyUsers=false');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('dev@example.com:tok').toString('base64')}`,
    );
    const body = JSON.parse(init.body as string);
    expect(body.timeSpentSeconds).toBe(3600);
    expect(body.started).toMatch(/^2026-10-13T09:00:00\.000[+-]\d{4}$/);
    expect(body.comment).toEqual(toAdf('Add refund endpoint\nValidate amounts'));
  });

  it('explains auth failures', async () => {
    const client = new JiraClient(creds, async () => json(401, {}));
    await expect(client.myself()).rejects.toThrow(/API token/);
  });

  it('returns null for a missing issue and surfaces other errors', async () => {
    const missing = new JiraClient(creds, async () => json(404, { errorMessages: ['Issue does not exist'] }));
    expect(await missing.issue('PAY-404')).toBeNull();
    const forbidden = new JiraClient(creds, async () => json(403, { errorMessages: ['No permission'] }));
    await expect(forbidden.issue('PAY-1')).rejects.toBeInstanceOf(JiraError);
  });

  it('dedupes issue picker results', async () => {
    const client = new JiraClient(creds, async () =>
      json(200, {
        sections: [
          { issues: [{ key: 'PAY-1', summaryText: 'Refunds' }] },
          { issues: [{ key: 'PAY-1', summaryText: 'Refunds' }, { key: 'PAY-2', summaryText: 'Payouts' }] },
        ],
      }),
    );
    expect(await client.searchIssues('pay')).toEqual([
      { key: 'PAY-1', summary: 'Refunds' },
      { key: 'PAY-2', summary: 'Payouts' },
    ]);
  });

  it('pages through project keys', async () => {
    const pages = [
      { values: [{ key: 'PAY' }, { key: 'OPS' }], isLast: false },
      { values: [{ key: 'WEB' }], isLast: true },
    ];
    const client = new JiraClient(creds, async () => json(200, pages.shift()));
    expect(await client.projectKeys()).toEqual(['PAY', 'OPS', 'WEB']);
  });

  it('rejects non-https site URLs', () => {
    expect(() => new JiraClient({ ...creds, siteUrl: 'http://team.atlassian.net' })).toThrow(/https/);
  });
});
