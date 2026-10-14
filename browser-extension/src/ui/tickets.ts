import { flattenKeys, groupTickets, type Ticket, type TicketList, type TicketNode } from '../core/tickets';
import type { IssueSummary } from '../jira';
import { call } from '../messages';
import { el, toast } from './dom';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const listEl = $('list');

let list: TicketList = { tickets: [], manualOrder: false };
let tree: TicketNode[] = [];
let siteUrl = '';
const selected = new Set<string>();
/** Key being dragged, if any. */
let dragging: string | null = null;

$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('setup-button').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('refresh').addEventListener('click', () => void run(() => call('refreshTickets'), 'Refreshed from Jira'));
$('fetch-assigned').addEventListener('click', () => void fetchAssigned());
$('sort').addEventListener('click', () => void run(() => call('sortTickets')));
$('paste-toggle').addEventListener('click', () => togglePaste(true));
$('paste-cancel').addEventListener('click', () => togglePaste(false));
$('paste-add').addEventListener('click', () => void addFromText($<HTMLTextAreaElement>('paste-text').value, true));
$('paste-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    void addFromText($<HTMLTextAreaElement>('paste-text').value, true);
  }
});
$('sel-flag').addEventListener('click', () => void bulk((keys) => call('flagTickets', { keys, flagged: true })));
$('sel-unflag').addEventListener('click', () => void bulk((keys) => call('flagTickets', { keys, flagged: false })));
$('sel-remove').addEventListener('click', () => void bulk((keys) => call('removeTickets', { keys })));
$('sel-clear').addEventListener('click', () => {
  selected.clear();
  render();
});
$('remove-done').addEventListener('click', () => {
  const done = list.tickets.filter(isDone).map((t) => t.key);
  void run(() => call('removeTickets', { keys: done }), `Removed ${done.length} done ${done.length === 1 ? 'ticket' : 'tickets'}`);
});
setupSearch();

void init();

async function init(): Promise<void> {
  const settings = await call('getSettings');
  siteUrl = settings.siteUrl.replace(/\/+$/, '');
  list = await call('tickets');
  render();
}

/** Runs a list change, shows the new list, and reports a Jira problem instead of throwing. */
async function run(change: () => Promise<TicketList>, done?: string): Promise<boolean> {
  try {
    list = await change();
    $('setup').hidden = true;
    render();
    if (done) {
      toast(done);
    }
    return true;
  } catch (err) {
    showError(err as Error);
    return false;
  }
}

function showError(err: Error): void {
  if (/Settings|site|401|sign/i.test(err.message)) {
    $('setup').hidden = false;
    $('setup-text').textContent = err.message;
  } else {
    toast(err.message);
  }
}

async function fetchAssigned(): Promise<void> {
  const button = $<HTMLButtonElement>('fetch-assigned');
  button.disabled = true;
  try {
    const result = await call('addAssigned');
    list = result.list;
    $('setup').hidden = true;
    render();
    toast(result.added.length > 0 ? `Added ${result.added.length} assigned ${result.added.length === 1 ? 'ticket' : 'tickets'}` : 'Your assigned tickets are already on the list');
  } catch (err) {
    showError(err as Error);
  } finally {
    button.disabled = false;
  }
}

async function addFromText(text: string, fromPaste = false): Promise<void> {
  if (!text.trim()) {
    return;
  }
  try {
    const result = await call('addTickets', { text });
    list = result.list;
    $('setup').hidden = true;
    render();
    const parts = [result.added.length > 0 ? `Added ${result.added.join(', ')}` : 'Already on the list'];
    if (result.missing.length > 0) {
      parts.push(`not found: ${result.missing.join(', ')}`);
    }
    toast(parts.join('; '));
    if (fromPaste) {
      $<HTMLTextAreaElement>('paste-text').value = result.missing.join(' ');
      if (result.missing.length === 0) {
        togglePaste(false);
      }
    }
  } catch (err) {
    showError(err as Error);
  }
}

async function bulk(change: (keys: string[]) => Promise<TicketList>): Promise<void> {
  const keys = [...selected];
  if (keys.length === 0) {
    return;
  }
  if (await run(() => change(keys))) {
    selected.clear();
    render();
  }
}

function togglePaste(open: boolean): void {
  $('paste').hidden = !open;
  $('paste-toggle').setAttribute('aria-expanded', String(open));
  if (open) {
    $('paste-text').focus();
  }
}

