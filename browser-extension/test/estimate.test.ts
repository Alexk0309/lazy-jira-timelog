import { describe, expect, it } from 'vitest';
import { adjustEstimate, estimateProgress, toEstimate } from '../src/core/estimate';

const H = 3600;

describe('toEstimate', () => {
  it('has none without an original estimate', () => {
    expect(toEstimate(undefined)).toBeUndefined();
    expect(toEstimate({})).toBeUndefined();
    expect(toEstimate({ timeSpentSeconds: 2 * H })).toBeUndefined();
    expect(toEstimate({ originalEstimateSeconds: 0, remainingEstimateSeconds: H })).toBeUndefined();
  });

  it('reads Jira time tracking', () => {
    expect(toEstimate({ originalEstimateSeconds: 4 * H, remainingEstimateSeconds: 3 * H, timeSpentSeconds: 2 * H })).toEqual({
      original: 4 * H,
      remaining: 3 * H,
      spent: 2 * H,
    });
  });

  it('works out remaining time when Jira leaves it out', () => {
    expect(toEstimate({ originalEstimateSeconds: 4 * H, timeSpentSeconds: H })).toEqual({ original: 4 * H, remaining: 3 * H, spent: H });
    expect(toEstimate({ originalEstimateSeconds: 4 * H, timeSpentSeconds: 6 * H })?.remaining).toBe(0);
  });
});

describe('estimateProgress', () => {
  it('is hidden without an estimate', () => {
    expect(estimateProgress(undefined, H)).toBeNull();
  });

  it('fills like Jira: logged out of logged plus remaining', () => {
    const p = estimateProgress({ original: 4 * H, remaining: 3 * H, spent: H })!;
    expect(p.logged).toBe(0.25);
    expect(p.adding).toBe(0);
    expect(p.over).toBe(false);
    expect(p.label).toBe('1h of 4h');
  });

  it('shows time about to be logged coming off the remaining time', () => {
    const p = estimateProgress({ original: 4 * H, remaining: 3 * H, spent: H }, H)!;
    expect(p.logged).toBe(0.25);
    expect(p.adding).toBe(0.25);
    expect(p.over).toBe(false);
    expect(p.label).toBe('1h + 1h of 4h');
  });

  it('turns over once logged time passes the original estimate', () => {
    const p = estimateProgress({ original: 4 * H, remaining: H, spent: 3 * H }, 2 * H)!;
    expect(p.over).toBe(true);
    expect(p.logged + p.adding).toBe(1);
    expect(p.logged).toBeCloseTo(0.6);
  });

  it('handles an estimate with nothing logged yet', () => {
    expect(estimateProgress({ original: 2 * H, remaining: 2 * H, spent: 0 })).toMatchObject({ logged: 0, label: '0m of 2h' });
  });
});

describe('adjustEstimate', () => {
  it('moves time between spent and remaining as Jira does', () => {
    const e = { original: 4 * H, remaining: 2 * H, spent: 2 * H };
    expect(adjustEstimate(e, H)).toEqual({ original: 4 * H, remaining: H, spent: 3 * H });
    expect(adjustEstimate(e, -H)).toEqual({ original: 4 * H, remaining: 3 * H, spent: H });
    expect(adjustEstimate(e, 3 * H).remaining).toBe(0);
  });
});
