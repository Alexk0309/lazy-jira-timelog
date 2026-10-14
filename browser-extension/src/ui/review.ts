import type { AiNewEntry, AiQuestion, AiSuggestion } from '../ai';
import { isUnassignedKey } from '../classify';
import { roundToStep } from '../core/drafts';
import { prioritized, type Ticket } from '../core/tickets';
import { dayStart, formatDuration, localDay, parseDuration } from '../core/time';
import { type Estimate, estimateProgress } from '../core/estimate';
import type { Draft } from '../core/types';
import type { IssueSummary } from '../jira';
import { call } from '../messages';
import { el, estimateBar, ticketHeading, toast } from './dom';
import { goTo, mountTabs, setParams } from './nav';
import { issuePicker } from './picker';

interface Row {
  id: string;
  day: string;
  sourceKey: string;
  targetKey: string;
  rawMs: number;
  duration: string;
  started: number;
  comment: string;
  /** tracked: measured by the browser; suggested: touched in Jira today; added: from your day summary or by hand. */
  kind: 'tracked' | 'suggested' | 'added';
  done: boolean;
  /** For added rows: which AI run and entry it came from. */
  ai?: { at: number; index: number };
  /** Cursor's question about which issue this time belongs to, until you answer it. */
  question?: { at: number; index: number; ask: AiQuestion };
  note?: { text: string; level: 'warn' | 'error' | 'ok' | 'ai' };
}

mountTabs('review.html');

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const daysEl = $('days');

let rows: Row[] = [];
let openId: string | null = null;
let roundMinutes = 15;
let today = '';
/** The day on show; only its entries are listed and logged. */
let selected = '';
/** Seconds already in Jira per day of the week on show, for the day strip. */
let loggedPerDay = new Map<string, number>();
let weekShown = '';
let weekToken = 0;
let jiraReady = false;
let nextId = 1;
let aiEnabled = false;
/** Day Cursor is currently filling in, if any. */
let aiBusyDay: string | null = null;
/** Day whose "describe your day" box is open, if any. */
let aiComposerDay: string | null = null;
const summaries = new Map<string, string | null>();
/** Time tracking per issue key; a key is present once Jira was asked, even without an estimate. */
const estimates = new Map<string, Estimate | undefined>();
/** Keys asked for, or waiting to be asked for, in one batched request. */
const requested = new Set<string>();
let waiting: string[] = [];
/** Your ticket list, flagged first; offered first in the issue picker. */
let saved: Ticket[] = [];

/** Saved AI suggestions older than this aren't re-applied when the popup opens. */
const AI_FRESH_MS = 12 * 3_600_000;

$('setup-button').addEventListener('click', () => goTo('options.html'));
$('log-all').addEventListener('click', () => void logAll());
$('prev-day').addEventListener('click', () => select(shiftDay(selected, -1)));
$('next-day').addEventListener('click', () => select(shiftDay(selected, 1)));
$('to-today').addEventListener('click', () => select(today));
const dayInput = $<HTMLInputElement>('pick-day');
$('pick-button').addEventListener('click', () => {
  dayInput.value = selected;
  try {
    dayInput.showPicker();
  } catch {
    dayInput.focus();
  }
});
dayInput.addEventListener('change', () => dayInput.value && select(dayInput.value));

void load();

async function load(): Promise<void> {
  const [state, settings] = await Promise.all([call('state'), call('getSettings')]);
  roundMinutes = settings.roundMinutes;
  aiEnabled = !!settings.cursorApiKey && !state.setupMessage;
  today = state.today;
  selected = validDay(new URLSearchParams(location.search).get('day')) ?? today;
  dayInput.max = today;
  jiraReady = !state.setupMessage;
  const status = $('status');
  status.classList.toggle('live', !!state.tracking);
  const trackingKey = state.tracking?.key;
  $('status-text').textContent = trackingKey
    ? `Tracking ${isUnassignedKey(trackingKey) ? 'a pull request' : trackingKey}`
    : 'Not tracking';

  $('setup').hidden = !state.setupMessage;
  $('setup-text').textContent = state.setupMessage ?? '';

  rows = state.drafts.map((d) => fromDraft(d));
  render();
  void loadWeek();

  if (!state.setupMessage) {
    void call('tickets')
      .then((list) => {
        saved = prioritized(list);
        for (const t of saved) {
          summaries.set(t.key, t.summary);
        }
      })
      .catch(() => undefined);
    void loadSuggestions();
    void loadManualLogs();
  }
  if (aiEnabled) {
    void resumeAi();
  }
}

