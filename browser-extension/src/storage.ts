import type { AiNewEntry, AiSuggestion } from './ai';
import { localDay } from './core/time';
import type { CommitRecord, Heartbeat, SettledEntry } from './core/types';

export interface Settings {
  siteUrl: string;
  /** Optional: with email + token the extension uses Basic auth; otherwise your Jira browser session. */
  email: string;
  apiToken: string;
  idleMinutes: number;
  roundMinutes: number;
  minSessionMinutes: number;
  /** HH:MM, or empty for no reminder. */
  reminderTime: string;
  retentionDays: number;
  /** Cursor user API key for "Fill in with AI"; empty turns the feature off. */
  cursorApiKey: string;
  /** Cursor model id; empty uses the person's Cursor default. */
  cursorModel: string;
  /** Override for the Cursor API base URL (tests only). */
  cursorApiUrl: string;
}

export const DEFAULT_SETTINGS: Settings = {
  siteUrl: '',
  email: '',
  apiToken: '',
  idleMinutes: 15,
  roundMinutes: 15,
  minSessionMinutes: 5,
  reminderTime: '17:30',
  retentionDays: 30,
  cursorApiKey: '',
  cursorModel: '',
  cursorApiUrl: '',
};

/** The latest "Fill in with AI" run, kept so the popup can close while Cursor works. */
export interface AiState {
  day: string;
  status: 'running' | 'done' | 'error';
  at: number;
  suggestions?: AiSuggestion[];
  /** Entries for work from the person's day summary that nothing tracked. */
  added?: AiNewEntry[];
  /** Indexes into `added` already logged or removed, so they don't come back. */
  consumed?: number[];
  error?: string;
}

/** The subset of chrome.storage.StorageArea we use, so tests can pass a fake. */
export interface KeyValue {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

/** Last place time went, so the next heartbeat can be throttled or a blur written. */
export interface LastSeen {
  t: number;
  key: string;
  source: string;
}

const HB_PREFIX = 'hb:';

/**
 * Everything lives in chrome.storage.local on this machine. Writes are queued
 * so the background worker never interleaves two read-modify-write cycles.
 */
export class Store {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly kv: KeyValue) {}

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async settings(): Promise<Settings> {
    const { settings } = await this.kv.get('settings');
    return { ...DEFAULT_SETTINGS, ...(settings as Partial<Settings> | undefined) };
  }

  saveSettings(patch: Partial<Settings>): Promise<Settings> {
    return this.serial(async () => {
      const next = { ...(await this.settings()), ...patch };
      await this.kv.set({ settings: next });
      return next;
    });
  }

  async projectKeys(): Promise<string[]> {
    const { projectKeys } = await this.kv.get('projectKeys');
    return (projectKeys as string[] | undefined) ?? [];
  }

  async setProjectKeys(keys: string[]): Promise<void> {
    await this.kv.set({ projectKeys: keys });
  }

  addHeartbeat(hb: Heartbeat): Promise<void> {
    const key = HB_PREFIX + localDay(hb.t);
    return this.serial(async () => {
      const current = ((await this.kv.get(key))[key] as Heartbeat[] | undefined) ?? [];
      current.push(hb);
      await this.kv.set({ [key]: current });
    });
  }

  async heartbeats(days: number, now = Date.now()): Promise<Heartbeat[]> {
    const keys: string[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      keys.push(HB_PREFIX + localDay(d.getTime()));
    }
    const found = await this.kv.get(keys);
    return keys.flatMap((k) => (found[k] as Heartbeat[] | undefined) ?? []);
  }

  /** Page labels (PR titles) seen while working; they seed worklog comments. */
  addNote(note: CommitRecord): Promise<void> {
    return this.serial(async () => {
      const notes = await this.notes();
      const day = localDay(note.t);
      if (notes.some((n) => n.hash === note.hash && localDay(n.t) === day)) {
        return;
      }
      notes.push(note);
      await this.kv.set({ notes });
    });
  }

  async notes(): Promise<CommitRecord[]> {
    const { notes } = await this.kv.get('notes');
    return (notes as CommitRecord[] | undefined) ?? [];
  }

  addSettled(entry: SettledEntry): Promise<void> {
    return this.serial(async () => {
      const settled = await this.settled();
      settled.push(entry);
      await this.kv.set({ settled });
    });
  }

  async settled(): Promise<SettledEntry[]> {
    const { settled } = await this.kv.get('settled');
    return (settled as SettledEntry[] | undefined) ?? [];
  }

  async lastSeen(): Promise<LastSeen | undefined> {
    const { lastSeen } = await this.kv.get('lastSeen');
    return lastSeen as LastSeen | undefined;
  }

  async setLastSeen(last: LastSeen | null): Promise<void> {
    if (last) {
      await this.kv.set({ lastSeen: last });
    } else {
      await this.kv.remove('lastSeen');
    }
  }

  async aiState(): Promise<AiState | undefined> {
    const { ai } = await this.kv.get('ai');
    return ai as AiState | undefined;
  }

  async setAiState(state: AiState): Promise<void> {
    await this.kv.set({ ai: state });
  }

  async lastRemindedDay(): Promise<string | undefined> {
    const { lastRemindedDay } = await this.kv.get('lastRemindedDay');
    return lastRemindedDay as string | undefined;
  }

  async setLastRemindedDay(day: string): Promise<void> {
    await this.kv.set({ lastRemindedDay: day });
  }

  /** Drops heartbeat days, notes and settled entries older than the retention window. */
  prune(retentionDays: number, now = Date.now()): Promise<void> {
    return this.serial(async () => {
      const cutoff = new Date(now);
      cutoff.setDate(cutoff.getDate() - retentionDays);
      const cutoffDay = localDay(cutoff.getTime());
      const all = await this.kv.get(null);
      const stale = Object.keys(all).filter((k) => k.startsWith(HB_PREFIX) && k.slice(HB_PREFIX.length) < cutoffDay);
      if (stale.length > 0) {
        await this.kv.remove(stale);
      }
      const notes = ((all.notes as CommitRecord[] | undefined) ?? []).filter((n) => localDay(n.t) >= cutoffDay);
      const settled = ((all.settled as SettledEntry[] | undefined) ?? []).filter((e) => e.day >= cutoffDay);
      await this.kv.set({ notes, settled });
    });
  }
}
