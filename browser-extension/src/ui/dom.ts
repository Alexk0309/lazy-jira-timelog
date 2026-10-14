import type { Progress } from '../core/estimate';

type Child = Node | string;

/** Tiny element builder. Text is always set as text, never parsed as HTML. */
export function el(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (name === 'value' && (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)) {
      node.value = value;
    } else {
      node.setAttribute(name, value);
    }
  }
  for (const child of children) {
    if (child !== '') {
      node.append(child);
    }
  }
  return node;
}

let toastTimer = 0;

/** A short, self-dismissing confirmation at the bottom of the page. */
export function toast(message: string): void {
  const node = document.getElementById('toast');
  if (!node) {
    return;
  }
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (node.hidden = true), 2400);
}

/** A ticket key with its Jira title beside it, read-only and cut to one line. */
export function ticketHeading(key: string, title?: string | null, extraClass = ''): HTMLElement {
  return el('div', { class: `row-key${extraClass ? ` ${extraClass}` : ''}` }, el('span', { class: 'key' }, key), title ? el('span', { class: 'row-title' }, title) : '');
}

/** A slim bar of logged time against the ticket's estimate; nothing when it has none. */
export function estimateBar(progress: Progress | null, key: string): HTMLElement | '' {
  if (!progress) {
    return '';
  }
  const pct = (f: number) => `${(Math.min(1, f) * 100).toFixed(1)}%`;
  return el(
    'div',
    {
      class: `estimate${progress.over ? ' over' : ''}`,
      role: 'img',
      'aria-label': `${key}: ${progress.label} estimate${progress.over ? ', over estimate' : ''}`,
      title: `${progress.label} estimate${progress.over ? ' (over)' : ''}`,
    },
    el(
      'span',
      { class: 'estimate-track' },
      el('span', { class: 'estimate-logged', style: `width: ${pct(progress.logged)}` }),
      el('span', { class: 'estimate-adding', style: `width: ${pct(Math.max(0, Math.min(progress.adding, 1 - progress.logged)))}` }),
    ),
    el('span', { class: 'estimate-label' }, progress.label),
  );
}