function fromDraft(d: Draft): Row {
  return {
    id: String(nextId++),
    day: d.day,
    sourceKey: d.sourceKey,
    // Unassigned buckets (e.g. a PR without a key) need an issue picked first.
    targetKey: isUnassignedKey(d.sourceKey) ? '' : d.sourceKey,
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

/** Asks Jira for an issue's title and estimate once; rows needing the same key share the answer. */
function wantInfo(key: string): void {
  if (!key || requested.has(key)) {
    return;
  }
  requested.add(key);
  waiting.push(key);
  if (waiting.length === 1) {
    queueMicrotask(() => void loadInfo());
  }
}

async function loadInfo(): Promise<void> {
  const keys = waiting;
  waiting = [];
  const found = await call('issues', { keys }).catch(() => ({}) as Awaited<ReturnType<typeof call<'issues'>>>);
  for (const [key, info] of Object.entries(found)) {
    summaries.set(key, info?.summary ?? null);
    estimates.set(key, info?.estimate);
  }
  updateSubtitles();
}

/** Logged time changed the estimate in Jira, so read it again. */
function refreshInfo(keys: string[]): void {
  for (const key of keys) {
    requested.delete(key);
    wantInfo(key);
  }
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
  renderDate();
  daysEl.replaceChildren();
  const day = selected;
  const dayRows = rows.filter((r) => r.kind !== 'suggested' && r.day === day);
  const suggested = day === today ? rows.filter((r) => r.kind === 'suggested' && !r.done) : [];
  const caughtUp = day === today && dayRows.length === 0 && suggested.length === 0 && $('setup').hidden && !aiEnabled;
  $('empty').hidden = !caughtUp;

  const actions = el('span', { class: 'title-actions' });
  if (aiEnabled) {
    actions.append(aiButton(day));
  }
  const add = el('button', { class: 'btn-link', id: 'add-entry', type: 'button' }, 'Add entry');
  add.addEventListener('click', () => addEntry(day));
  actions.append(add);
  daysEl.append(el('h2', { class: 'section-title' }, el('span', { id: 'day-label' }), actions));
  if (aiComposerDay === day && aiBusyDay === null) {
    daysEl.append(aiComposer(day));
  }
  if (dayRows.length > 0) {
    daysEl.append(el('div', { class: 'group' }, ...dayRows.map(renderRow)));
  } else if (aiComposerDay !== day && !caughtUp) {
    daysEl.append(
      el(
        'p',
        { class: 'footnote' },
        aiEnabled ? 'Nothing tracked on this day. Add an entry, or describe the day and AI drafts the entries.' : 'Nothing tracked on this day. Add an entry for work you did away from the browser.',
      ),
    );
  }
  if (suggested.length > 0) {
    daysEl.append(
      el('h2', { class: 'section-title' }, 'Touched in Jira today'),
      el('div', { class: 'group' }, ...suggested.map(renderRow)),
      el('p', { class: 'footnote' }, 'No time was tracked on these. Add some if you worked on them away from the browser.'),
    );
  }
  renderTotals();
}

/** Switches the review to another day, keeping it in the address so reopening lands there. */
function select(day: string): void {
  if (day > today) {
    day = today;
  }
  if (day === selected) {
    return;
  }
  selected = day;
  openId = null;
  if (aiComposerDay !== day) {
    aiComposerDay = null;
  }
  setParams(day === today ? {} : { day });
  render();
  void loadWeek();
}

function renderDate(): void {
  $('date').textContent = new Date(dayStart(selected)).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  $<HTMLButtonElement>('next-day').disabled = selected >= today;
  $('to-today').hidden = selected === today;
}

/** Monday-first week around the day on show: Jira's logged time per day and a dot where time waits to be logged. */
function renderWeek(): void {
  const week = $('week');
  week.replaceChildren();
  const pending = pendingPerDay();
  for (const day of weekOf(selected)) {
    const d = new Date(dayStart(day));
    const logged = loggedPerDay.get(day) ?? 0;
    const waiting = pending.get(day) ?? 0;
    const classes = ['cal-day'];
    if (day === today) classes.push('today');
    if (day === selected) classes.push('selected');
    if (day > today) classes.push('future');
    if (d.getDay() === 0 || d.getDay() === 6) classes.push('weekend');
    if (waiting > 0) classes.push('pending');
    const label = [
      d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }),
      logged ? `${formatDuration(logged * 1000)} logged` : '',
      waiting ? `${formatDuration(waiting * 1000)} to log` : '',
    ].filter(Boolean);
    const cell = el(
      'button',
      { class: classes.join(' '), type: 'button', 'data-day': day, 'aria-label': label.join(', '), 'aria-pressed': String(day === selected) },
      el('span', { class: 'week-name' }, d.toLocaleDateString(undefined, { weekday: 'short' })),
      el('span', { class: 'cal-num' }, String(d.getDate())),
      el('span', { class: 'cal-time' }, logged ? formatDuration(logged * 1000) : ''),
      el('span', { class: 'cal-bar', style: `--fill: ${Math.min(1, logged / (8 * 3600))}` }),
    ) as HTMLButtonElement;
    cell.disabled = day > today;
    cell.addEventListener('click', () => select(day));
    week.append(cell);
  }

  // Time waiting on other days, so switching days never hides it.
  const others = [...pending].filter(([day]) => day !== selected).sort(([a], [b]) => b.localeCompare(a));
  const hint = $('other-days');
  hint.replaceChildren();
  hint.hidden = others.length === 0;
  if (others.length > 0) {
    hint.append('Also to log: ');
    others.forEach(([day, seconds], i) => {
      const link = el('button', { class: 'btn-link', type: 'button' }, `${dayLabel(day)} ${formatDuration(seconds * 1000)}`);
      link.addEventListener('click', () => select(day));
      hint.append(...(i > 0 ? [' · '] : []), link);
    });
  }
}

