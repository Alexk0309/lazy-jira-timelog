import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ljt-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const day = (offset: number) => {
  const d = new Date(2026, 9, 13, 10);
  d.setDate(d.getDate() + offset);
  return d.getTime();
};

describe('Store', () => {
  it('appends and reads heartbeats per day', async () => {
    const store = new Store(dir);
    await store.init();
    await store.addHeartbeat({ t: day(0), repo: 'api', branch: 'b', key: 'PAY-1', signal: 'edit' });
    await store.addHeartbeat({ t: day(-1), repo: 'api', branch: 'b', key: 'PAY-1', signal: 'edit' });
    await store.addHeartbeat({ t: day(-5), repo: 'api', branch: 'b', key: 'PAY-1', signal: 'edit' });
    expect(await store.heartbeats(2, day(0))).toHaveLength(2);
    expect(await store.heartbeats(14, day(0))).toHaveLength(3);
  });

  it('skips torn lines', async () => {
    const store = new Store(dir);
    await store.init();
    await store.addSettled({ day: '2026-10-13', sourceKey: 'PAY-1', rawMs: 1, action: 'posted', at: 1 });
    await fs.appendFile(path.join(dir, 'settled.jsonl'), '{"day":"2026-10');
    expect(await store.settled()).toHaveLength(1);
  });

  it('prunes old data', async () => {
    const store = new Store(dir);
    await store.init();
    await store.addHeartbeat({ t: day(-40), repo: 'api', branch: 'b', key: null, signal: 'edit' });
    await store.addHeartbeat({ t: day(-1), repo: 'api', branch: 'b', key: null, signal: 'edit' });
    await store.addCommit({ t: day(-40), repo: 'api', branch: 'b', hash: 'old', subject: 'x' });
    await store.addCommit({ t: day(-1), repo: 'api', branch: 'b', hash: 'new', subject: 'y' });
    await store.prune(30, day(0));
    expect(await fs.readdir(path.join(dir, 'heartbeats'))).toHaveLength(1);
    expect((await store.commits()).map((c) => c.hash)).toEqual(['new']);
  });
});
