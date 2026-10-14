import { describe, expect, it } from 'vitest';
import {
  addTickets,
  EMPTY_LIST,
  flattenKeys,
  groupTickets,
  prioritized,
  refreshTickets,
  reorderTickets,
  setFlag,
  sortByCreated,
  type TicketDetails,
} from '../src/core/tickets';

const day = (d: number) => new Date(2026, 9, d).getTime();
const t = (key: string, created: number, parentKey?: string): TicketDetails => ({
  key,
  summary: `Summary of ${key}`,
  status: 'To Do',
  statusCategory: 'new',
  issueType: parentKey ? 'Sub-task' : 'Story',
  created,
  ...(parentKey ? { parentKey, parentSummary: `Summary of ${parentKey}` } : {}),
});

describe('ticket list', () => {
  it('keeps newest-created first until you arrange it', () => {
    let { list, added } = addTickets(EMPTY_LIST, [t('PAY-1', day(1)), t('PAY-3', day(3))], 0);
    expect(added).toEqual(['PAY-3', 'PAY-1']);
    ({ list } = addTickets(list, [t('PAY-2', day(2)), t('PAY-1', day(1))], 0));
    expect(list.tickets.map((x) => x.key)).toEqual(['PAY-3', 'PAY-2', 'PAY-1']);
  });

  it('puts new tickets on top once you dragged, and resets to created date', () => {
    let { list } = addTickets(EMPTY_LIST, [t('PAY-1', day(1)), t('PAY-3', day(3))], 0);
    list = reorderTickets(list, ['PAY-1', 'PAY-3']);
    expect(list.manualOrder).toBe(true);
    ({ list } = addTickets(list, [t('PAY-2', day(2))], 0));
    expect(list.tickets.map((x) => x.key)).toEqual(['PAY-2', 'PAY-1', 'PAY-3']);
    list = sortByCreated(list);
    expect([list.manualOrder, list.tickets.map((x) => x.key)]).toEqual([false, ['PAY-3', 'PAY-2', 'PAY-1']]);
  });

  it('keeps your flag and order when Jira details change', () => {
    let { list } = addTickets(EMPTY_LIST, [t('PAY-1', day(1)), t('PAY-2', day(2))], 0);
    list = setFlag(reorderTickets(list, ['PAY-1', 'PAY-2']), ['PAY-2'], true);
    list = refreshTickets(list, [{ ...t('PAY-2', day(2)), status: 'Done', statusCategory: 'done' }, t('NEW-1', day(5))]);
    expect(list.tickets.map((x) => [x.key, x.flagged, x.status])).toEqual([
      ['PAY-1', false, 'To Do'],
      ['PAY-2', true, 'Done'],
    ]);
  });

  it('nests sub-tickets under parents on the list, at any depth', () => {
    const { list } = addTickets(
      EMPTY_LIST,
      [t('PAY-1', day(1)), t('PAY-2', day(2), 'PAY-1'), t('PAY-3', day(3), 'PAY-2'), t('PAY-4', day(4), 'OTHER-1')],
      0,
    );
    const tree = groupTickets(list.tickets);
    expect(tree.map((n) => n.ticket.key)).toEqual(['PAY-4', 'PAY-1']);
    expect(tree[1].children[0].children[0].ticket.key).toBe('PAY-3');
    expect(flattenKeys(tree)).toEqual(['PAY-4', 'PAY-1', 'PAY-2', 'PAY-3']);
  });

  it('survives a parent loop', () => {
    const { list } = addTickets(EMPTY_LIST, [t('A-1', day(1), 'A-2'), t('A-2', day(2), 'A-1')], 0);
    expect(flattenKeys(groupTickets(list.tickets)).sort()).toEqual(['A-1', 'A-2']);
  });

  it('gives AI the flagged tickets first, then the rest in list order', () => {
    let { list } = addTickets(EMPTY_LIST, [t('PAY-1', day(1)), t('PAY-2', day(2)), t('PAY-3', day(3))], 0);
    list = setFlag(list, ['PAY-1'], true);
    expect(prioritized(list).map((x) => x.key)).toEqual(['PAY-1', 'PAY-3', 'PAY-2']);
  });
});
