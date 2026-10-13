import { describe, expect, it } from 'vitest';
import { extractIssueKey, resolveIssueKey } from '../src/core/issueKey';
import type { CommitRecord } from '../src/core/types';

describe('extractIssueKey', () => {
  it('finds an upper-case key in a branch name', () => {
    expect(extractIssueKey('feature/PAY-142-refund-flow')).toBe('PAY-142');
    expect(extractIssueKey('PAY-142')).toBe('PAY-142');
    expect(extractIssueKey('bugfix/AB2-7_crash')).toBe('AB2-7');
  });

  it('ignores lower-case look-alikes unless project keys are known', () => {
    expect(extractIssueKey('fix-42-login')).toBeNull();
    expect(extractIssueKey('release-2')).toBeNull();
    expect(extractIssueKey('feature/pay-142-refunds', ['PAY', 'OPS'])).toBe('PAY-142');
    expect(extractIssueKey('fix-42-login', ['PAY', 'OPS'])).toBeNull();
  });

  it('restricts to known projects when given', () => {
    expect(extractIssueKey('UTF-8 handling for PAY-3', ['PAY'])).toBe('PAY-3');
    expect(extractIssueKey('ABC-1', ['PAY'])).toBeNull();
  });

  it('skips well-known non-keys and partial matches', () => {
    expect(extractIssueKey('UTF-8')).toBeNull();
    expect(extractIssueKey('XPAY-12a')).toBeNull();
    expect(extractIssueKey('PAY-0')).toBeNull();
    expect(extractIssueKey('main')).toBeNull();
    expect(extractIssueKey(null)).toBeNull();
  });
});

describe('resolveIssueKey', () => {
  const commits: CommitRecord[] = [
    { t: 1, repo: 'api', branch: 'spike', hash: 'a', subject: 'PAY-9 first try' },
    { t: 2, repo: 'api', branch: 'spike', hash: 'b', subject: 'PAY-10 better idea' },
    { t: 3, repo: 'api', branch: 'spike', hash: 'c', subject: 'wip' },
    { t: 4, repo: 'web', branch: 'spike', hash: 'd', subject: 'WEB-1 other repo' },
  ];

  it('prefers the branch name', () => {
    expect(resolveIssueKey({ repo: 'api', branch: 'OPS-1-x', commits, defaultIssue: 'OPS-99' })).toBe('OPS-1');
  });

  it('falls back to the latest keyed commit on the same repo and branch', () => {
    expect(resolveIssueKey({ repo: 'api', branch: 'spike', commits, defaultIssue: 'OPS-99' })).toBe('PAY-10');
  });

  it('falls back to the repo default, then Unassigned', () => {
    expect(resolveIssueKey({ repo: 'api', branch: 'main', commits, defaultIssue: 'ops-99' })).toBe('OPS-99');
    expect(resolveIssueKey({ repo: 'api', branch: 'main', commits, defaultIssue: '' })).toBeNull();
    expect(resolveIssueKey({ repo: 'api', branch: null, commits, defaultIssue: '' })).toBeNull();
  });
});
