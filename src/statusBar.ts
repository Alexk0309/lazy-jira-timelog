import * as vscode from 'vscode';
import { settings } from './config';
import { totalUnloggedMs } from './core/drafts';
import { shouldRemind } from './core/reminder';
import { formatDuration } from './core/time';
import type { Timelog } from './timelog';
import type { Tracker } from './tracker';

const LAST_REMINDED_KEY = 'lazyJiraTimelog.lastRemindedDay';
/** Recompute at most this often while heartbeats stream in. */
const REFRESH_MS = 60_000;

/** Status-bar badge with unlogged time, plus the one daily reminder. */
export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly disposables: vscode.Disposable[] = [];
  private pending: NodeJS.Timeout | undefined;
  private lastRefresh = 0;

  constructor(
    private readonly timelog: Timelog,
    private readonly tracker: Tracker,
    private readonly globalState: vscode.Memento,
  ) {
    this.item.command = 'lazyJiraTimelog.openReview';
    this.item.name = 'Jira Timelog';
    const interval = setInterval(() => void this.refresh(), REFRESH_MS);
    this.disposables.push(
      this.item,
      { dispose: () => clearInterval(interval) },
      tracker.onDidRecord(() => this.schedule()),
      timelog.onDidSettle(() => void this.refresh()),
      vscode.window.onDidChangeWindowState((s) => s.focused && void this.refresh()),
    );
    void this.refresh();
  }

  private schedule(): void {
    if (this.pending) {
      return;
    }
    const wait = Math.max(0, REFRESH_MS - (Date.now() - this.lastRefresh));
    this.pending = setTimeout(() => {
      this.pending = undefined;
      void this.refresh();
    }, wait);
  }

  async refresh(): Promise<void> {
    this.lastRefresh = Date.now();
    let drafts;
    try {
      drafts = await this.timelog.drafts();
    } catch (err) {
      console.error('[lazy-jira-timelog] could not compute drafts', err);
      return;
    }
    const today = this.timelog.today();
    const total = totalUnloggedMs(drafts);
    const todayMs = totalUnloggedMs(drafts, today);
    const current = this.tracker.current();
    const tracking = current ? `Tracking: ${current.key ?? 'Unassigned'}${current.branch ? ` (${current.branch})` : ''}` : 'Not tracking';

    if (total > 0) {
      this.item.text = `$(watch) ${formatDuration(total)} to log`;
      const earlier = total - todayMs;
      this.item.tooltip = new vscode.MarkdownString(
        [
          `**${formatDuration(todayMs)}** unlogged today` + (earlier > 0 ? `, ${formatDuration(earlier)} from earlier days` : ''),
          tracking,
          'Click to review and log to Jira.',
        ].join('\n\n'),
      );
    } else {
      this.item.text = '$(watch) All logged';
      this.item.tooltip = `${tracking}\n\nNothing waiting to be logged.`;
    }
    this.item.show();

    await this.maybeRemind(todayMs);
  }

  private async maybeRemind(todayMs: number): Promise<void> {
    // Only the focused window reminds, so several open windows show one notification.
    if (!vscode.window.state.focused) {
      return;
    }
    const remind = shouldRemind({
      now: Date.now(),
      reminderMinutes: settings().reminderMinutes,
      lastRemindedDay: this.globalState.get<string>(LAST_REMINDED_KEY),
      unloggedTodayMs: todayMs,
    });
    if (!remind) {
      return;
    }
    await this.globalState.update(LAST_REMINDED_KEY, this.timelog.today());
    const choice = await vscode.window.showInformationMessage(
      `You have ${formatDuration(todayMs)} of coding time to log today.`,
      'Review',
      'Later',
    );
    if (choice === 'Review') {
      await vscode.commands.executeCommand('lazyJiraTimelog.openReview');
    }
  }

  dispose(): void {
    if (this.pending) {
      clearTimeout(this.pending);
    }
    this.disposables.forEach((d) => d.dispose());
  }
}
