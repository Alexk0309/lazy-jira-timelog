import { call } from '../messages';
import type { Settings } from '../storage';
import { toast } from './dom';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const siteUrl = $<HTMLInputElement>('siteUrl');
const email = $<HTMLInputElement>('email');
const apiToken = $<HTMLInputElement>('apiToken');
const reminderTime = $<HTMLInputElement>('reminderTime');
const idleMinutes = $<HTMLSelectElement>('idleMinutes');
const minSessionMinutes = $<HTMLSelectElement>('minSessionMinutes');
const result = $('connect-result');
const cursorApiKey = $<HTMLInputElement>('cursorApiKey');
const cursorModel = $<HTMLSelectElement>('cursorModel');
const cursorResult = $('cursor-result');

const CURSOR_ORIGIN = 'https://api.cursor.com';

let useToken = false;

void init();

async function init(): Promise<void> {
  const s = await call('getSettings');
  siteUrl.value = s.siteUrl;
  email.value = s.email;
  apiToken.value = s.apiToken;
  reminderTime.value = s.reminderTime;
  selectValue(idleMinutes, s.idleMinutes);
  selectValue(minSessionMinutes, s.minSessionMinutes);
  setRounding(s.roundMinutes);
  setAuth(!!(s.email && s.apiToken));
  cursorApiKey.value = s.cursorApiKey;
  if (s.cursorModel) {
    cursorModel.append(new Option(s.cursorModel, s.cursorModel));
    cursorModel.value = s.cursorModel;
  }
}

function selectValue(select: HTMLSelectElement, value: number): void {
  if (![...select.options].some((o) => o.value === String(value))) {
    select.append(new Option(`${value} min`, String(value)));
  }
  select.value = String(value);
}

async function save(patch: Partial<Settings>, message = 'Saved'): Promise<void> {
  await call('saveSettings', patch);
  toast(message);
}

function setAuth(token: boolean): void {
  useToken = token;
  $('auth-session').setAttribute('aria-pressed', String(!token));
  $('auth-token').setAttribute('aria-pressed', String(token));
  document.querySelectorAll<HTMLElement>('.token-only').forEach((n) => (n.hidden = !token));
  $('auth-help').textContent = token
    ? 'Uses your email and a personal API token.'
    : 'Uses the Jira session already open in this browser.';
}

function setRounding(value: number): void {
  document.querySelectorAll<HTMLButtonElement>('#rounding button').forEach((b) => {
    b.setAttribute('aria-pressed', String(Number(b.dataset.value) === value));
  });
}

siteUrl.addEventListener('change', async () => {
  let value = siteUrl.value.trim().replace(/\/+$/, '');
  if (value && !/^https?:\/\//.test(value)) {
    value = `https://${value}`;
  }
  siteUrl.value = value;
  if (value && !(await ensureHostAccess(value))) {
    toast('Access to that site was not granted');
    return;
  }
  await save({ siteUrl: value });
});

$('auth-session').addEventListener('click', async () => {
  setAuth(false);
  await save({ email: '', apiToken: '' }, 'Using your browser session');
});
$('auth-token').addEventListener('click', () => setAuth(true));
email.addEventListener('change', () => void save({ email: email.value.trim() }));
apiToken.addEventListener('change', () => void save({ apiToken: apiToken.value.trim() }));

reminderTime.addEventListener('change', () => void save({ reminderTime: reminderTime.value }));
idleMinutes.addEventListener('change', () => void save({ idleMinutes: Number(idleMinutes.value) }));
minSessionMinutes.addEventListener('change', () => void save({ minSessionMinutes: Number(minSessionMinutes.value) }));
document.querySelectorAll<HTMLButtonElement>('#rounding button').forEach((b) =>
  b.addEventListener('click', () => {
    setRounding(Number(b.dataset.value));
    void save({ roundMinutes: Number(b.dataset.value) });
  }),
);

cursorApiKey.addEventListener('change', async () => {
  const key = cursorApiKey.value.trim();
  if (key && !(await ensureHostAccess(CURSOR_ORIGIN))) {
    toast('Access to Cursor was not granted');
    return;
  }
  await save({ cursorApiKey: key }, key ? 'Cursor key saved' : 'AI turned off');
});
cursorModel.addEventListener('change', () => void save({ cursorModel: cursorModel.value }));

$('testCursor').addEventListener('click', async () => {
  if (!cursorApiKey.value.trim()) {
    showCursorResult('Paste your Cursor API key first.', 'error');
    return;
  }
  showCursorResult('Checking…', '');
  try {
    const { message, models } = await call('testCursor');
    const current = cursorModel.value;
    cursorModel.replaceChildren(new Option('Cursor default', ''), ...models.map((m) => new Option(m.displayName, m.id)));
    cursorModel.value = models.some((m) => m.id === current) ? current : '';
    showCursorResult(message, 'ok');
  } catch (err) {
    showCursorResult((err as Error).message, 'error');
  }
});

function showCursorResult(text: string, level: string): void {
  cursorResult.textContent = text;
  cursorResult.className = `note ${level === 'ok' ? '' : level}`;
}

$('connect').addEventListener('click', async () => {
  if (useToken && (!email.value.trim() || !apiToken.value.trim())) {
    showResult('Add your email and API token first.', 'error');
    return;
  }
  showResult('Checking…', '');
  try {
    showResult(await call('connect'), 'ok');
  } catch (err) {
    showResult((err as Error).message, 'error');
  }
});

$('addSite').addEventListener('click', async () => {
  const input = $<HTMLInputElement>('extraSite');
  const host = input.value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!host) {
    return;
  }
  if (await ensureHostAccess(`https://${host}`)) {
    input.value = '';
    toast(`${host} added`);
  } else {
    toast('Access to that site was not granted');
  }
});

function showResult(text: string, level: string): void {
  result.textContent = text;
  result.className = `note ${level === 'ok' ? '' : level}`;
}

/** Self-hosted Jira or GitLab needs explicit access; the browser shows its own prompt. */
async function ensureHostAccess(url: string): Promise<boolean> {
  let origin: string;
  try {
    const u = new URL(url);
    origin = `${u.protocol}//${u.hostname}/*`;
  } catch {
    return false;
  }
  if (await chrome.permissions.contains({ origins: [origin] })) {
    return true;
  }
  return chrome.permissions.request({ origins: [origin] });
}
