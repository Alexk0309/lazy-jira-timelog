import { adjustEstimate, estimateProgress } from '../core/estimate';
import { dayStart, formatDuration, localDay, parseDuration } from '../core/time';
import type { LoggedWork } from '../jira';
import { call } from '../messages';
import { el, estimateBar, ticketHeading, toast } from './dom';
import { goTo, mountTabs } from './nav';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const calEl = $('cal');
const dayEl = $('day');

const today = localDay(Date.now());
/** First of the month on show. */
let month = firstOfMonth(today);
let selected = today;
let logs: LoggedWork[] = [];
let loading = false;
let openId: string | null = null;
let confirmDeleteId: string | null = null;
let siteUrl = '';
let roundMinutes = 15;
/** Bumped on every load so a slow, older month can't overwrite a newer one. */
let loadToken = 0;

$('prev').addEventListener('click', () => void showMonth(shiftMonth(month, -1)));
$('next').addEventListener('click', () => void showMonth(shiftMonth(month, 1)));
$('this-month').addEventListener('click', () => {
  selected = today;
  void showMonth(firstOfMonth(today));
});
mountTabs('calendar.html');
$('setup-button').addEventListener('click', () => goTo('options.html'));

void init();

async function init(): Promise<void> {
  const settings = await call('getSettings');
  siteUrl = settings.siteUrl.replace(/\/+$/, '');
  roundMinutes = settings.roundMinutes;
  await showMonth(month);
}

async function showMonth(first: string): Promise<void> {
  month = first;
  if (firstOfMonth(selected) !== month) {
    selected = month === firstOfMonth(today) ? today : month;
  }
  openId = null;
  confirmDeleteId = null;
  logs = [];
  loading = true;
  render();
  const token = ++loadToken;
  const [from, to] = gridRange(month);
  try {
    const found = await call('logged', { from: dayStart(from), to: dayStart(to) });
    if (token !== loadToken) {
      return;
    }
    logs = found;
    $('setup').hidden = true;
  } catch (err) {
    if (token !== loadToken) {
      return;
    }
    $('setup').hidden = false;
    $('setup-text').textContent = (err as Error).message;
  }
  loading = false;
  render();
}

// ---------- Rendering ----------

function render(): void {
  renderHeader();
  renderGrid();
  renderDay();
}

function renderHeader(): void {
  const label = new Date(dayStart(month)).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  $('month-label').textContent = label;
  const total = $('month-total');
  total.replaceChildren();
  if (loading) {
    total.append('…', el('small', {}, 'loading'));
    return;
  }
  const seconds = logs.filter((l) => firstOfMonth(localDay(l.started)) === month).reduce((sum, l) => sum + l.seconds, 0);
  total.append(formatDuration(seconds * 1000), el('small', {}, 'logged'));
}

function renderGrid(): void {
  calEl.replaceChildren();
  const base = new Date(dayStart(month));
  // Weekday names, Monday first.
  for (let i = 0; i < 7; i++) {
    const d = new Date(2024, 0, 1 + i);
    calEl.append(el('div', { class: 'cal-head', role: 'columnheader' }, d.toLocaleDateString(undefined, { weekday: 'short' })));
  }
  const perDay = new Map<string, number>();
  for (const log of logs) {
    const day = localDay(log.started);
    perDay.set(day, (perDay.get(day) ?? 0) + log.seconds);
  }
  const [from, to] = gridRange(month);
  for (let t = dayStart(from); t < dayStart(to); t = nextDay(t)) {
    const day = localDay(t);
    const d = new Date(t);
    const seconds = perDay.get(day) ?? 0;
    const classes = ['cal-day'];
    if (d.getMonth() !== base.getMonth()) classes.push('outside');
    if (day === today) classes.push('today');
    if (day === selected) classes.push('selected');
    if (day > today) classes.push('future');
    if (d.getDay() === 0 || d.getDay() === 6) classes.push('weekend');
    const cell = el(
      'button',
      {
        class: classes.join(' '),
        type: 'button',
        role: 'gridcell',
        'data-day': day,
        'aria-label': `${d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}${seconds ? `, ${formatDuration(seconds * 1000)} logged` : ''}`,
        'aria-selected': String(day === selected),
      },
      el('span', { class: 'cal-num' }, String(d.getDate())),
      el('span', { class: 'cal-time' }, seconds ? formatDuration(seconds * 1000) : ''),
      el('span', { class: 'cal-bar', style: `--fill: ${Math.min(1, seconds / (8 * 3600))}` }),
    );
    cell.addEventListener('click', () => {
      selected = day;
      openId = null;
      confirmDeleteId = null;
      render();
    });
    calEl.append(cell);
  }
}

function renderDay(): void {
  const dayLogs = logs.filter((l) => localDay(l.started) === selected);
  const seconds = dayLogs.reduce((sum, l) => sum + l.seconds, 0);
  const label = new Date(dayStart(selected)).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  $('day-title').textContent = `${label}${seconds ? ` · ${formatDuration(seconds * 1000)}` : ''}`;
  dayEl.replaceChildren();
  if (loading) {
    dayEl.append(el('p', { class: 'footnote' }, 'Loading your worklogs from Jira…'));
    return;
  }
  if (dayLogs.length === 0) {
    dayEl.append(el('p', { class: 'footnote' }, 'Nothing logged on this day.'));
    return;
  }
  dayEl.append(el('div', { class: 'group' }, ...dayLogs.map(renderLog)));
}

