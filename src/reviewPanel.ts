import * as vscode from 'vscode';
import { settings } from './config';
import { roundToStep } from './core/drafts';
import { dayEnd, dayStart, formatDuration, parseDuration } from './core/time';
import type { Draft } from './core/types';
import { extractIssueKey } from './core/issueKey';
import type { JiraClient } from './jira/client';
import type { Timelog } from './timelog';

/** A draft as the webview sees it. Splitting creates extra rows that share day and sourceKey. */
interface Row {
  id: string;
  day: string;
  dayLabel: string;
  sourceKey: string;
  targetKey: string;
  rawMs: number;
  duration: string;
  started: number;
  comment: string;
  branches: string[];
}

type FromWebview =
  | { type: 'ready' | 'refresh' | 'openSettings' | 'setToken' }
  | { type: 'post'; rows: { id: string; targetKey: string; duration: string; comment: string; rawMs: number }[] }
  | { type: 'discard'; id: string; rawMs: number }
  | { type: 'search'; id: string; query: string }
  | { type: 'lookup'; key: string }
  | { type: 'split'; id: string };

/** The one place a developer touches: confirm, edit, reassign, split or discard the day's drafts. */
export class ReviewPanel implements vscode.Disposable {
  private static current: ReviewPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private rows: Row[] = [];
  private nextId = 1;
  private readonly summaries = new Map<string, string | null>();

