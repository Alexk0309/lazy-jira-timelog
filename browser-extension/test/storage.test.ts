import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, Store } from '../src/storage';
import { FakeKv } from './fakeKv';

const day = (offset: number) => new Date(2026, 9, 13 + offset, 10).getTime();

describe('Store', () => {
  it('merges settings with defaults', async () => {
    const store = new Store(new FakeKv());
    expect(await store.settings()).toEqual(DEFAULT_SETTINGS);
    await store.saveSettings({ siteUrl: 'https://x.atlassian.net' });
    expect((await store.settings()).siteUrl).toBe('https://x.atlassian.net');
    expect((await store.settings()).roundMinutes).toBe(15);
  });

  it('keeps every heartbeat when writes overlap', async () => {
    const store = new Store(new FakeKv());
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.addHeartbeat({ t: day(0) + i, repo: 'h', branch: null, key: 'PAY-1', signal: 'tick' })),
    );
    expect(await store.heartbeats(1, day(0))).toHaveLength(20);
  });

  it('dedupes notes per day and prunes old data', async () => {
    const kv = new FakeKv();
    const store = new Store(kv);
    const note = { t: day(0), repo: 'github.com', branch: 'PAY-1', hash: 'pr1', subject: 'x' };
    await store.addNote(note);
    await store.addNote({ ...note, t: day(0) + 1000 });
    expect(await store.notes()).toHaveLength(1);

    await store.addHeartbeat({ t: day(-40), repo: 'h', branch: null, key: null, signal: 'tick' });
    await store.addHeartbeat({ t: day(-1), repo: 'h', branch: null, key: null, signal: 'tick' });
    await store.addSettled({ day: '2026-09-01', sourceKey: 'PAY-1', rawMs: 1, action: 'posted', at: 0 });
    await store.prune(30, day(0));
    expect(Object.keys(kv.data).filter((k) => k.startsWith('hb:'))).toHaveLength(1);
    expect(await store.settled()).toEqual([]);
  });
});