function renderLog(log: LoggedWork): HTMLElement {
  const open = openId === log.id;
  const container = el('div', { class: `row${open ? ' open' : ''}`, 'data-id': log.id });
  const main = el(
    'button',
    { class: 'row-main', type: 'button', 'aria-expanded': String(open) },
    el(
      'div',
      { class: 'row-text' },
      ticketHeading(log.key, log.summary),
      el('div', { class: 'row-sub' }, [clock(log.started), log.comment.split('\n')[0]].filter(Boolean).join(' · ')),
      estimateBar(estimateProgress(log.estimate), log.key),
    ),
    el('span', { class: 'row-time' }, formatDuration(log.seconds * 1000)),
    chevron(),
  );
  main.addEventListener('click', () => {
    openId = open ? null : log.id;
    confirmDeleteId = null;
    renderDay();
  });
  container.append(main);
  if (open) {
    container.append(renderEditor(log));
  }
  return container;
}

function renderEditor(log: LoggedWork): HTMLElement {
  const start = el('input', { type: 'time', value: clock(log.started), 'aria-label': 'Start time', class: 'start' }) as HTMLInputElement;

  const duration = el('input', { class: 'duration', type: 'text', value: formatDuration(log.seconds * 1000), 'aria-label': 'Duration' }) as HTMLInputElement;
  const step = (dir: number) => {
    const current = parseDuration(duration.value) ?? 0;
    const stepSec = roundMinutes * 60;
    const next = Math.max(stepSec, Math.round(current / stepSec) * stepSec + dir * stepSec);
    duration.value = formatDuration(next * 1000);
  };
  const minus = el('button', { type: 'button', 'aria-label': `Remove ${roundMinutes} minutes` }, '−');
  const plus = el('button', { type: 'button', 'aria-label': `Add ${roundMinutes} minutes` }, '+');
  minus.addEventListener('click', () => step(-1));
  plus.addEventListener('click', () => step(1));

  const comment = el('textarea', { rows: '2', 'aria-label': 'Worklog comment' }) as HTMLTextAreaElement;
  comment.value = log.comment;

  const note = el('span', { class: 'note', hidden: '' });
  const showError = (message: string) => {
    note.textContent = message;
    note.className = 'note error';
    note.hidden = false;
  };

  const confirming = confirmDeleteId === log.id;
  const del = el('button', { class: 'btn btn-danger', type: 'button' }, confirming ? 'Delete from Jira?' : 'Delete') as HTMLButtonElement;
  del.addEventListener('click', async () => {
    if (confirmDeleteId !== log.id) {
      confirmDeleteId = log.id;
      renderDay();
      return;
    }
    del.disabled = true;
    try {
      await call('deleteWorklog', { key: log.key, id: log.id });
      logs = logs.filter((l) => l !== log);
      adjustLocally(log.key, -log.seconds);
      openId = null;
      confirmDeleteId = null;
      render();
      toast(`Deleted ${formatDuration(log.seconds * 1000)} from ${log.key}`);
    } catch (err) {
      del.disabled = false;
      showError((err as Error).message);
    }
  });

  const save = el('button', { class: 'btn btn-primary', type: 'button' }, 'Save') as HTMLButtonElement;
  save.addEventListener('click', async () => {
    const seconds = parseDuration(duration.value);
    const started = atClock(localDay(log.started), start.value);
    if (seconds === null || seconds < 60) {
      showError('Enter a duration like 1h 30m.');
      return;
    }
    if (started === null) {
      showError('Enter a start time.');
      return;
    }
    save.disabled = true;
    try {
      await call('editWorklog', { key: log.key, id: log.id, started, duration: duration.value, comment: comment.value });
      adjustLocally(log.key, seconds - log.seconds);
      Object.assign(log, { started, seconds, comment: comment.value.trim() });
      openId = null;
      render();
      toast(`Updated ${log.key}`);
    } catch (err) {
      save.disabled = false;
      showError((err as Error).message);
    }
  });

  const actions = el('div', { class: 'actions' }, del, el('span', { class: 'spacer' }));
  if (siteUrl) {
    actions.append(
      el('a', { class: 'btn btn-plain', href: `${siteUrl}/browse/${encodeURIComponent(log.key)}`, target: '_blank', rel: 'noreferrer' }, 'Open in Jira'),
    );
  }
  actions.append(save);

  return el(
    'div',
    { class: 'editor' },
    el('div', { class: 'field-row' }, start, el('div', { class: 'stepper' }, minus, duration, plus)),
    comment,
    note,
    actions,
  );
}

// ---------- Dates ----------

function firstOfMonth(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

function shiftMonth(first: string, by: number): string {
  const d = new Date(dayStart(first));
  d.setMonth(d.getMonth() + by, 1);
  return localDay(d.getTime());
}

function nextDay(t: number): number {
  const d = new Date(t);
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** First and one-past-last day of the Monday-first weeks covering the month. */
function gridRange(first: string): [string, string] {
  const start = new Date(dayStart(first));
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const end = new Date(dayStart(shiftMonth(first, 1)));
  end.setDate(end.getDate() + ((7 - ((end.getDay() + 6) % 7)) % 7));
  return [localDay(start.getTime()), localDay(end.getTime())];
}

function clock(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Epoch ms of `HH:MM` on `day`, or null. */
function atClock(day: string, value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }
  const d = new Date(dayStart(day));
  d.setHours(Number(match[1]), Number(match[2]), 0, 0);
  return d.getTime();
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

/** Keeps the estimate bars in step with an edit or delete without reloading the month. */
function adjustLocally(key: string, deltaSeconds: number): void {
  for (const l of logs) {
    if (l.key === key && l.estimate) {
      l.estimate = adjustEstimate(l.estimate, deltaSeconds);
    }
  }
}
