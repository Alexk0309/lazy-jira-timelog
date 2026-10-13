import { roundToStep } from '../core/drafts';
import { dayStart, formatDuration, parseDuration } from '../core/time';
import type { Draft } from '../core/types';
import type { IssueSummary } from '../jira';
import { call } from '../messages';
import { el, toast } from './dom';

interface Row {
  id: string;
  day: string;
  sourceKey: string;
  targetKey: string;
  rawMs: number;
  duration: string;
  started: number;
  comment: string;
  kind: 'tracked' | 'suggested';
  done: boolean;
  note?: { text: string; level: 'warn' | 'error' | 'ok' };
}

const isPopup = new URLSearchParams(location.search).has('popup');
document.body.classList.toggle('popup', isPopup);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const daysEl = $('days');

let rows: Row[] = [];
let openId: string | null = null;
let roundMinutes = 15;
let today = '';
let nextId = 1;
const summaries = new Map<string, string | null>();

$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('setup-button').addEventListener('click', () => chrome.runtime.openOptionsPage());
const expand = $('expand');
expand.hidden = !isPopup;
expand.addEventListener('click', () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('review.html') });
  window.close();
});
$('log-all').addEventListener('click', () => void logAll());

void load();

async function load(): Promise<void> {
  const [state, settings] = await Promise.all([call('state'), call('getSettings')]);
  roundMinutes = settings.roundMinutes;
  today = state.today;

  $('date').textContent = new Date(dayStart(today)).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const status = $('status');
  status.classList.toggle('live', !!state.tracking);
  $('status-text').textContent = state.tracking ? `Tracking ${state.tracking.key}` : 'Not tracking';

  $('setup').hidden = !state.setupMessage;
  $('setup-text').textContent = state.setupMessage ?? '';

  rows = state.drafts.map((d) => fromDraft(d));
  render();

  if (!state.setupMessage) {
    void loadSuggestions();
    void loadSummaries(rows.map((r) => r.targetKey));
    void loadManualLogs();
  }
}

function fromDraft(d: Draft): Row {
  return {
    id: String(nextId++),
    day: d.day,
    sourceKey: d.sourceKey,
    targetKey: d.sourceKey,
    rawMs: d.rawMs,
    duration: formatDuration(d.seconds * 1000),
    started: d.started,
    comment: d.comment,
    kind: 'tracked',
    done: false,
  };
}

async function loadSuggestions(): Promise<void> {
  const issues = await call('suggestions').catch(() => [] as IssueSummary[]);
  for (const issue of issues) {
    summaries.set(issue.key, issue.summary);
    rows.push({
      id: String(nextId++),
      day: today,
      sourceKey: issue.key,
      targetKey: issue.key,
      rawMs: 0,
      duration: '',
      started: Date.now(),
      comment: `Worked on ${issue.key}`,
      kind: 'suggested',
      done: false,
    });
  }
  if (issues.length > 0) {
    render();
  }
}

async function loadSummaries(keys: string[]): Promise<void> {
  const wanted = keys.filter((k) => k && !summaries.has(k));
  if (wanted.length === 0) {
    return;
  }
  const found = await call('summaries', { keys: wanted }).catch(() => ({}) as Record<string, string | null>);
  for (const [key, summary] of Object.entries(found)) {
    summaries.set(key, summary);
  }
  updateSubtitles();
}

async function loadManualLogs(): Promise<void> {
  const items = rows.filter((r) => r.kind === 'tracked' && r.targetKey).map((r) => ({ key: r.targetKey, day: r.day }));
  if (items.length === 0) {
    return;
  }
  const manual = await call('manualLogs', { items }).catch(() => ({}) as Record<string, number>);
  for (const row of rows) {
    const seconds = manual[`${row.targetKey}|${row.day}`];
    if (seconds && !row.note) {
      row.note = { text: `You already logged ${formatDuration(seconds * 1000)} here by hand`, level: 'warn' };
      updateRow(row);
    }
  }
}

// ---------- Rendering ----------

function render(): void {
  daysEl.replaceChildren();
  const tracked = rows.filter((r) => r.kind === 'tracked');
  const suggested = rows.filter((r) => r.kind === 'suggested' && !r.done);
  const days = [...new Set(tracked.map((r) => r.day))];

  for (const day of days) {
    const dayRows = tracked.filter((r) => r.day === day);
    const total = dayRows.filter((r) => !r.done).reduce((sum, r) => sum + (parseDuration(r.duration) ?? 0), 0);
    daysEl.append(
      el('h2', { class: 'section-title' }, `${dayLabel(day)}${total > 0 ? ` · ${formatDuration(total * 1000)}` : ''}`),
      el('div', { class: 'group' }, ...dayRows.map(renderRow)),
    );
  }
  if (suggested.length > 0) {
    daysEl.append(
      el('h2', { class: 'section-title' }, 'Touched in Jira today'),
      el('div', { class: 'group' }, ...suggested.map(renderRow)),
      el('p', { class: 'footnote' }, 'No time was tracked on these. Add some if you worked on them away from the browser.'),
    );
  }

  const open = rows.filter((r) => !r.done && r.kind === 'tracked');
  $('empty').hidden = open.length > 0 || suggested.length > 0 || !$('setup').hidden;
  renderTotals();
}