function setupSearch(): void {
  const input = $<HTMLInputElement>('search');
  const results = $<HTMLUListElement>('results');
  let timer = 0;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = window.setTimeout(async () => {
      const query = input.value.trim();
      let found: IssueSummary[] = [];
      try {
        found = await call('search', { query });
      } catch (err) {
        showError(err as Error);
      }
      if (input.value.trim() !== query) {
        return;
      }
      const onList = new Set(list.tickets.map((t) => t.key));
      results.replaceChildren(
        ...found.map((r) => {
          const li = el('li', { tabindex: '0' }, el('strong', {}, r.key), r.summary, onList.has(r.key) ? el('span', { class: 'on-list' }, 'On list') : '');
          const pick = () => {
            input.value = '';
            results.hidden = true;
            void addFromText(r.key);
          };
          li.addEventListener('mousedown', (e) => {
            e.preventDefault();
            pick();
          });
          li.addEventListener('keydown', (e) => e.key === 'Enter' && pick());
          return li;
        }),
      );
      results.hidden = found.length === 0;
    }, 250);
  });
  input.addEventListener('keydown', (e) => {
    // Enter on a typed key adds it straight away.
    if (e.key === 'Enter' && /^[A-Za-z][A-Za-z0-9_]+-\d+$/.test(input.value.trim())) {
      const key = input.value.trim();
      input.value = '';
      results.hidden = true;
      void addFromText(key);
    }
  });
  input.addEventListener('blur', () => (results.hidden = true));
}

// ---------- Rendering ----------

function render(): void {
  tree = groupTickets(list.tickets);
  for (const key of [...selected]) {
    if (!list.tickets.some((t) => t.key === key)) {
      selected.delete(key);
    }
  }
  const flagged = list.tickets.filter((t) => t.flagged).length;
  const count = $('count');
  count.replaceChildren(`${list.tickets.length} ${list.tickets.length === 1 ? 'ticket' : 'tickets'}`);
  if (flagged > 0) {
    count.append(el('small', {}, `${flagged} flagged`));
  }

  $('sort').hidden = !list.manualOrder;
  $('list-title').textContent = list.manualOrder ? 'Your order' : 'Newest first';
  $('selection').hidden = selected.size === 0;
  $('selection-count').textContent = `${selected.size} selected`;

  if (list.tickets.length === 0) {
    listEl.replaceChildren(
      el(
        'div',
        { class: 'empty' },
        el('h2', {}, 'No tickets yet'),
        el('p', {}, 'Add the tickets you work on. Fill in with AI matches your time to this list first, so it picks the right ticket in a Jira shared by many teams.'),
      ),
    );
    $('list-hint').textContent = '';
  } else {
    listEl.replaceChildren(el('div', { class: 'group tickets' }, ...renderNodes(tree, 0)));
    $('list-hint').textContent = 'Drag to reorder, or use the handle with the arrow keys. Flagged tickets come first when Fill in with AI picks an issue.';
  }

  const done = list.tickets.filter(isDone).length;
  const removeDone = $('remove-done');
  removeDone.hidden = done === 0;
  removeDone.textContent = `Remove ${done} done ${done === 1 ? 'ticket' : 'tickets'}`;
}

function renderNodes(nodes: TicketNode[], depth: number): HTMLElement[] {
  return nodes.flatMap((n) => [renderTicket(n.ticket, depth), ...renderNodes(n.children, depth + 1)]);
}

