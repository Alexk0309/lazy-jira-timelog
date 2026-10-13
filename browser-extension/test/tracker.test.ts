import { describe, expect, it } from 'vitest';
import { Store } from '../src/storage';
import { Tracker, type ActiveTab } from '../src/tracker';
import { FakeKv } from './fakeKv';

const MIN = 60_000;
const base = new Date(2026, 9, 13, 9, 0).getTime();

function setup() {
  const store = new Store(new FakeKv());
  let t = base;
  let tab: ActiveTab | null = { url: 'https://team.atlassian.net/browse/PAY-7', title: 'PAY-7 Refunds' };
  let idle: 'active' | 'idle' | 'locked' = 'active';
  const tracker = new Tracker({ store, now: () => t, activeTab: async () => tab, idleState: async () => idle });
  return {
    store,
    tracker,
    at: (min: number) => (t = base + min * MIN),
    setTab: (next: ActiveTab | null) => (tab = next),
    setIdle: (next: typeof idle) => (idle = next),
  };
}

describe('Tracker', () => {
  it('records heartbeats for issue tabs, throttled', async () => {
    const s = setup();
    await s.store.saveSettings({ siteUrl: 'https://team.atlassian.net' });
    await s.tracker.tick('tab');
    s.at(0.2);
    await s.tracker.tick('tick');
    s.at(1);
    await s.tracker.tick('tick');
    const hbs = await s.store.heartbeats(1, base);
    expect(hbs.map((h) => [h.key, h.repo, h.signal])).toEqual([
      ['PAY-7', 'team.atlassian.net', 'tab'],
      ['PAY-7', 'team.atlassian.net', 'tick'],
    ]);
  });

  it('writes one blur when leaving for an unrelated tab, then nothing', async () => {
    const s = setup();
    await s.tracker.tick('tab');
    s.at(3);
    s.setTab({ url: 'https://mail.example.com', title: 'Inbox' });
    expect(await s.tracker.tick('tab')).toBeNull();
    s.at(4);
    await s.tracker.tick('tick');
    const hbs = await s.store.heartbeats(1, base);
    expect(hbs.map((h) => h.signal)).toEqual(['tab', 'blur']);
  });

  it('stops when the machine is idle or the browser is unfocused', async () => {
    const s = setup();
    await s.tracker.tick('tab');
    s.at(1);
    s.setIdle('idle');
    await s.tracker.tick('idle');
    s.setIdle('active');
    s.setTab(null);
    s.at(2);
    await s.tracker.tick('focus');
    expect((await s.store.heartbeats(1, base)).map((h) => h.signal)).toEqual(['tab', 'blur']);
  });

  it('stores PR titles as notes for worklog comments', async () => {
    const s = setup();
    s.setTab({ url: 'https://github.com/acme/api/pull/42', title: 'PAY-7 Add refunds · Pull Request #42 · acme/api · GitHub' });
    await s.tracker.tick('tab');
    expect(await s.store.notes()).toMatchObject([{ subject: 'PAY-7 Add refunds (#42)', branch: 'PAY-7', repo: 'github.com' }]);
  });
});
