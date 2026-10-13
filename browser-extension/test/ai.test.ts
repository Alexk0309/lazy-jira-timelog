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
    expect(parseSuggestions(reply, input)).toEqual([
      { id: 'PAY-7', comment: 'Added card refunds.' },
      { id: '~abc', comment: 'Fixed the payout CSV export.', key: 'PAY-8', reason: 'PR is about payout reports', summary: 'Payout reports for finance' },
    ]);
  });

  it('never suggests an issue that is not assigned to you', () => {
    const reply = '{"rows":[{"id":"~abc","comment":"Fixed export.","key":"OPS-99","reason":"guess"}]}';
    expect(parseSuggestions(reply, input)).toEqual([{ id: '~abc', comment: 'Fixed export.' }]);
  });

  it('never reassigns a row that already has an issue', () => {
    const reply = '{"rows":[{"id":"PAY-7","key":"PAY-8"}]}';
    expect(parseSuggestions(reply, input)).toEqual([]);
  });

  it('ignores unknown and duplicate rows and tidies long comments', () => {
    const long = 'x'.repeat(500);
    const reply = JSON.stringify({ rows: [{ id: 'NOPE-1', comment: 'a' }, { id: 'PAY-7', comment: `  ${long}\n` }, { id: 'PAY-7', comment: 'again' }] });
    const [only, ...rest] = parseSuggestions(reply, input);
    expect(rest).toEqual([]);
    expect(only.comment).toHaveLength(300);
    expect(only.comment?.endsWith('…')).toBe(true);
  });

  it('explains a reply that is not JSON', () => {
    expect(() => parseSuggestions('Sorry, I cannot help.', input)).toThrow(/expected format/);
  });
});
