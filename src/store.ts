import { promises as fs } from 'fs';
import * as path from 'path';
import { localDay } from './core/time';
import type { CommitRecord, Heartbeat, SettledEntry } from './core/types';

/**
 * Local, append-only storage in the extension's global storage folder.
 *
 * Every file is JSON Lines and only ever appended to, so several Cursor
 * windows can write at once without overwriting each other. Nothing here
 * leaves the machine; only confirmed worklogs are sent to Jira.
 */
export class Store {
  constructor(private readonly dir: string) {}

  private get heartbeatDir() {
    return path.join(this.dir, 'heartbeats');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.heartbeatDir, { recursive: true });
  }

  async addHeartbeat(hb: Heartbeat): Promise<void> {
    await appendLine(path.join(this.heartbeatDir, `${localDay(hb.t)}.jsonl`), hb);
  }

  async addCommit(commit: CommitRecord): Promise<void> {
    await appendLine(path.join(this.dir, 'commits.jsonl'), commit);
  }

  async addSettled(entry: SettledEntry): Promise<void> {
    await appendLine(path.join(this.dir, 'settled.jsonl'), entry);
  }

  /** Heartbeats from the last `days` local days, including today. */
  async heartbeats(days: number, now = Date.now()): Promise<Heartbeat[]> {
    const result: Heartbeat[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      result.push(...(await readLines<Heartbeat>(path.join(this.heartbeatDir, `${localDay(d.getTime())}.jsonl`))));
    }
    return result;
  }

  async commits(): Promise<CommitRecord[]> {
    return readLines<CommitRecord>(path.join(this.dir, 'commits.jsonl'));
  }

  async settled(): Promise<SettledEntry[]> {
    return readLines<SettledEntry>(path.join(this.dir, 'settled.jsonl'));
  }

  /** Deletes heartbeat files older than `retentionDays` and trims old commits and settled entries. */
  async prune(retentionDays: number, now = Date.now()): Promise<void> {
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const cutoffDay = localDay(cutoff.getTime());
    const cutoffMs = cutoff.getTime();

    let files: string[] = [];
    try {
      files = await fs.readdir(this.heartbeatDir);
    } catch {
      return;
    }
    for (const file of files) {
      const day = file.replace(/\.jsonl$/, '');
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < cutoffDay) {
        await fs.rm(path.join(this.heartbeatDir, file), { force: true });
      }
    }
    await rewriteFiltered<CommitRecord>(path.join(this.dir, 'commits.jsonl'), (c) => c.t >= cutoffMs);
    await rewriteFiltered<SettledEntry>(path.join(this.dir, 'settled.jsonl'), (e) => e.day >= cutoffDay);
  }
}

async function appendLine(file: string, value: unknown): Promise<void> {
  await fs.appendFile(file, JSON.stringify(value) + '\n', 'utf8');
}

async function readLines<T>(file: string): Promise<T[]> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const items: T[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      items.push(JSON.parse(line) as T);
    } catch {
      // A torn write from a crash; skip the line rather than lose the file.
    }
  }
  return items;
}

async function rewriteFiltered<T>(file: string, keep: (item: T) => boolean): Promise<void> {
  const items = await readLines<T>(file);
  const kept = items.filter(keep);
  if (kept.length === items.length) {
    return;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, kept.map((i) => JSON.stringify(i) + '\n').join(''), 'utf8');
  await fs.rename(tmp, file);
}