function renderTotals(): void {
  const open = rows.filter((r) => !r.done && (r.kind === 'tracked' || parseDuration(r.duration)));
  const seconds = open.reduce((sum, r) => sum + (parseDuration(r.duration) ?? 0), 0);
  const total = $('total');
  total.replaceChildren();
  if (seconds > 0) {
    total.append(formatDuration(seconds * 1000), el('small', {}, 'to log'));
  } else {
    total.append('All logged');
  }

  const loggable = open.filter((r) => r.targetKey && parseDuration(r.duration));
  const unassigned = open.filter((r) => !r.targetKey).length;
  $('bottom').hidden = loggable.length === 0;
  const button = $<HTMLButtonElement>('log-all');
  const loggableSeconds = loggable.reduce((sum, r) => sum + (parseDuration(r.duration) ?? 0), 0);
  button.textContent = `Log ${formatDuration(loggableSeconds * 1000)}`;
  const hint = $('bottom-hint');
  hint.hidden = unassigned === 0;
  hint.textContent = `${unassigned} ${unassigned === 1 ? 'entry needs' : 'entries need'} an issue first`;
}

function renderRow(row: Row): HTMLElement {
  const container = el('div', { class: `row${row.id === openId ? ' open' : ''}${row.done ? ' done' : ''}`, 'data-id': row.id });

  const main = el(
    'button',
    { class: 'row-main', type: 'button', 'aria-expanded': String(row.id === openId) },
    el(
      'div',
      { class: 'row-text' },
      el('div', { class: `row-key${row.targetKey ? '' : ' unassigned'}` }, row.targetKey || 'Unassigned'),
      el('div', { class: 'row-sub' }, subtitle(row)),
    ),
    el('span', { class: 'row-time' }, row.done ? 'Logged' : row.duration || 'Add'),
    chevron(),
  );
  main.addEventListener('click', () => {
    if (row.done) {
      return;
    }
    openId = openId === row.id ? null : row.id;
    render();
    if (openId) {
      container.ownerDocument.querySelector<HTMLInputElement>(`.row[data-id="${row.id}"] .duration`)?.focus();
    }
  });
  container.append(main);

  if (row.id === openId && !row.done) {
    container.append(renderEditor(row));
  } else if (row.note) {
    container.append(el('div', { class: 'editor' }, el('span', { class: `note ${row.note.level}` }, row.note.text)));
  }
  return container;
}

