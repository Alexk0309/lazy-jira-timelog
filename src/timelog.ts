import * as vscode from 'vscode';
import { getApiToken, settings } from './config';
import { buildDrafts } from './core/drafts';
import { buildSessions } from './core/sessions';
import { localDay } from './core/time';
import type { Draft } from './core/types';
import { JiraClient } from './jira/client';
import type { Store } from './store';

/** How far back the review shows unlogged days. */
export const REVIEW_DAYS = 14;

export interface PostRequest {
  day: string;
  sourceKey: string;
  /** Share of the draft's raw time this worklog consumes (all of it unless split). */
  rawMs: number;
  targetKey: string;
  seconds: number;
  started: number;
  comment: string;
}

/** Computes drafts from local activity and settles them by posting to Jira or discarding. */
export class Timelog {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Fires after something was posted or discarded. */
  readonly onDidSettle = this.changeEmitter.event;

  constructor(
    private readonly store: Store,
    private readonly secrets: vscode.SecretStorage,
  ) {}

  async drafts(): Promise<Draft[]> {
    const s = settings();
    const [heartbeats, commits, settled] = await Promise.all([
      this.store.heartbeats(REVIEW_DAYS),
      this.store.commits(),
      this.store.settled(),
    ]);
    const sessions = buildSessions(heartbeats, s.idleMinutes * 60000);
    return buildDrafts(sessions, commits, settled, {
      roundMinutes: s.roundMinutes,
      minSessionMinutes: s.minSessionMinutes,
    });
  }

  /** A Jira client from settings and the stored token, or a message saying what is missing. */
  async client(): Promise<JiraClient | string> {
    const s = settings();
    if (!s.siteUrl || !s.email) {
      return 'Set your Jira site URL and email in Settings (search "Lazy Jira Timelog").';
    }
    const token = await getApiToken(this.secrets);
    if (!token) {
      return 'Add your Jira API token with the "Jira Timelog: Set Jira API token" command.';
    }
    try {
      return new JiraClient({ siteUrl: s.siteUrl, email: s.email, apiToken: token });
    } catch (err) {
      return (err as Error).message;
    }
  }

  async post(req: PostRequest): Promise<string> {
    const client = await this.client();
    if (typeof client === 'string') {
      throw new Error(client);
    }
    if (req.seconds < 60) {
      throw new Error('A worklog needs at least one minute.');
    }
    const rawMs = await this.clampToUnsettled(req.day, req.sourceKey, req.rawMs);
    const worklogId = await client.addWorklog(req.targetKey, {
      started: req.started,
      seconds: req.seconds,
      comment: req.comment,
    });
    // Record right after Jira accepts, so a retry never posts the same time twice.
    await this.store.addSettled({
      day: req.day,
      sourceKey: req.sourceKey,
      rawMs,
      action: 'posted',
      targetKey: req.targetKey,
      worklogId,
      postedSeconds: req.seconds,
      at: Date.now(),
    });
    this.changeEmitter.fire();
    return worklogId;
  }

  async discard(day: string, sourceKey: string, rawMs: number): Promise<void> {
    await this.store.addSettled({
      day,
      sourceKey,
      rawMs: await this.clampToUnsettled(day, sourceKey, rawMs),
      action: 'discarded',
      at: Date.now(),
    });
    this.changeEmitter.fire();
  }

  /** Worklog ids this extension posted, so they aren't mistaken for manual logs. */
  async postedWorklogIds(): Promise<Set<string>> {
    const settled = await this.store.settled();
    return new Set(settled.map((e) => e.worklogId).filter((id): id is string => !!id));
  }

  today(): string {
    return localDay(Date.now());
  }

  private async clampToUnsettled(day: string, sourceKey: string, rawMs: number): Promise<number> {
    const draft = (await this.drafts()).find((d) => d.day === day && d.sourceKey === sourceKey);
    return Math.max(0, Math.min(rawMs, draft?.rawMs ?? rawMs));
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