/** Unlogged seconds per day across everything the review knows about. */
function pendingPerDay(): Map<string, number> {
  const result = new Map<string, number>();
  for (const r of rows) {
    const seconds = parseDuration(r.duration) ?? 0;
    if (!r.done && r.kind !== 'suggested' && seconds > 0) {
      result.set(r.day, (result.get(r.day) ?? 0) + seconds);
    }
  }
  return result;
}

/** Reads what Jira already has for the week on show, once per week. */
async function loadWeek(): Promise<void> {
  const days = weekOf(selected);
  if (!jiraReady || weekShown === days[0]) {
    return;
  }
  weekShown = days[0];
  const token = ++weekToken;
  const logs = await call('logged', { from: dayStart(days[0]), to: dayStart(shiftDay(days[6], 1)) }).catch(() => []);
  if (token !== weekToken) {
    return;
  }
  loggedPerDay = new Map();
  for (const log of logs) {
    const day = localDay(log.started);
    loggedPerDay.set(day, (loggedPerDay.get(day) ?? 0) + log.seconds);
  }
  renderWeek();
}

/** A blank entry for work nothing tracked, placed after the day's other entries. */
function addEntry(day: string): void {
  const started = Math.max(
    dayStart(day) + 9 * 3_600_000,
    ...rows.filter((r) => r.day === day && r.kind !== 'suggested').map((r) => r.started + (parseDuration(r.duration) ?? 0) * 1000),
  );
  const row: Row = {
    id: String(nextId++),
    day,
    sourceKey: `manual:${nextId}`,
    targetKey: '',
    rawMs: 0,
    duration: formatDuration(roundMinutes * 60_000 * 4),
    started,
    comment: '',
    kind: 'added',
    done: false,
  };
  rows.push(row);
  openId = row.id;
  render();
  document.querySelector<HTMLInputElement>(`.row[data-id="${row.id}"] .search input`)?.focus();
}