function renderEditor(row: Row): HTMLElement {
  // Issue picker
  const issue = el('input', { type: 'text', value: row.targetKey, placeholder: 'Search Jira issues', 'aria-label': 'Jira issue' }) as HTMLInputElement;
  const results = el('ul', { class: 'results', hidden: '' });
  let timer = 0;
  issue.addEventListener('input', () => {
    row.targetKey = issue.value.trim().toUpperCase();
    clearTimeout(timer);
    timer = window.setTimeout(async () => {
      const found = await call('search', { query: issue.value }).catch(() => [] as IssueSummary[]);
      results.replaceChildren(
        ...found.map((r) => {
          const li = el('li', { tabindex: '0' }, el('strong', {}, r.key), r.summary);
          const pick = () => {
            row.targetKey = r.key;
            summaries.set(r.key, r.summary);
            issue.value = r.key;
            results.hidden = true;
            updateHeader(row);
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
  issue.addEventListener('blur', () => {
    results.hidden = true;
    issue.value = row.targetKey;
    updateHeader(row);
    void loadSummaries([row.targetKey]);
  });

  // Duration stepper
  const duration = el('input', { class: 'duration', type: 'text', value: row.duration, placeholder: '0m', 'aria-label': 'Duration' }) as HTMLInputElement;
  const step = (dir: number) => {
    const current = parseDuration(duration.value) ?? 0;
    const stepSec = roundMinutes * 60;
    const next = Math.max(stepSec, Math.round(current / stepSec) * stepSec + dir * stepSec);
    duration.value = formatDuration(next * 1000);
    row.duration = duration.value;
    updateHeader(row);
  };
  const minus = el('button', { type: 'button', 'aria-label': `Remove ${roundMinutes} minutes` }, '−');
  const plus = el('button', { type: 'button', 'aria-label': `Add ${roundMinutes} minutes` }, '+');
  minus.addEventListener('click', () => step(-1));
  plus.addEventListener('click', () => step(1));
  duration.addEventListener('input', () => {
    row.duration = duration.value;
    updateHeader(row);
  });
  duration.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      void logRows([row]);
    }
  });

  const comment = el('textarea', { rows: '2', 'aria-label': 'Worklog comment' }) as HTMLTextAreaElement;
  comment.value = row.comment;
  comment.addEventListener('input', () => (row.comment = comment.value));

  const discard = el('button', { class: 'btn btn-danger', type: 'button' }, row.kind === 'suggested' ? 'Hide' : 'Discard');
  discard.addEventListener('click', () => void discardRow(row));
  const split = el('button', { class: 'btn btn-plain', type: 'button' }, 'Split');
  split.addEventListener('click', () => splitRow(row));
  split.hidden = row.kind !== 'tracked';
  const log = el('button', { class: 'btn btn-primary', type: 'button' }, 'Log');
  log.addEventListener('click', () => void logRows([row]));

  return el(
    'div',
    { class: 'editor' },
    el('div', { class: 'field-row' }, el('div', { class: 'search' }, issue, results), el('div', { class: 'stepper' }, minus, duration, plus)),
    comment,
    row.note ? el('span', { class: `note ${row.note.level}` }, row.note.text) : '',
    el('div', { class: 'actions' }, discard, split, el('span', { class: 'spacer' }), log),
  );
}

function updateHeader(row: Row): void {
  const node = document.querySelector(`.row[data-id="${row.id}"]`);
  if (!node) {
    return;
  }
  const key = node.querySelector('.row-key')!;
  key.textContent = row.targetKey || 'Unassigned';
  key.classList.toggle('unassigned', !row.targetKey);
  node.querySelector('.row-sub')!.textContent = subtitle(row);
  node.querySelector('.row-time')!.textContent = row.duration || 'Add';
  renderTotals();
}

function updateRow(row: Row): void {
  const node = document.querySelector(`.row[data-id="${row.id}"]`);
  node?.replaceWith(renderRow(row));
}

function updateSubtitles(): void {
  for (const row of rows) {
    const sub = document.querySelector(`.row[data-id="${row.id}"] .row-sub`);
    if (sub) {
      sub.textContent = subtitle(row);
    }
  }
}

function subtitle(row: Row): string {
  if (!row.targetKey) {
    return 'Choose the issue this time belongs to';
  }
  const summary = summaries.get(row.targetKey);
  if (summary === null) {
    return `${row.targetKey} wasn't found in Jira`;
  }
  return summary ?? row.comment.split('\n')[0];
}

// ---------- Actions ----------

async function logRows(targets: Row[]): Promise<void> {
  let logged = 0;
  for (const row of targets) {
    if (!row.targetKey) {
      row.note = { text: 'Choose an issue first.', level: 'error' };
      updateRow(row);
      continue;
    }
    try {
      await call('post', {
        day: row.day,
        sourceKey: row.sourceKey,
        rawMs: row.rawMs,
        targetKey: row.targetKey,
        duration: row.duration,
        started: row.started,
        comment: row.comment,
      });
      row.done = true;
      row.note = undefined;
      logged++;
      if (openId === row.id) {
        openId = null;
      }
    } catch (err) {
      row.note = { text: (err as Error).message, level: 'error' };
    }
  }
  render();
  if (logged > 0) {
    toast(`Logged ${logged} ${logged === 1 ? 'entry' : 'entries'} to Jira`);
  }
}

async function logAll(): Promise<void> {
  const button = $<HTMLButtonElement>('log-all');
  button.disabled = true;
  try {
    await logRows(rows.filter((r) => !r.done && r.targetKey && parseDuration(r.duration)));
  } finally {
    button.disabled = false;
  }
}

async function discardRow(row: Row): Promise<void> {
  if (row.kind === 'tracked') {
    try {
      await call('discard', { day: row.day, sourceKey: row.sourceKey, rawMs: row.rawMs });
    } catch (err) {
      row.note = { text: (err as Error).message, level: 'error' };
      updateRow(row);
      return;
    }
  }
  rows = rows.filter((r) => r.id !== row.id);
  openId = null;
  render();
}

function splitRow(row: Row): void {
  const half = Math.floor(row.rawMs / 2);
  const second: Row = {
    ...row,
    id: String(nextId++),
    targetKey: '',
    rawMs: row.rawMs - half,
    duration: formatDuration(roundToStep(row.rawMs - half, roundMinutes) * 1000),
    note: undefined,
  };
  row.rawMs = half;
  row.duration = formatDuration(roundToStep(half, roundMinutes) * 1000);
  rows.splice(rows.indexOf(row) + 1, 0, second);
  openId = second.id;
  render();
}

// ---------- Helpers ----------

function dayLabel(day: string): string {
  if (day === today) {
    return 'Today';
  }
  const d = new Date(dayStart(day));
  const yesterday = new Date(dayStart(today));
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.getTime() === yesterday.getTime()) {
    return 'Yesterday';
  }
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
}

function chevron(): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('class', 'chevron');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.2');
  svg.setAttribute('stroke-linecap', 'round');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'm9 6 6 6-6 6');
  svg.append(path);
  return svg;
}