function renderTicket(t: Ticket, depth: number): HTMLElement {
  const row = el('div', {
    class: `ticket${t.flagged ? ' flagged' : ''}${isDone(t) ? ' done' : ''}`,
    'data-key': t.key,
    draggable: 'true',
    style: `--depth: ${depth}`,
  });

  const handle = el('button', { class: 'handle', type: 'button', title: 'Drag to reorder', 'aria-label': `Move ${t.key}. Use the up and down arrow keys.` }, grip());
  handle.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      void moveBy(t.key, e.key === 'ArrowUp' ? -1 : 1);
    }
  });

  const check = el('input', { type: 'checkbox', 'aria-label': `Select ${t.key}` }) as HTMLInputElement;
  check.checked = selected.has(t.key);
  check.addEventListener('change', () => {
    if (check.checked) {
      selected.add(t.key);
    } else {
      selected.delete(t.key);
    }
    render();
  });

  const flag = el('button', { class: 'flag', type: 'button', 'aria-pressed': String(t.flagged), title: t.flagged ? 'Unflag' : 'Flag as a priority' }, flagIcon());
  flag.addEventListener('click', () => void run(() => call('flagTickets', { keys: [t.key], flagged: !t.flagged })));

  const meta = [t.issueType, t.created ? `created ${new Date(t.created).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : ''];
  if (t.parentKey && !list.tickets.some((p) => p.key === t.parentKey)) {
    meta.push(`in ${t.parentKey}${t.parentSummary ? ` ${t.parentSummary}` : ''}`);
  }
  const link = el('a', { class: 'row-key', href: `${siteUrl}/browse/${t.key}`, target: '_blank', rel: 'noopener', draggable: 'false' }, t.key);

  row.append(
    handle,
    check,
    flag,
    el(
      'div',
      { class: 'row-text' },
      el('div', { class: 'ticket-head' }, link, t.status ? el('span', { class: `chip ${t.statusCategory || 'new'}` }, t.status) : ''),
      el('div', { class: 'row-sub' }, t.summary || '(no summary)'),
      el('div', { class: 'ticket-meta' }, meta.filter(Boolean).join(' · ')),
    ),
  );

  row.addEventListener('dragstart', (e) => {
    dragging = t.key;
    row.classList.add('dragging');
    e.dataTransfer?.setData('text/plain', t.key);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
    }
  });
  row.addEventListener('dragend', () => {
    dragging = null;
    clearDropMarks();
  });
  row.addEventListener('dragover', (e) => {
    if (!dragging || dragging === t.key || !sameSiblings(dragging, t.key)) {
      return;
    }
    e.preventDefault();
    const after = isLowerHalf(e, row);
    clearDropMarks();
    row.classList.add(after ? 'drop-after' : 'drop-before');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
  row.addEventListener('drop', (e) => {
    e.preventDefault();
    const key = dragging;
    clearDropMarks();
    if (key && key !== t.key && sameSiblings(key, t.key)) {
      void moveTo(key, t.key, isLowerHalf(e, row));
    }
  });
  return row;
}

// ---------- Ordering ----------

/** The list of nodes that `key` sits in: the top level, or its parent's sub-tickets. */
function siblingsOf(key: string, nodes: TicketNode[] = tree): TicketNode[] | null {
  if (nodes.some((n) => n.ticket.key === key)) {
    return nodes;
  }
  for (const n of nodes) {
    const found = siblingsOf(key, n.children);
    if (found) {
      return found;
    }
  }
  return null;
}

/** Sub-tickets stay with their parent, so a drag only reorders within one level. */
function sameSiblings(a: string, b: string): boolean {
  const siblings = siblingsOf(a);
  return !!siblings && siblings.some((n) => n.ticket.key === b);
}

async function moveTo(key: string, target: string, after: boolean): Promise<void> {
  const siblings = siblingsOf(key);
  if (!siblings) {
    return;
  }
  const node = siblings.splice(siblings.findIndex((n) => n.ticket.key === key), 1)[0];
  siblings.splice(siblings.findIndex((n) => n.ticket.key === target) + (after ? 1 : 0), 0, node);
  await saveOrder(key);
}

async function moveBy(key: string, step: number): Promise<void> {
  const siblings = siblingsOf(key);
  const index = siblings?.findIndex((n) => n.ticket.key === key) ?? -1;
  const to = index + step;
  if (!siblings || index < 0 || to < 0 || to >= siblings.length) {
    return;
  }
  const [node] = siblings.splice(index, 1);
  siblings.splice(to, 0, node);
  await saveOrder(key);
}

async function saveOrder(focusKey: string): Promise<void> {
  // Show the new order at once; storage follows.
  const keys = flattenKeys(tree);
  const byKey = new Map(list.tickets.map((t) => [t.key, t]));
  list = { tickets: keys.map((k) => byKey.get(k)!), manualOrder: true };
  render();
  document.querySelector<HTMLElement>(`.ticket[data-key="${focusKey}"] .handle`)?.focus();
  await run(() => call('reorderTickets', { keys }));
  document.querySelector<HTMLElement>(`.ticket[data-key="${focusKey}"] .handle`)?.focus();
}

function isLowerHalf(e: DragEvent, row: HTMLElement): boolean {
  const box = row.getBoundingClientRect();
  return e.clientY > box.top + box.height / 2;
}

function clearDropMarks(): void {
  document.querySelectorAll('.drop-before, .drop-after, .dragging').forEach((n) => n.classList.remove('drop-before', 'drop-after', 'dragging'));
}

// ---------- Helpers ----------

function isDone(t: Ticket): boolean {
  return t.statusCategory === 'done';
}

function svg(d: string, fill = false): SVGElement {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 24 24');
  node.setAttribute('aria-hidden', 'true');
  node.setAttribute('fill', fill ? 'currentColor' : 'none');
  node.setAttribute('stroke', 'currentColor');
  node.setAttribute('stroke-width', '2');
  node.setAttribute('stroke-linecap', 'round');
  node.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  node.append(path);
  return node;
}

function grip(): SVGElement {
  return svg('M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01');
}

function flagIcon(): SVGElement {
  return svg('M5 21V4m0 0h11l-2 4 2 4H5');
}
