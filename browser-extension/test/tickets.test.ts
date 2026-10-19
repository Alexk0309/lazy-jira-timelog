import { describe, expect, it } from 'vitest';
import {
  addTickets,
  EMPTY_LIST,
  flattenKeys,
  groupTickets,
  NO_EPIC,
  prioritized,
  refreshTickets,
  reorderTickets,
  setFlag,
  sortByCreated,
  type TicketDetails,
} from '../src/core/tickets';

const day = (d: number) => new Date(2026, 9, d).getTime();
const t = (key: string, created: number, parentKey?: string, epicKey?: string): TicketDetails => ({
  key,
  summary: `Summary of ${key}`,
  status: 'To Do',
  statusCategory: 'new',
  issueType: parentKey ? 'Sub-task' : 'Story',
  created,
  ...(parentKey ? { parentKey, parentSummary: `Summary of ${parentKey}` } : {}),
  ...(epicKey ? { epicKey, epicSummary: `Summary of ${epicKey}` } : {}),
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

  it('leaves the list ungrouped when no ticket has an epic', () => {
    const { list } = addTickets(EMPTY_LIST, [t('PAY-1', day(1)), t('PAY-2', day(2), 'PAY-1')], 0);
    const tree = groupTickets(list.tickets);
    expect(tree.map((n) => [n.ticket.key, n.children.length])).toEqual([
      ['PAY-2', 0],
      ['PAY-1', 0],
    ]);
  });

  it('groups stories and sub-tasks under their epic, with the rest under "No epic" last', () => {
    const { list } = addTickets(
      EMPTY_LIST,
      [
        t('PAY-1', day(1), undefined, 'PAY-1'),
        t('PAY-2', day(2), 'PAY-1', 'PAY-1'),
        t('PAY-3', day(3), 'PAY-2', 'PAY-1'),
        t('OPS-4', day(4), 'OPS-2'),
        t('OPS-5', day(5), 'OPS-3', 'OPS-1'),
      ],
      0,
    );
    const tree = groupTickets(list.tickets);
    expect(tree.map((n) => [n.ticket.key, !!n.placeholder])).toEqual([
      ['OPS-1', true],
      ['PAY-1', false],
      [NO_EPIC, true],
    ]);
    expect(tree[0].ticket.summary).toBe('Summary of OPS-1');
    expect(tree[1].children.map((n) => n.ticket.key)).toEqual(['PAY-3', 'PAY-2']);
    expect(tree[2].children.map((n) => n.ticket.key)).toEqual(['OPS-4']);
    expect(flattenKeys(tree)).toEqual(['OPS-5', 'PAY-1', 'PAY-3', 'PAY-2', 'OPS-4']);
  });

  it('gives AI the flagged tickets first, then the rest in list order', () => {
    let { list } = addTickets(EMPTY_LIST, [t('PAY-1', day(1)), t('PAY-2', day(2)), t('PAY-3', day(3))], 0);
    list = setFlag(list, ['PAY-1'], true);
    expect(prioritized(list).map((x) => x.key)).toEqual(['PAY-1', 'PAY-3', 'PAY-2']);
  });
});
