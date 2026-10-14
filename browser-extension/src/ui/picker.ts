import type { Ticket } from '../core/tickets';
import type { IssueSummary } from '../jira';
import { call } from '../messages';
import { el } from './dom';

export interface PickerOptions {
  /** The key the field shows, and goes back to when you leave it. */
  current: () => string;
  /** Your ticket list, flagged first; offered before Jira's matches. */
  saved: () => Ticket[];
  /** Typing a key by hand. */
  onType?: (key: string) => void;
  onPick: (issue: IssueSummary) => void;
  onBlur?: () => void;
}

/** A Jira issue search field: your ticket list first, then Jira's matches as you type. */
export function issuePicker(o: PickerOptions): HTMLElement {
  const issue = el('input', { type: 'text', value: o.current(), placeholder: 'Search Jira issues', 'aria-label': 'Jira issue' }) as HTMLInputElement;
  const results = el('ul', { class: 'results', hidden: '' });
  let timer = 0;
  const showResults = (found: IssueSummary[]) => {
    const flagged = new Set(o.saved().filter((t) => t.flagged).map((t) => t.key));
    results.replaceChildren(
      ...found.map((r) => {
        const li = el('li', { tabindex: '0', class: flagged.has(r.key) ? 'flagged' : '' }, el('strong', {}, r.key), r.summary);
        const pick = () => {
          issue.value = r.key;
          results.hidden = true;
          o.onPick(r);
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
  };
  const savedMatching = (query: string) => {
    const q = query.trim().toLowerCase();
    return o
      .saved()
      .filter((t) => !q || t.key.toLowerCase().includes(q) || t.summary.toLowerCase().includes(q))
      .slice(0, 8);
  };
  issue.addEventListener('focus', () => {
    if (!issue.value.trim() || issue.value.trim() === o.current()) {
      showResults(savedMatching(''));
    }
  });
  issue.addEventListener('input', () => {
    o.onType?.(issue.value.trim().toUpperCase());
    clearTimeout(timer);
    const query = issue.value;
    const mine = savedMatching(query);
    showResults(mine);
    timer = window.setTimeout(async () => {
      const found = query.trim().length >= 2 ? await call('search', { query }).catch(() => [] as IssueSummary[]) : [];
      if (issue.value !== query) {
        return;
      }
      const keys = new Set(mine.map((t) => t.key));
      showResults([...mine, ...found.filter((r) => !keys.has(r.key))].slice(0, 10));
    }, 250);
  });
  issue.addEventListener('blur', () => {
    results.hidden = true;
    issue.value = o.current();
    o.onBlur?.();
  });
  return el('div', { class: 'search' }, issue, results);
}
