import type { Estimate } from './estimate';
/** What Jira says about a ticket; refreshed from Jira, never edited here. */
export interface TicketDetails {
  key: string;
  summary: string;
  status: string;
  /** Jira's status category key: "new", "indeterminate" or "done". */
  statusCategory: string;
  issueType: string;
  parentKey?: string;
  parentSummary?: string;
  /** The epic the ticket belongs to, found up the parent chain; an epic names itself. */
  epicKey?: string;
  epicSummary?: string;
  /** Epoch ms the issue was created in Jira. */
  created: number;
  /** The issue's own time tracking, when it has an estimate. */
  estimate?: Estimate;
}

/** A ticket on your list. */
export interface Ticket extends TicketDetails {
  flagged: boolean;
  /** Epoch ms it was added to the list. */
  addedAt: number;
}

export interface TicketList {
  /** In display order. */
  tickets: Ticket[];
  /** True once you dragged something; until then the list follows created date, newest first. */
  manualOrder: boolean;
}

/** A ticket with the sub-tickets on the list nested under it. */
export interface TicketNode {
  ticket: Ticket;
  children: TicketNode[];
  /** An epic that isn't on the list itself, or the "No epic" heading, shown only to group tickets. */
  placeholder?: true;
}

/** Key of the heading that gathers tickets outside any epic; never a Jira key. */
export const NO_EPIC = 'no-epic';

/** Most tickets the list keeps, so storage and the AI prompt stay small. */
export const MAX_TICKETS = 200;

export const EMPTY_LIST: TicketList = { tickets: [], manualOrder: false };

const newestFirst = (a: Ticket, b: Ticket) => b.created - a.created || a.key.localeCompare(b.key);

/**
 * Adds tickets, or refreshes their details when already listed. New tickets
 * slot in by created date, or go on top once you've arranged the list yourself.
 */
export function addTickets(list: TicketList, incoming: TicketDetails[], now: number): { list: TicketList; added: string[] } {
  const byKey = new Map(list.tickets.map((t) => [t.key, t]));
  const fresh: Ticket[] = [];
  for (const details of incoming) {
    const existing = byKey.get(details.key);
    if (existing) {
      byKey.set(details.key, { ...existing, ...details });
    } else if (!fresh.some((t) => t.key === details.key)) {
      fresh.push({ ...details, flagged: false, addedAt: now });
    }
  }
  const room = Math.max(0, MAX_TICKETS - list.tickets.length);
  const added = fresh.sort(newestFirst).slice(0, room);
  const kept = list.tickets.map((t) => byKey.get(t.key)!);
  const tickets = list.manualOrder ? [...added, ...kept] : [...kept, ...added].sort(newestFirst);
  return { list: { ...list, tickets }, added: added.map((t) => t.key) };
}

/** Updates details of listed tickets only; never adds any. */
export function refreshTickets(list: TicketList, details: TicketDetails[]): TicketList {
  const byKey = new Map(details.map((d) => [d.key, d]));
  const tickets = list.tickets.map((t) => (byKey.has(t.key) ? { ...t, ...byKey.get(t.key)! } : t));
  return { ...list, tickets: list.manualOrder ? tickets : tickets.sort(newestFirst) };
}

export function setFlag(list: TicketList, keys: string[], flagged: boolean): TicketList {
  const wanted = new Set(keys);
  return { ...list, tickets: list.tickets.map((t) => (wanted.has(t.key) ? { ...t, flagged } : t)) };
}

export function removeTickets(list: TicketList, keys: string[]): TicketList {
  const gone = new Set(keys);
  return { ...list, tickets: list.tickets.filter((t) => !gone.has(t.key)) };
}

/** Puts the list in the given key order. Keys left out keep their relative order at the end. */
export function reorderTickets(list: TicketList, keys: string[]): TicketList {
  const byKey = new Map(list.tickets.map((t) => [t.key, t]));
  const ordered = [...new Set(keys)].filter((k) => byKey.has(k)).map((k) => byKey.get(k)!);
  const rest = list.tickets.filter((t) => !ordered.includes(t));
  return { tickets: [...ordered, ...rest], manualOrder: true };
}

export function sortByCreated(list: TicketList): TicketList {
  return { tickets: [...list.tickets].sort(newestFirst), manualOrder: false };
}

/**
 * Groups tickets under their epic, in the place of the epic's first ticket on
 * the list. An epic that isn't on the list still heads its group. Tickets
 * outside any epic go last under a "No epic" heading, or stay ungrouped when
 * no ticket has an epic. Order within each group follows the list.
 */
export function groupTickets(tickets: Ticket[]): TicketNode[] {
  const groups = new Map<string, TicketNode>();
  const loose: TicketNode[] = [];
  for (const ticket of tickets) {
    if (!ticket.epicKey) {
      loose.push({ ticket, children: [] });
      continue;
    }
    let group = groups.get(ticket.epicKey);
    if (!group) {
      group = { ticket: heading(ticket.epicKey, ticket.epicSummary ?? ''), children: [], placeholder: true };
      groups.set(ticket.epicKey, group);
    }
    if (ticket.key === ticket.epicKey) {
      group.ticket = ticket;
      delete group.placeholder;
    } else {
      group.children.push({ ticket, children: [] });
    }
  }
  if (groups.size === 0) {
    return loose;
  }
  const roots = [...groups.values()];
  return loose.length > 0 ? [...roots, { ticket: heading(NO_EPIC, 'No epic'), children: loose, placeholder: true }] : roots;
}

function heading(key: string, summary: string): Ticket {
  return {
    key,
    summary,
    status: '',
    statusCategory: '',
    issueType: '',
    created: 0,
    flagged: false,
    addedAt: 0,
  };
}

/** Keys of listed tickets in the order the grouped list shows them, epics before their tickets. */
export function flattenKeys(nodes: TicketNode[]): string[] {
  return nodes.flatMap((n) => [...(n.placeholder ? [] : [n.ticket.key]), ...flattenKeys(n.children)]);
}

/** Tickets for AI matching: flagged first, then the rest, each in your list order. */
export function prioritized(list: TicketList): Ticket[] {
  const byKey = new Map(list.tickets.map((t) => [t.key, t]));
  const ordered = flattenKeys(groupTickets(list.tickets)).map((k) => byKey.get(k)!);
  return [...ordered.filter((t) => t.flagged), ...ordered.filter((t) => !t.flagged)];
}
