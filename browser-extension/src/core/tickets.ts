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
  /** Epoch ms the issue was created in Jira. */
  created: number;
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
}

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
 * Nests each ticket under its parent when the parent is on the list too, at
 * any depth (epic, story, sub-task). Order within each level follows the list.
 */
export function groupTickets(tickets: Ticket[]): TicketNode[] {
  const keys = new Set(tickets.map((t) => t.key));
  const nodes = new Map(tickets.map((t) => [t.key, { ticket: t, children: [] as TicketNode[] }]));
  const roots: TicketNode[] = [];
  for (const ticket of tickets) {
    const parent = ticket.parentKey && keys.has(ticket.parentKey) && !isAncestor(ticket.key, ticket.parentKey, tickets) ? ticket.parentKey : null;
    (parent ? nodes.get(parent)!.children : roots).push(nodes.get(ticket.key)!);
  }
  return roots;
}

/** True when `key` sits somewhere above `start` in the parent chain, which would make a loop. */
function isAncestor(key: string, start: string, tickets: Ticket[]): boolean {
  const parentOf = new Map(tickets.map((t) => [t.key, t.parentKey]));
  const seen = new Set<string>();
  for (let at: string | undefined = start; at && !seen.has(at); at = parentOf.get(at)) {
    if (at === key) {
      return true;
    }
    seen.add(at);
  }
  return false;
}

/** Keys in the order the grouped list shows them, parents before their sub-tickets. */
export function flattenKeys(nodes: TicketNode[]): string[] {
  return nodes.flatMap((n) => [n.ticket.key, ...flattenKeys(n.children)]);
}

/** Tickets for AI matching: flagged first, then the rest, each in your list order. */
export function prioritized(list: TicketList): Ticket[] {
  const byKey = new Map(list.tickets.map((t) => [t.key, t]));
  const ordered = flattenKeys(groupTickets(list.tickets)).map((k) => byKey.get(k)!);
  return [...ordered.filter((t) => t.flagged), ...ordered.filter((t) => !t.flagged)];
}
