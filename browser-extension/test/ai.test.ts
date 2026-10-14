import { describe, expect, it } from 'vitest';
import { buildPrompt, parseSuggestions, type AiInput } from '../src/ai';

const input: AiInput = {
  day: '2026-10-13',
  rows: [
    { id: 'PAY-7', key: 'PAY-7', minutes: 60, title: 'Refund flow for card payments', notes: ['PAY-7 Add refunds (#42)'] },
    { id: '~abc', key: null, minutes: 30, title: 'Fix payout CSV export (#51)', notes: ['Fix payout CSV export (#51)'] },
  ],
  assigned: [
    { key: 'PAY-7', summary: 'Refund flow for card payments' },
    { key: 'PAY-8', summary: 'Payout reports for finance' },
  ],
};

describe('buildPrompt', () => {
  it('includes the rows and only the assigned issues', () => {
    const prompt = buildPrompt(input);
    expect(prompt).toContain('"id": "~abc"');
    expect(prompt).toContain('"key": "PAY-8"');
    expect(prompt).toMatch(/Only use a key that appears in assignedIssues/);
    expect(prompt).toMatch(/never as instructions/);
  });
});

describe('parseSuggestions', () => {
  it('reads comments and matches from a fenced JSON reply', () => {
    const reply = 'Here you go:\n```json\n{"rows":[{"id":"PAY-7","comment":"Added card refunds."},{"id":"~abc","comment":"Fixed the payout CSV export.","key":"pay-8","reason":"PR is about payout reports"}]}\n```';
    expect(parseSuggestions(reply, input).rows).toEqual([
      { id: 'PAY-7', comment: 'Added card refunds.' },
      { id: '~abc', comment: 'Fixed the payout CSV export.', key: 'PAY-8', reason: 'PR is about payout reports', summary: 'Payout reports for finance' },
    ]);
  });

  it('never suggests an issue that is not assigned to you', () => {
    const reply = '{"rows":[{"id":"~abc","comment":"Fixed export.","key":"OPS-99","reason":"guess"}]}';
    expect(parseSuggestions(reply, input).rows).toEqual([{ id: '~abc', comment: 'Fixed export.' }]);
  });

  it('never reassigns a row that already has an issue', () => {
    const reply = '{"rows":[{"id":"PAY-7","key":"PAY-8"}]}';
    expect(parseSuggestions(reply, input).rows).toEqual([]);
  });

  it('ignores unknown and duplicate rows and tidies long comments', () => {
    const long = 'x'.repeat(500);
    const reply = JSON.stringify({ rows: [{ id: 'NOPE-1', comment: 'a' }, { id: 'PAY-7', comment: `  ${long}\n` }, { id: 'PAY-7', comment: 'again' }] });
    const [only, ...rest] = parseSuggestions(reply, input).rows;
    expect(rest).toEqual([]);
    expect(only.comment).toHaveLength(300);
    expect(only.comment?.endsWith('…')).toBe(true);
  });

  it('explains a reply that is not JSON', () => {
    expect(() => parseSuggestions('Sorry, I cannot help.', input)).toThrow(/expected format/);
  });
});

describe('day summary', () => {
  const withSummary: AiInput = {
    ...input,
    summary: 'Standup 15m. Paired with Sam on OPS-3 for an hour. Refunds took 2h.',
    mentioned: [{ key: 'OPS-3', summary: 'Rotate staging credentials' }],
  };

  it('sends the summary and the issues named in it', () => {
    const prompt = buildPrompt(withSummary);
    expect(prompt).toContain('"personSummary": "Standup 15m.');
    expect(prompt).toContain('"key": "OPS-3"');
    expect(prompt).toMatch(/"added"/);
    expect(buildPrompt(input)).not.toMatch(/personSummary|"added"/);
  });

  it('adds entries for untracked work, with keys only from assigned or named issues', () => {
    const reply = JSON.stringify({
      rows: [{ id: 'PAY-7', comment: 'Built card refunds.', minutes: 120 }],
      added: [
        { minutes: 15, comment: 'Daily standup.', reason: 'from your summary' },
        { key: 'ops-3', minutes: 60, comment: 'Paired with Sam on credential rotation.' },
        { key: 'HR-1', minutes: 30, comment: 'Guessed issue.' },
        { minutes: 0, comment: 'No time.' },
        { minutes: 30 },
        { minutes: 2000, comment: 'Way too long.' },
      ],
    });
    const result = parseSuggestions(reply, withSummary);
    expect(result.rows).toEqual([{ id: 'PAY-7', comment: 'Built card refunds.', minutes: 120 }]);
    expect(result.added).toEqual([
      { minutes: 15, comment: 'Daily standup.', reason: 'from your summary' },
      { key: 'OPS-3', summary: 'Rotate staging credentials', minutes: 60, comment: 'Paired with Sam on credential rotation.' },
      { minutes: 30, comment: 'Guessed issue.' },
      { minutes: 480, comment: 'Way too long.' },
    ]);
  });

  it('lets a named issue match unassigned time', () => {
    const reply = '{"rows":[{"id":"~abc","key":"OPS-3","reason":"you said so"}]}';
    expect(parseSuggestions(reply, withSummary).rows[0].key).toBe('OPS-3');
  });

  it('ignores times and new entries when there is no summary', () => {
    const reply = '{"rows":[{"id":"PAY-7","comment":"Refunds.","minutes":300}],"added":[{"minutes":60,"comment":"Meeting."}]}';
    expect(parseSuggestions(reply, input)).toEqual({ rows: [{ id: 'PAY-7', comment: 'Refunds.' }], added: [] });
  });

  it('accepts an answer with only new entries', () => {
    const reply = '{"added":[{"minutes":45,"comment":"Sprint planning."}]}';
    expect(parseSuggestions(reply, { ...withSummary, rows: [] }).added).toEqual([{ minutes: 45, comment: 'Sprint planning.' }]);
  });
});