function renderTotals(): void {
  const open = rows.filter((r) => r.day === selected && !r.done && (r.kind === 'tracked' || parseDuration(r.duration)));
  const seconds = open.reduce((sum, r) => sum + (parseDuration(r.duration) ?? 0), 0);
  renderWeek();
  $('day-label').textContent = `${dayLabel(selected)}${seconds > 0 ? ` · ${formatDuration(seconds * 1000)}` : ''}`;
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
    rowText(row),
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

  if (row.question && !row.done) {
    container.append(renderQuestion(row));
  }
  if (row.id === openId && !row.done) {
    container.append(renderEditor(row));
  } else if (row.note) {
    container.append(el('div', { class: 'editor' }, el('span', { class: `note ${row.note.level}` }, row.note.text)));
  }
  return container;
}

function renderEditor(row: Row): HTMLElement {
  const issue = issuePicker({
    current: () => row.targetKey,
    saved: () => saved,
    onType: (key) => {
      row.targetKey = key;
      if (row.note?.level === 'ai') {
        row.note = undefined;
      }
    },
    onPick: (r) => {
      row.targetKey = r.key;
      summaries.set(r.key, r.summary);
      if (row.question) {
        answerQuestion(row, r.key);
      }
      updateHeader(row);
    },
    onBlur: () => updateHeader(row),
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

  const discard = el('button', { class: 'btn btn-danger', type: 'button' }, { tracked: 'Discard', suggested: 'Hide', added: 'Remove' }[row.kind]);
  discard.addEventListener('click', () => void discardRow(row));
  const split = el('button', { class: 'btn btn-plain', type: 'button' }, 'Split');
  split.addEventListener('click', () => splitRow(row));
  split.hidden = row.kind !== 'tracked';
  const log = el('button', { class: 'btn btn-primary', type: 'button' }, 'Log');
  log.addEventListener('click', () => void logRows([row]));

  return el(
    'div',
    { class: 'editor' },
    el('div', { class: 'field-row' }, issue, el('div', { class: 'stepper' }, minus, duration, plus)),
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
  node.querySelector('.row-main .row-text')!.replaceWith(rowText(row));
  node.querySelector('.row-time')!.textContent = row.duration || 'Add';
  renderTotals();
}

function updateRow(row: Row): void {
  const node = document.querySelector(`.row[data-id="${row.id}"]`);
  node?.replaceWith(renderRow(row));
}

function updateSubtitles(): void {
  for (const row of rows) {
    document.querySelector(`.row[data-id="${row.id}"] .row-main .row-text`)?.replaceWith(rowText(row));
  }
}

/** Key and Jira title, what the time was for, and the estimate bar with this entry's time added. */
function rowText(row: Row): HTMLElement {
  const key = row.targetKey;
  wantInfo(key);
  const pending = row.done ? 0 : (parseDuration(row.duration) ?? 0);
  return el(
    'div',
    { class: 'row-text' },
    key ? ticketHeading(key, summaries.get(key)) : ticketHeading('Unassigned', null, 'unassigned'),
    el('div', { class: 'row-sub' }, subtitle(row)),
    key ? estimateBar(estimateProgress(estimates.get(key), pending), key) : '',
  );
}

function subtitle(row: Row): string {
  if (!row.targetKey) {
    // For an unassigned PR the comment is its title, which says what the time was.
    return (isUnassignedKey(row.sourceKey) && row.comment.split('\n')[0]) || 'Choose the issue this time belongs to';
  }
  if (summaries.get(row.targetKey) === null) {
    return `${row.targetKey} wasn't found in Jira`;
  }
  // The title sits beside the key, so this line says what the time was for.
  return row.comment.split('\n')[0];
}

/** Cursor's question, with your tickets as one-click answers. */
function renderQuestion(row: Row): HTMLElement {
  const { ask } = row.question!;
  const options = ask.options.map((o) => {
    const button = el(
      'button',
      { class: 'ask-option', type: 'button', 'aria-pressed': String(row.targetKey === o.key) },
      el('strong', {}, `${o.key}${row.targetKey === o.key ? ' · current guess' : ''}`),
      o.summary ? el('span', {}, o.summary) : '',
      o.why ? el('em', {}, o.why) : '',
    );
    button.addEventListener('click', () => {
      row.targetKey = o.key;
      if (o.summary) {
        summaries.set(o.key, o.summary);
      }
      answerQuestion(row, o.key);
      render();
    });
    return button;
  });
  const other = el('button', { class: 'btn btn-plain', type: 'button' }, 'Another issue…');
  other.addEventListener('click', () => {
    openId = row.id;
    render();
    document.querySelector<HTMLInputElement>(`.row[data-id="${row.id}"] .search input`)?.focus();
  });
  const skip = el('button', { class: 'btn btn-plain', type: 'button' }, 'Skip');
  skip.addEventListener('click', () => {
    answerQuestion(row, '');
    render();
  });
  return el(
    'div',
    { class: 'ask', role: 'group', 'aria-label': 'Question from AI' },
    el('p', { class: 'ask-q' }, sparkle(), ask.question),
    el('div', { class: 'ask-options' }, ...options),
    el('div', { class: 'actions' }, other, el('span', { class: 'spacer' }), skip),
  );
}

/** Closes the question and remembers the answer, so reopening the popup doesn't ask again. */
function answerQuestion(row: Row, key: string): void {
  const q = row.question;
  if (!q) {
    return;
  }
  row.question = undefined;
  if (key) {
    row.note = { text: `You picked ${key}`, level: 'ai' };
  }
  void call('answerAiQuestion', { at: q.at, index: q.index, key }).catch(() => undefined);
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
      loggedPerDay.set(row.day, (loggedPerDay.get(row.day) ?? 0) + (parseDuration(row.duration) ?? 0));
      consumeAi(row);
      if (openId === row.id) {
        openId = null;
      }
    } catch (err) {
      row.note = { text: (err as Error).message, level: 'error' };
    }
  }
  render();
  refreshInfo([...new Set(rows.filter((r) => r.done && r.targetKey).map((r) => r.targetKey))]);
  if (logged > 0) {
    toast(`Logged ${logged} ${logged === 1 ? 'entry' : 'entries'} to Jira`);
  }
}

async function logAll(): Promise<void> {
  const button = $<HTMLButtonElement>('log-all');
  button.disabled = true;
  try {
    await logRows(rows.filter((r) => r.day === selected && !r.done && r.targetKey && parseDuration(r.duration)));
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
  consumeAi(row);
  rows = rows.filter((r) => r.id !== row.id);
  openId = null;
  render();
}

function consumeAi(row: Row): void {
  if (row.ai) {
    void call('consumeAiEntry', row.ai).catch(() => undefined);
  }
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

// ---------- Fill in with AI ----------

function aiButton(day: string): HTMLElement {
  const busy = aiBusyDay === day;
  const button = el(
    'button',
    {
      class: `ai-button${busy ? ' busy' : ''}`,
      type: 'button',
      title: 'Ask Cursor to write comments, match unassigned time and add what you describe',
      'aria-expanded': String(aiComposerDay === day),
    },
    sparkle(),
    busy ? 'Thinking…' : 'Fill in with AI',
  ) as HTMLButtonElement;
  button.disabled = aiBusyDay !== null;
  button.addEventListener('click', () => {
    aiComposerDay = aiComposerDay === day ? null : day;
    render();
    document.querySelector<HTMLTextAreaElement>('.ai-composer textarea')?.focus();
  });
  return button;
}

/** The "describe your day" box. Empty is fine: AI then only fills in tracked rows. */
function aiComposer(day: string): HTMLElement {
  const text = el('textarea', {
    rows: '3',
    'aria-label': 'Describe your day',
    placeholder: 'Optional: what did you do? e.g. "Standup 15m, 1h pairing with Sam on PAY-12, reviewed the payout PR, sprint planning 45m"',
  }) as HTMLTextAreaElement;
  text.value = loadSummaryDraft(day);
  text.addEventListener('input', () => saveSummaryDraft(day, text.value));
  const hasRows = rows.some((r) => r.day === day && r.kind !== 'suggested' && !r.done);
  const go = el('button', { class: 'btn btn-primary', type: 'button' }, 'Fill in') as HTMLButtonElement;
  const sync = () => (go.disabled = !hasRows && !text.value.trim());
  text.addEventListener('input', sync);
  sync();
  go.addEventListener('click', () => void fillInWithAi(day, text.value));
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !go.disabled) {
      void fillInWithAi(day, text.value);
    }
  });
  const cancel = el('button', { class: 'btn btn-plain', type: 'button' }, 'Cancel');
  cancel.addEventListener('click', () => {
    aiComposerDay = null;
    render();
  });
  return el(
    'div',
    { class: 'card ai-composer' },
    text,
    el(
      'p',
      { class: 'footnote' },
      hasRows
        ? 'Cursor writes comments for tracked time, uses times you mention, and adds entries for work nothing tracked. You review everything before logging.'
        : 'Cursor turns this into entries with times and comments. You review everything before logging.',
    ),
    el('div', { class: 'actions' }, el('span', { class: 'spacer' }), cancel, go),
  );
}

