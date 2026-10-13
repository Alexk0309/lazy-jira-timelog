import * as path from 'path';
import * as vscode from 'vscode';
import { defaultIssueFor } from './config';
import { resolveIssueKey } from './core/issueKey';
import { BLUR_SIGNAL } from './core/sessions';
import type { CommitRecord, Heartbeat } from './core/types';
import type { API as GitAPI, GitExtension, Repository } from './git';
import type { Store } from './store';

/** Same-context heartbeats closer together than this are skipped to keep files small. */
const THROTTLE_MS = 30_000;
/** How often to check for activity that has no event of its own (a debug session running). */
const TICK_MS = 60_000;
/** Commits older than this when HEAD moves are treated as pulled, not made here. */
const OWN_COMMIT_MAX_AGE_MS = 10 * 60_000;

export interface CurrentContext {
  repo: string;
  branch: string | null;
  key: string | null;
}

/**
 * Listens to editor activity and writes heartbeats for the focused window only,
 * so several open Cursor windows never double count.
 */
export class Tracker implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private git: GitAPI | undefined;
  private commits: CommitRecord[] = [];
  private projectKeys: string[] = [];
  private last: { t: number; repo: string; branch: string | null; key: string | null } | undefined;
  private readonly lastHead = new Map<string, { branch: string | null; commit: string | undefined }>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();

  /** Fires after a heartbeat is written. */
  readonly onDidRecord = this.changeEmitter.event;

  constructor(private readonly store: Store) {}

  async start(): Promise<void> {
    this.commits = await this.store.commits();
    await this.connectGit();

    const w = vscode.window;
    const docActivity = (doc: vscode.TextDocument, signal: string) => {
      if (doc.uri.scheme === 'file' || doc.uri.scheme === 'untitled' || doc.uri.scheme === 'vscode-remote') {
        this.beat(signal, doc.uri);
      }
    };

    this.disposables.push(
      this.changeEmitter,
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length > 0) {
          docActivity(e.document, 'edit');
        }
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => docActivity(doc, 'save')),
      w.onDidChangeActiveTextEditor((editor) => editor && docActivity(editor.document, 'editor')),
      w.onDidChangeTextEditorSelection((e) => docActivity(e.textEditor.document, 'cursor')),
      w.onDidChangeTextEditorVisibleRanges((e) => docActivity(e.textEditor.document, 'scroll')),
      w.onDidChangeActiveTerminal(() => this.beat('terminal')),
      w.onDidOpenTerminal(() => this.beat('terminal')),
      vscode.debug.onDidStartDebugSession(() => this.beat('debug')),
      w.onDidChangeWindowState((state) => {
        if (state.focused) {
          this.beat('focus');
        } else {
          this.blur();
        }
      }),
    );

    // Shell integration events are newer than our minimum engine; use them when present.
    const shellExec = (w as unknown as { onDidStartTerminalShellExecution?: vscode.Event<unknown> })
      .onDidStartTerminalShellExecution;
    if (shellExec) {
      this.disposables.push(shellExec(() => this.beat('terminal')));
    }

    const tick = setInterval(() => {
      if (vscode.debug.activeDebugSession) {
        this.beat('debug');
      }
    }, TICK_MS);
    this.disposables.push({ dispose: () => clearInterval(tick) });

    if (w.state.focused) {
      this.beat('focus');
    }
  }

  setProjectKeys(keys: string[]): void {
    this.projectKeys = keys;
    this.last = undefined;
  }

  /** Where time is going right now, for the status bar and the "which issue" command. */
  current(): CurrentContext | undefined {
    const where = this.locate(vscode.window.activeTextEditor?.document.uri);
    return where ? { ...where, key: this.resolve(where.repo, where.branch, where.folder) } : undefined;
  }

  private beat(signal: string, uri?: vscode.Uri): void {
    if (!vscode.window.state.focused) {
      return;
    }
    const where = this.locate(uri ?? vscode.window.activeTextEditor?.document.uri);
    if (!where) {
      return;
    }
    const key = this.resolve(where.repo, where.branch, where.folder);
    const t = Date.now();
    const last = this.last;
    if (last && last.repo === where.repo && last.branch === where.branch && last.key === key && t - last.t < THROTTLE_MS) {
      return;
    }
    this.last = { t, repo: where.repo, branch: where.branch, key };
    this.write({ t, repo: where.repo, branch: where.branch, key, signal });
  }

  private blur(): void {
    const last = this.last;
    if (!last) {
      return;
    }
    this.write({ t: Date.now(), repo: last.repo, branch: last.branch, key: last.key, signal: BLUR_SIGNAL });
    this.last = undefined;
  }

  private write(hb: Heartbeat): void {
    this.store.addHeartbeat(hb).then(
      () => this.changeEmitter.fire(),
      (err) => console.error('[lazy-jira-timelog] could not write heartbeat', err),
    );
  }

  private resolve(repo: string, branch: string | null, folder: vscode.Uri | undefined): string | null {
    return resolveIssueKey({
      repo,
      branch,
      commits: this.commits,
      defaultIssue: defaultIssueFor(folder),
      projectKeys: this.projectKeys,
    });
  }

  /** Finds the repo and branch for a file, falling back to the first repo or workspace folder. */
  private locate(uri: vscode.Uri | undefined): { repo: string; branch: string | null; folder: vscode.Uri | undefined } | undefined {
    const repo: Repository | null | undefined =
      (uri && this.git?.getRepository(uri)) ||
      (this.git && this.git.repositories.length > 0 ? this.git.repositories[0] : undefined);
    if (repo) {
      return { repo: repoName(repo.rootUri), branch: repo.state.HEAD?.name ?? null, folder: repo.rootUri };
    }
    const folder = (uri && vscode.workspace.getWorkspaceFolder(uri)) || vscode.workspace.workspaceFolders?.[0];
    if (folder) {
      return { repo: repoName(folder.uri), branch: null, folder: folder.uri };
    }
    return undefined;
  }

  private async connectGit(): Promise<void> {
    const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!ext) {
      return;
    }
    const exports = ext.isActive ? ext.exports : await ext.activate();
    if (!exports?.enabled) {
      return;
    }
    const api = exports.getAPI(1);
    this.git = api;
    const watch = (repo: Repository) => {
      this.rememberHead(repo);
      this.disposables.push(repo.state.onDidChange(() => this.onRepoChanged(repo)));
    };
    api.repositories.forEach(watch);
    this.disposables.push(api.onDidOpenRepository(watch));
  }

  private rememberHead(repo: Repository): void {
    this.lastHead.set(repo.rootUri.toString(), { branch: repo.state.HEAD?.name ?? null, commit: repo.state.HEAD?.commit });
  }

  private async onRepoChanged(repo: Repository): Promise<void> {
    const id = repo.rootUri.toString();
    const before = this.lastHead.get(id);
    this.rememberHead(repo);
    const head = repo.state.HEAD;
    if (!before || !head?.commit) {
      return;
    }
    const branch = head.name ?? null;
    if (branch !== before.branch) {
      // Branch switch: a heartbeat attributes the next stretch of work to the new branch.
      this.beat('checkout', repo.rootUri);
      return;
    }
    if (head.commit === before.commit) {
      return;
    }
    try {
      const commit = await repo.getCommit(head.commit);
      const authored = commit.authorDate ? new Date(commit.authorDate).getTime() : Date.now();
      if (Date.now() - authored > OWN_COMMIT_MAX_AGE_MS) {
        return; // Pulled or rebased onto someone else's work.
      }
      const record: CommitRecord = {
        t: Date.now(),
        repo: repoName(repo.rootUri),
        branch,
        hash: commit.hash,
        subject: commit.message.split('\n')[0].trim(),
      };
      if (this.commits.some((c) => c.hash === record.hash)) {
        return;
      }
      this.commits.push(record);
      await this.store.addCommit(record);
      this.last = undefined; // The commit may name a key that changes attribution.
      this.beat('commit', repo.rootUri);
    } catch (err) {
      console.error('[lazy-jira-timelog] could not read commit', err);
    }
  }

  dispose(): void {
    this.blur();
    this.disposables.forEach((d) => d.dispose());
  }
}

function repoName(uri: vscode.Uri): string {
  return path.basename(uri.path) || uri.toString();
}
