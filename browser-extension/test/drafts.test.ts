import { describe, expect, it } from 'vitest';
import { buildDrafts, roundToStep, totalUnloggedMs } from '../src/core/drafts';
import type { CommitRecord, Session, SettledEntry } from '../src/core/types';

const MIN = 60_000;
const at = (h: number, m = 0, day = 13) => new Date(2026, 9, day, h, m).getTime();
const session = (key: string | null, start: number, minutes: number, branch = key ? `feature/${key}` : 'main'): Session => ({
  key,
  repo: 'api',
  branch,
  start,
  end: start + minutes * MIN,
  activeMs: minutes * MIN,
});
const opts = { roundMinutes: 15, minSessionMinutes: 5 };

describe('roundToStep', () => {
  it('rounds to the nearest step with a one-step minimum', () => {
    expect(roundToStep(52 * MIN, 15)).toBe(45 * 60);
    expect(roundToStep(53 * MIN, 15)).toBe(60 * 60);
    expect(roundToStep(6 * MIN, 15)).toBe(15 * 60);
    expect(roundToStep(0, 15)).toBe(0);
  });
});

describe('buildDrafts', () => {
  it('groups by day and issue, drops short sessions, and rounds', () => {
    const drafts = buildDrafts(
      [session('PAY-1', at(9), 40), session('PAY-1', at(14), 22), session('PAY-1', at(16), 4), session('PAY-2', at(11), 30)],
      [],
      [],
      opts,
    );
    expect(drafts.map((d) => [d.sourceKey, d.rawMs / MIN, d.seconds / 60])).toEqual([
      ['PAY-1', 62, 60],
      ['PAY-2', 30, 30],
    ]);
    expect(drafts[0].started).toBe(at(9));
  });

  it('keeps unassigned time and lists newest day first', () => {
    const drafts = buildDrafts([session(null, at(9, 0, 12), 20), session('PAY-1', at(9), 20)], [], [], opts);
    expect(drafts.map((d) => [d.day, d.sourceKey])).toEqual([
      ['2026-10-13', 'PAY-1'],
      ['2026-10-12', ''],
    ]);
  });

  it('subtracts settled time and hides tiny leftovers', () => {
    const settled: SettledEntry[] = [{ day: '2026-10-13', sourceKey: 'PAY-1', rawMs: 40 * MIN, action: 'posted', at: 0 }];
    expect(buildDrafts([session('PAY-1', at(9), 42)], [], settled, opts)).toEqual([]);
    const later = buildDrafts([session('PAY-1', at(9), 40), session('PAY-1', at(15), 30)], [], settled, opts);
    expect(later.map((d) => d.rawMs / MIN)).toEqual([30]);
  });

  it('uses commit subjects from the same branch and day as the comment', () => {
    const commits: CommitRecord[] = [
      { t: at(10), repo: 'api', branch: 'feature/PAY-1', hash: 'a', subject: 'Add refund endpoint' },
      { t: at(11), repo: 'api', branch: 'feature/PAY-1', hash: 'b', subject: 'Add refund endpoint' },
      { t: at(12), repo: 'api', branch: 'feature/PAY-1', hash: 'c', subject: 'Validate amounts' },
      { t: at(12), repo: 'api', branch: 'other', hash: 'd', subject: 'Unrelated' },
      { t: at(12, 0, 12), repo: 'api', branch: 'feature/PAY-1', hash: 'e', subject: 'Yesterday' },
    ];
    const [draft] = buildDrafts([session('PAY-1', at(9), 60)], commits, [], opts);
    expect(draft.comment).toBe('Add refund endpoint\nValidate amounts');
  });

  it('falls back to the branch name when there are no commits', () => {
    const [draft] = buildDrafts([session('PAY-1', at(9), 60)], [], [], opts);
    expect(draft.comment).toBe('Worked on feature/PAY-1');
  });

  it('totals unlogged time per day', () => {
    const drafts = buildDrafts([session('PAY-1', at(9), 60), session('PAY-1', at(9, 0, 12), 30)], [], [], opts);
    expect(totalUnloggedMs(drafts) / MIN).toBe(90);
    expect(totalUnloggedMs(drafts, '2026-10-13') / MIN).toBe(60);
  });
});