async function fillInWithAi(day: string, summary = ''): Promise<void> {
  aiBusyDay = day;
  aiComposerDay = null;
  render();
  try {
    const result = await call('aiSuggest', { day, summary });
    const at = (await call('aiState').catch(() => undefined))?.at ?? Date.now();
    const changed = applyResult(day, result.rows, result.added, at, [], result.questions);
    const asked = rows.filter((r) => r.question).length;
    toast(
      asked > 0
        ? `Filled in ${changed} ${changed === 1 ? 'entry' : 'entries'}. ${asked} ${asked === 1 ? 'question needs' : 'questions need'} your answer.`
        : changed > 0
          ? `Filled in ${changed} ${changed === 1 ? 'entry' : 'entries'}. Check them, then log.`
          : 'Cursor had nothing to add.',
    );
  } catch (err) {
    aiComposerDay = day;
    toast((err as Error).message);
  } finally {
    aiBusyDay = null;
    render();
  }
}

/**
 * Puts an AI answer into the day: comments and times on open rows, an issue
 * for unassigned rows only, and new rows for work from the day summary.
 */
function applyResult(
  day: string,
  suggestions: AiSuggestion[],
  added: AiNewEntry[] = [],
  at = 0,
  consumed: number[] = [],
  questions: AiQuestion[] = [],
  answers: Record<number, string> = {},
): number {
  let changed = 0;
  for (const s of suggestions) {
    const row = rows.find((r) => r.day === day && r.kind === 'tracked' && !r.done && r.sourceKey === s.id);
    if (!row) {
      continue;
    }
    const notes: string[] = [];
    if (s.comment) {
      row.comment = s.comment;
    }
    if (s.key && !row.targetKey) {
      row.targetKey = s.key;
      if (s.summary) {
        summaries.set(s.key, s.summary);
      }
      notes.push(`Matched by AI${s.reason ? `: ${s.reason}` : ''}`);
    }
    if (s.minutes) {
      const tracked = row.duration;
      row.duration = formatDuration(roundToStep(s.minutes * 60_000, roundMinutes) * 1000);
      if (row.duration !== tracked) {
        notes.push(`Time from your summary (tracked ${tracked})`);
      }
    }
    if (notes.length > 0) {
      row.note = { text: notes.join(' · '), level: 'ai' };
    }
    changed++;
  }

  // A fresh answer replaces entries a previous one added and you haven't logged.
  rows = rows.filter((r) => !(r.kind === 'added' && r.day === day && !r.done));
  // Added entries go after the day's tracked work so worklogs don't overlap.
  let started = Math.max(
    dayStart(day) + 9 * 3_600_000,
    ...rows.filter((r) => r.day === day && r.kind === 'tracked').map((r) => r.started + (parseDuration(r.duration) ?? 0) * 1000),
  );
  added.forEach((entry, index) => {
    if (consumed.includes(index)) {
      return;
    }
    const seconds = roundToStep(entry.minutes * 60_000, roundMinutes);
    if (entry.key && entry.summary) {
      summaries.set(entry.key, entry.summary);
    }
    rows.push({
      id: String(nextId++),
      day,
      sourceKey: `ai:${index}`,
      targetKey: entry.key ?? '',
      rawMs: 0,
      duration: formatDuration(seconds * 1000),
      started,
      comment: entry.comment,
      kind: 'added',
      done: false,
      ai: { at, index },
      note: { text: `Added from your summary${entry.reason ? `: ${entry.reason}` : ''}`, level: 'ai' },
    });
    started += seconds * 1000;
    changed++;
  });

  // Questions sit on the row they're about; an answer you already gave is applied instead.
  questions.forEach((ask, index) => {
    const added = /^added:(\d+)$/.exec(ask.target);
    const row = rows.find((r) =>
      r.day === day && !r.done && (added ? r.kind === 'added' && r.ai?.at === at && r.ai.index === Number(added[1]) : r.kind === 'tracked' && r.sourceKey === ask.target),
    );
    if (!row) {
      return;
    }
    const answer = answers[index];
    if (answer === undefined) {
      row.question = { at, index, ask };
    } else if (answer) {
      row.targetKey = answer;
      row.note = { text: `You picked ${answer}`, level: 'ai' };
    }
  });
  return changed;
}