  static show(extensionUri: vscode.Uri, timelog: Timelog): void {
    if (ReviewPanel.current) {
      ReviewPanel.current.panel.reveal();
      void ReviewPanel.current.reload();
      return;
    }
    const panel = vscode.window.createWebviewPanel('lazyJiraTimelog.review', 'Log time to Jira', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
    });
    ReviewPanel.current = new ReviewPanel(panel, extensionUri, timelog);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly timelog: Timelog,
  ) {
    panel.webview.html = this.html(extensionUri);
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((msg: FromWebview) => this.onMessage(msg)),
    );
  }

  private async onMessage(msg: FromWebview): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready':
        case 'refresh':
          await this.reload();
          break;
        case 'openSettings':
          await vscode.commands.executeCommand('workbench.action.openSettings', 'lazyJiraTimelog');
          break;
        case 'setToken':
          await vscode.commands.executeCommand('lazyJiraTimelog.setApiToken');
          await this.reload();
          break;
        case 'post':
          await this.post(msg.rows);
          break;
        case 'discard':
          await this.discard(msg.id, msg.rawMs);
          break;
        case 'search':
          await this.search(msg.id, msg.query);
          break;
        case 'lookup':
          await this.lookup(msg.key);
          break;
        case 'split':
          this.split(msg.id);
          break;
      }
    } catch (err) {
      this.send({ type: 'notice', level: 'error', message: (err as Error).message });
    }
  }

  private async reload(): Promise<void> {
    const drafts = await this.timelog.drafts();
    this.rows = drafts.map((d) => this.toRow(d));
    const client = await this.timelog.client();
    this.send({
      type: 'state',
      rows: this.rows,
      setupMessage: typeof client === 'string' ? client : null,
      total: formatDuration(drafts.reduce((sum, d) => sum + d.seconds * 1000, 0)),
    });
    if (typeof client !== 'string') {
      await Promise.all([this.loadSummaries(client), this.loadManualLogs(client)]);
    }
  }

  private toRow(d: Draft): Row {
    return {
      id: String(this.nextId++),
      day: d.day,
      dayLabel: dayLabel(d.day, this.timelog.today()),
      sourceKey: d.sourceKey,
      targetKey: d.sourceKey,
      rawMs: d.rawMs,
      duration: formatDuration(d.seconds * 1000),
      started: d.started,
      comment: d.comment,
      branches: d.branches,
    };
  }

  private async loadSummaries(client: JiraClient): Promise<void> {
    const keys = [...new Set(this.rows.map((r) => r.targetKey).filter(Boolean))];
    await Promise.all(keys.map((key) => this.lookupWith(client, key)));
  }

  /** Warns when the developer already logged time by hand on the same issue and day. */
  private async loadManualLogs(client: JiraClient): Promise<void> {
    try {
      const me = await client.myself();
      const ours = await this.timelog.postedWorklogIds();
      for (const row of this.rows.filter((r) => r.targetKey)) {
        try {
          const logs = await client.worklogs(row.targetKey, dayStart(row.day), dayEnd(row.day));
          const manual = logs.filter((w) => w.authorAccountId === me.accountId && !ours.has(w.id));
          const seconds = manual.reduce((sum, w) => sum + w.timeSpentSeconds, 0);
          if (seconds > 0) {
            this.send({ type: 'manual', id: row.id, text: `You already logged ${formatDuration(seconds * 1000)} here that day` });
          }
        } catch {
          // The issue may not exist or be visible; the summary lookup reports that.
        }
      }
    } catch (err) {
      this.send({ type: 'notice', level: 'error', message: (err as Error).message });
    }
  }

  private async lookup(key: string): Promise<void> {
    const client = await this.timelog.client();
    if (typeof client !== 'string') {
      await this.lookupWith(client, key);
    }
  }

  private async lookupWith(client: JiraClient, key: string): Promise<void> {
    if (!this.summaries.has(key)) {
      try {
        const issue = await client.issue(key);
        this.summaries.set(key, issue?.summary ?? null);
      } catch {
        return;
      }
    }
    const summary = this.summaries.get(key);
    this.send({ type: 'summary', key, summary: summary ?? null, missing: summary === null });
  }

  private async search(id: string, query: string): Promise<void> {
    const client = await this.timelog.client();
    if (typeof client === 'string' || query.trim().length < 2) {
      return;
    }
    const results = await client.searchIssues(query.trim());
    this.send({ type: 'searchResults', id, results: results.slice(0, 10) });
  }

  private split(id: string): void {
    const index = this.rows.findIndex((r) => r.id === id);
    if (index < 0) {
      return;
    }
    const row = this.rows[index];
    const half = Math.floor(row.rawMs / 2);
    const step = settings().roundMinutes;
    const first: Row = { ...row, rawMs: half, duration: formatDuration(roundToStep(half, step) * 1000) };
    const second: Row = { ...row, id: String(this.nextId++), rawMs: row.rawMs - half, duration: formatDuration(roundToStep(row.rawMs - half, step) * 1000), targetKey: '' };
    this.rows.splice(index, 1, first, second);
    this.send({ type: 'rows', rows: this.rows });
  }

  private async post(requests: { id: string; targetKey: string; duration: string; comment: string; rawMs: number }[]): Promise<void> {
    let posted = 0;
    for (const req of requests) {
      const row = this.rows.find((r) => r.id === req.id);
      if (!row) {
        continue;
      }
      const targetKey = extractIssueKey(req.targetKey.trim().toUpperCase());
      const seconds = parseDuration(req.duration);
      if (!targetKey) {
        this.send({ type: 'rowError', id: req.id, message: 'Pick a Jira issue first.' });
        continue;
      }
      if (seconds === null || seconds < 60) {
        this.send({ type: 'rowError', id: req.id, message: 'Enter a duration like 1h 30m.' });
        continue;
      }
      this.send({ type: 'rowBusy', id: req.id });
      try {
        await this.timelog.post({
          day: row.day,
          sourceKey: row.sourceKey,
          rawMs: req.rawMs,
          targetKey,
          seconds,
          started: row.started,
          comment: req.comment,
        });
        posted++;
        this.rows = this.rows.filter((r) => r.id !== req.id);
        this.send({ type: 'rowDone', id: req.id, message: `Logged ${formatDuration(seconds * 1000)} to ${targetKey}` });
      } catch (err) {
        this.send({ type: 'rowError', id: req.id, message: (err as Error).message });
      }
    }
    if (posted > 0) {
      this.send({ type: 'notice', level: 'info', message: `Logged ${posted} worklog${posted === 1 ? '' : 's'} to Jira.` });
    }
  }

  private async discard(id: string, rawMs: number): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) {
      return;
    }
    await this.timelog.discard(row.day, row.sourceKey, rawMs);
    this.rows = this.rows.filter((r) => r.id !== id);
    this.send({ type: 'rowDone', id, message: 'Discarded' });
  }

  private send(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  private html(extensionUri: vscode.Uri): string {
    const webview = this.panel.webview;
    const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'review.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'review.css'));
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Log time to Jira</title>
</head>
<body>
<header>
  <h1>Log time to Jira</h1>
  <div class="actions">
    <span id="total"></span>
    <button id="refresh" class="secondary">Refresh</button>
    <button id="logAll">Log all</button>
  </div>
</header>
<div id="setup" hidden></div>
<div id="notice" hidden></div>
<main id="rows"></main>
<p id="empty" hidden>Nothing to log. Time you spend coding shows up here.</p>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    ReviewPanel.current = undefined;
    this.panel.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

function dayLabel(day: string, today: string): string {
  if (day === today) {
    return 'Today';
  }
  const yesterday = new Date(dayStart(today));
  yesterday.setDate(yesterday.getDate() - 1);
  const d = new Date(dayStart(day));
  const label = d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
  return d.getTime() === yesterday.getTime() ? `Yesterday, ${label}` : label;
}
