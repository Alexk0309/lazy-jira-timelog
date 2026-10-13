import { describe, expect, it } from 'vitest';
import { classifyTab, cleanTitle, isUnassignedKey, unassignedKey } from '../src/classify';

const ctx = { jiraHost: 'team.atlassian.net', projectKeys: ['PAY', 'OPS'] };

describe('classifyTab', () => {
  it('reads the issue from Jira issue and board URLs', () => {
    expect(classifyTab('https://team.atlassian.net/browse/PAY-7', 'whatever', ctx)).toEqual({ key: 'PAY-7', source: 'team.atlassian.net', kind: 'issue' });
    expect(classifyTab('https://team.atlassian.net/jira/software/projects/PAY/boards/1?selectedIssue=PAY-9', '', ctx)?.key).toBe('PAY-9');
  });

  it('ignores Jira pages that are not about one issue', () => {
    expect(classifyTab('https://team.atlassian.net/jira/your-work', 'Your work', ctx)).toBeNull();
  });

  it('treats Confluence pages like any other page', () => {
    expect(classifyTab('https://team.atlassian.net/wiki/spaces/ENG/pages/1', 'PAY-7 design notes - Confluence', ctx)?.kind).toBe('page');
    expect(classifyTab('https://team.atlassian.net/wiki/spaces/ENG/pages/2', 'Team handbook', ctx)).toBeNull();
  });

  it('labels pull requests with a key in the title', () => {
    const work = classifyTab('https://github.com/acme/api/pull/42/files', 'PAY-7 Add refunds by dev · Pull Request #42 · acme/api · GitHub', ctx);
    expect(work).toEqual({
      key: 'PAY-7',
      source: 'github.com',
      kind: 'pull-request',
      label: 'PAY-7 Add refunds (#42)',
      labelId: 'github.com/acme/api/pull/42',
    });
  });

  it('falls back to a lower-case key in the branch path for known projects', () => {
    expect(classifyTab('https://github.com/acme/api/tree/feature/pay-12-refunds', 'acme/api at feature/pay-12-refunds', ctx)?.key).toBe('PAY-12');
  });

  it('keeps pull requests without a key as unassigned work under the PR title', () => {
    const work = classifyTab('https://gitlab.com/acme/api/-/merge_requests/3', 'Draft: fix login (!3) · Merge requests · acme / api · GitLab', ctx);
    expect(work).toMatchObject({ source: 'gitlab.com', kind: 'pull-request', label: 'Draft: fix login (!3)' });
    expect(isUnassignedKey(work!.key)).toBe(true);
    expect(work!.key).toBe(unassignedKey('gitlab.com/acme/api/-/merge_requests/3'));
    // The bucket is stable per PR and never contains the address.
    expect(classifyTab('https://gitlab.com/acme/api/-/merge_requests/3/diffs', 'x', ctx)?.key).toBe(work!.key);
    expect(work!.key).not.toContain('acme');
    expect(classifyTab('https://github.com/acme/api/tree/main', 'acme/api', ctx)).toBeNull();
  });

  it('only counts other pages when a known key is visible', () => {
    expect(classifyTab('https://www.figma.com/design/abc/OPS-3-new-onboarding', 'Onboarding – Figma', ctx)?.key).toBe('OPS-3');
    expect(classifyTab('https://news.example.com/', 'fix-42 and release-2', ctx)).toBeNull();
  });

  it('rejects non-web URLs', () => {
    expect(classifyTab('chrome://extensions', 'Extensions', ctx)).toBeNull();
    expect(classifyTab(undefined, undefined, ctx)).toBeNull();
  });
});

describe('cleanTitle', () => {
  it('shortens GitHub and GitLab titles', () => {
    expect(cleanTitle('Fix login · Pull Request #9 · acme/web · GitHub')).toBe('Fix login (#9)');
    expect(cleanTitle('PAY-1 refunds (!12) · Merge requests · acme / api · GitLab')).toBe('PAY-1 refunds (!12)');
  });
});