/** Picks up a run that finished, or is still going, after the popup was closed. */
async function resumeAi(): Promise<void> {
  let state = await call('aiState').catch(() => undefined);
  if (state?.status === 'running' && Date.now() - state.at < 4 * 60_000) {
    aiBusyDay = state.day;
    render();
    while (state?.status === 'running' && Date.now() - state.at < 4 * 60_000) {
      await new Promise((r) => setTimeout(r, 2000));
      state = await call('aiState').catch(() => undefined);
    }
    aiBusyDay = null;
  }
  if (state?.status === 'done' && Date.now() - state.at < AI_FRESH_MS) {
    applyResult(state.day, state.suggestions ?? [], state.added ?? [], state.at, state.consumed ?? [], state.questions ?? [], state.answers ?? {});
  }
  render();
}

/** Unsent day summaries survive the popup closing; they stay on this computer only. */
function loadSummaryDraft(day: string): string {
  try {
    return localStorage.getItem(`summary:${day}`) ?? '';
  } catch {
    return '';
  }
}

function saveSummaryDraft(day: string, text: string): void {
  try {
    if (text.trim()) {
      localStorage.setItem(`summary:${day}`, text);
    } else {
      localStorage.removeItem(`summary:${day}`);
    }
  } catch {
    // Storage blocked; the draft just won't survive closing the popup.
  }
}

// ---------- Helpers ----------

function shiftDay(day: string, by: number): string {
  const d = new Date(dayStart(day));
  d.setDate(d.getDate() + by);
  return localDay(d.getTime());
}

/** The seven days, Monday first, of the week holding `day`. */
function weekOf(day: string): string[] {
  const d = new Date(dayStart(day));
  const monday = shiftDay(day, -((d.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => shiftDay(monday, i));
}

/** A YYYY-MM-DD day from the address, if real and not in the future. */
function validDay(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value) || localDay(dayStart(value)) !== value) {
    return null;
  }
  return value > today ? today : value;
}

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

function sparkle(): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M12 2.5c.4 3.9 2.6 6.1 6.5 6.5-3.9.4-6.1 2.6-6.5 6.5-.4-3.9-2.6-6.1-6.5-6.5 3.9-.4 6.1-2.6 6.5-6.5zM18.5 14c.2 2 1.3 3.1 3.3 3.3-2 .2-3.1 1.3-3.3 3.3-.2-2-1.3-3.1-3.3-3.3 2-.2 3.1-1.3 3.3-3.3z');
  svg.append(path);
  return svg;
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
