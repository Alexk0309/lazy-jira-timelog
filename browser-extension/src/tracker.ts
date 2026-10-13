import { classifyTab } from './classify';
import { BLUR_SIGNAL } from './core/sessions';
import type { Store } from './storage';

/** Same-issue heartbeats closer together than this are skipped. */
const THROTTLE_MS = 25_000;

export interface ActiveTab {
  url?: string;
  title?: string;
}

export interface TrackerDeps {
  store: Store;
  now: () => number;
  /** The active tab of the focused browser window, or null if the browser isn't focused. */
  activeTab: () => Promise<ActiveTab | null>;
  /** chrome.idle state for the configured idle threshold. */
  idleState: (idleSeconds: number) => Promise<'active' | 'idle' | 'locked'>;
}

export interface Tracking {
  key: string;
  source: string;
}

/**
 * Turns browser state into heartbeats. Only a focused tab tied to a Jira
 * issue counts; anything else writes a single "blur" so the session closes
 * after the grace period. Only the issue key and the hostname are stored.
 */
export class Tracker {
  constructor(private readonly deps: TrackerDeps) {}

  async tick(signal: string): Promise<Tracking | null> {
    const { store, now } = this.deps;
    const settings = await store.settings();
    const idle = await this.deps.idleState(Math.max(15, Math.round(settings.idleMinutes * 60)));
    if (idle !== 'active') {
      await this.blur();
      return null;
    }
    const tab = await this.deps.activeTab();
    const work = tab
      ? classifyTab(tab.url, tab.title, { jiraHost: hostOf(settings.siteUrl), projectKeys: await store.projectKeys() })
      : null;
    if (!work) {
      await this.blur();
      return null;
    }

    const t = now();
    const last = await store.lastSeen();
    if (last && last.key === work.key && last.source === work.source && t - last.t < THROTTLE_MS) {
      return { key: work.key, source: work.source };
    }
    // The key doubles as "branch" so sessions and comment notes group per issue.
    await store.addHeartbeat({ t, repo: work.source, branch: work.key, key: work.key, signal });
    await store.setLastSeen({ t, key: work.key, source: work.source });
    if (work.label && work.labelId) {
      await store.addNote({ t, repo: work.source, branch: work.key, hash: work.labelId, subject: work.label });
    }
    return { key: work.key, source: work.source };
  }

  async blur(): Promise<void> {
    const { store, now } = this.deps;
    const last = await store.lastSeen();
    if (!last) {
      return;
    }
    await store.addHeartbeat({ t: now(), repo: last.source, branch: last.key, key: last.key, signal: BLUR_SIGNAL });
    await store.setLastSeen(null);
  }
}

export function hostOf(siteUrl: string): string | null {
  try {
    return siteUrl ? new URL(siteUrl).hostname : null;
  } catch {
    return null;
  }
}
