import type { AiNewEntry, AiQuestion, AiSuggestion } from '../ai';
import { isUnassignedKey } from '../classify';
import { roundToStep } from '../core/drafts';
import { prioritized, type Ticket } from '../core/tickets';
import { dayStart, formatDuration, parseDuration } from '../core/time';
import type { Draft } from '../core/types';
import type { IssueSummary } from '../jira';
import { call } from '../messages';
import { el, toast } from './dom';
import { goTo, mountTabs } from './nav';

interface Row {
  id: string;
  day: string;
  sourceKey: string;
  targetKey: string;
  rawMs: number;
  duration: string;
  started: number;
  comment: string;
  /** tracked: measured by the browser; suggested: touched in Jira today; added: from your day summary. */
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
let nextId = 1;
let aiEnabled = false;
/** Day Cursor is currently filling in, if any. */
let aiBusyDay: string | null = null;
/** Day whose "describe your day" box is open, if any. */
let aiComposerDay: string | null = null;
const summaries = new Map<string, string | null>();
/** Your ticket list, flagged first; offered first in the issue picker. */
let saved: Ticket[] = [];

/** Saved AI suggestions older than this aren't re-applied when the popup opens. */
const AI_FRESH_MS = 12 * 3_600_000;

$('setup-button').addEventListener('click', () => goTo('options.html'));
$('log-all').addEventListener('click', () => void logAll());

void load();

async function load(): Promise<void> {
  const [state, settings] = await Promise.all([call('state'), call('getSettings')]);
  roundMinutes = settings.roundMinutes;
  aiEnabled = !!settings.cursorApiKey && !state.setupMessage;
  today = state.today;

  $('date').textContent = new Date(dayStart(today)).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
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
    void loadSummaries(rows.map((r) => r.targetKey));
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
  const tracked = rows.filter((r) => r.kind !== 'suggested');
  const suggested = rows.filter((r) => r.kind === 'suggested' && !r.done);
  const days = [...new Set(tracked.map((r) => r.day))];
  // With AI on, today is always there so you can describe a day nothing tracked.
  if (aiEnabled && !days.includes(today)) {
    days.unshift(today);
  }

  for (const day of days) {
    const dayRows = tracked.filter((r) => r.day === day);
    const total = dayRows.filter((r) => !r.done).reduce((sum, r) => sum + (parseDuration(r.duration) ?? 0), 0);
    const title = el('h2', { class: 'section-title' }, el('span', {}, `${dayLabel(day)}${total > 0 ? ` · ${formatDuration(total * 1000)}` : ''}`));
    if (aiEnabled && (day === today || dayRows.some((r) => !r.done))) {
      title.append(aiButton(day));
    }
    daysEl.append(title);
    if (aiComposerDay === day && aiBusyDay === null) {
      daysEl.append(aiComposer(day));
    }
    if (dayRows.length > 0) {
      daysEl.append(el('div', { class: 'group' }, ...dayRows.map(renderRow)));
    } else if (aiComposerDay !== day) {
      daysEl.append(el('p', { class: 'footnote' }, 'Nothing tracked yet. Describe your day and AI drafts the entries.'));
    }
  }
  if (suggested.length > 0) {
    daysEl.append(
      el('h2', { class: 'section-title' }, 'Touched in Jira today'),
      el('div', { class: 'group' }, ...suggested.map(renderRow)),
      el('p', { class: 'footnote' }, 'No time was tracked on these. Add some if you worked on them away from the browser.'),
    );
  }

  const open = rows.filter((r) => !r.done && r.kind !== 'suggested');
  $('empty').hidden = open.length > 0 || suggested.length > 0 || !$('setup').hidden || aiEnabled;
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
  // Issue picker
  const issue = el('input', { type: 'text', value: row.targetKey, placeholder: 'Search Jira issues', 'aria-label': 'Jira issue' }) as HTMLInputElement;
  const results = el('ul', { class: 'results', hidden: '' });
  let timer = 0;
  const showResults = (found: IssueSummary[]) => {
    const flagged = new Set(saved.filter((t) => t.flagged).map((t) => t.key));
    results.replaceChildren(
      ...found.map((r) => {
        const li = el('li', { tabindex: '0', class: flagged.has(r.key) ? 'flagged' : '' }, el('strong', {}, r.key), r.summary);
        const pick = () => {
          row.targetKey = r.key;
          summaries.set(r.key, r.summary);
          issue.value = r.key;
          results.hidden = true;
          if (row.question) {
            answerQuestion(row, r.key);
          }
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
  };
  // Your ticket list comes first: on focus before you type, and on top of Jira's matches after.
  const savedMatching = (query: string) => {
    const q = query.trim().toLowerCase();
    return saved.filter((t) => !q || t.key.toLowerCase().includes(q) || t.summary.toLowerCase().includes(q)).slice(0, 8);
  };
  issue.addEventListener('focus', () => {
    if (!issue.value.trim() || issue.value.trim() === row.targetKey) {
      showResults(savedMatching(''));
    }
  });
  issue.addEventListener('input', () => {
    row.targetKey = issue.value.trim().toUpperCase();
    if (row.note?.level === 'ai') {
      row.note = undefined;
    }
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
  if (row.kind === 'added') {
    // What you described is the point of an added row; the issue name is in the editor.
    return row.comment.split('\n')[0] || summaries.get(row.targetKey) || '';
  }
  if (!row.targetKey) {
    // For an unassigned PR the comment is its title, which says what the time was.
    return (isUnassignedKey(row.sourceKey) && row.comment.split('\n')[0]) || 'Choose the issue this time belongs to';
  }
  const summary = summaries.get(row.targetKey);
  if (summary === null) {
    return `${row.targetKey} wasn't found in Jira`;
  }
  return summary ?? row.comment.split('\n')[0];
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
      consumeAi(row);
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
