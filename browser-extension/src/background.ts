import { isUnassignedKey } from './classify';
import { formatDuration } from './core/time';
import type { Api, Reply, Request } from './messages';
import { Service } from './service';
import { Store, type KeyValue } from './storage';
import { Tracker, type Tracking } from './tracker';

const TICK_ALARM = 'tick';

const store = new Store(chrome.storage.local as unknown as KeyValue);
const service = new Service(store);
const tracker = new Tracker({
  store,
  now: Date.now,
  idleState: (seconds) => chrome.idle.queryState(seconds) as Promise<'active' | 'idle' | 'locked'>,
  activeTab: async () => {
    const win = await chrome.windows.getLastFocused({ populate: false }).catch(() => undefined);
    if (!win?.focused || win.id === undefined) {
      return null;
    }
    const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
    // url and title are only visible on sites the extension has host access to.
    return tab ? { url: tab.url, title: tab.title } : null;
  },
});

let tracking: Tracking | null = null;

async function tick(signal: string): Promise<void> {
  try {
    tracking = await tracker.tick(signal);
    await refreshBadge();
  } catch (err) {
    console.error('[timelog] tick failed', err);
  }
}

async function refreshBadge(): Promise<void> {
  const { due, todayMs } = await service.reminderDue();
  const state = await service.drafts();
  const totalMs = state.reduce((sum, d) => sum + d.seconds * 1000, 0);
  const hours = totalMs / 3_600_000;
  await chrome.action.setBadgeText({ text: totalMs > 0 ? (hours >= 1 ? `${Math.round(hours)}h` : `${Math.round(totalMs / 60000)}m`) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#007AFF' });
  await chrome.action.setTitle({
    title: totalMs > 0 ? `${formatDuration(totalMs)} to log${tracking ? ` · tracking ${isUnassignedKey(tracking.key) ? 'a pull request' : tracking.key}` : ''}` : 'All logged',
  });
  if (due) {
    chrome.notifications.create('reminder', {
      type: 'basic',
      iconUrl: 'icons/128.png',
      title: 'Time to log your day',
      message: `${formatDuration(todayMs)} is ready to send to Jira. It takes one click.`,
      priority: 0,
    });
  }
}

function ensureAlarm(): void {
  chrome.alarms.get(TICK_ALARM, (alarm) => {
    if (!alarm) {
      chrome.alarms.create(TICK_ALARM, { periodInMinutes: 0.5 });
    }
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  ensureAlarm();
  if (details.reason === 'install') {
    void chrome.runtime.openOptionsPage();
  }
  void store.settings().then((s) => store.prune(s.retentionDays));
});
chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  void store.settings().then((s) => store.prune(s.retentionDays));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK_ALARM) {
    void tick('tick');
  }
});
chrome.tabs.onActivated.addListener(() => void tick('tab'));
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  if (tab.active && (change.url || change.title)) {
    void tick('navigate');
  }
});
chrome.windows.onFocusChanged.addListener(() => void tick('focus'));
chrome.idle.onStateChanged.addListener(() => void tick('idle'));
chrome.notifications.onClicked.addListener((id) => {
  if (id === 'reminder') {
    void chrome.tabs.create({ url: chrome.runtime.getURL('review.html') });
    chrome.notifications.clear(id);
  }
});

type Handlers = { [K in keyof Api]: (payload: Api[K]['req']) => Promise<Api[K]['res']> };

const handlers: Handlers = {
  state: async () => ({ ...(await service.state()), tracking }),
  post: async (p) => {
    const id = await service.post(p);
    await refreshBadge();
    return id;
  },
  discard: async (p) => {
    await service.discard(p.day, p.sourceKey, p.rawMs);
    await refreshBadge();
  },
  search: (p) => service.search(p.query),
  summaries: (p) => service.issueSummaries(p.keys),
  issues: (p) => service.issues(p.keys),
  manualLogs: (p) => service.manualLogs(p.items),
  suggestions: () => service.suggestions(),
  getSettings: () => store.settings(),
  saveSettings: async (p) => {
    const next = await store.saveSettings(p);
    await refreshBadge();
    return next;
  },
  connect: () => service.connect(),
  testCursor: () => service.testCursor(),
  // Any extension API call keeps the worker alive while Cursor thinks.
  aiSuggest: (p) => service.aiSuggest(p.day, p.summary, () => chrome.runtime.getPlatformInfo()),
  aiState: () => service.aiState(),
  consumeAiEntry: (p) => service.consumeAiEntry(p.at, p.index),
  answerAiQuestion: (p) => service.answerAiQuestion(p.at, p.index, p.key),
  tickets: () => service.tickets(),
  addTickets: (p) => service.addTickets(p.text),
  addAssigned: () => service.addAssigned(),
  refreshTickets: () => service.refreshTickets(),
  flagTickets: (p) => service.flagTickets(p.keys, p.flagged),
  removeTickets: (p) => service.removeTickets(p.keys),
  reorderTickets: (p) => service.reorderTickets(p.keys),
  sortTickets: () => service.sortTickets(),
  logged: (p) => service.logged(p.from, p.to),
  editWorklog: (p) => service.editWorklog(p),
  deleteWorklog: (p) => service.deleteWorklog(p.key, p.id),
};

chrome.runtime.onMessage.addListener((msg: Request, _sender, sendResponse: (r: Reply<unknown>) => void) => {
  const handler = handlers[msg.type] as (p: unknown) => Promise<unknown>;
  if (!handler) {
    return false;
  }
  handler(msg.payload).then(
    (value) => sendResponse({ ok: true, value }),
    (err: Error) => sendResponse({ ok: false, error: err.message }),
  );
  return true;
});

ensureAlarm();
void tick('wake');
