import * as vscode from 'vscode';
import { clearApiToken, onSettingsChanged, setApiToken, settings } from './config';
import { ReviewPanel } from './reviewPanel';
import { StatusBar } from './statusBar';
import { Store } from './store';
import { Timelog } from './timelog';
import { Tracker } from './tracker';

const PROJECT_KEYS_KEY = 'lazyJiraTimelog.projectKeys';
const TOKEN_HELP_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const store = new Store(context.globalStorageUri.fsPath);
  await store.init();
  void store.prune(settings().retentionDays).catch((err) => console.error('[lazy-jira-timelog] prune failed', err));

  const tracker = new Tracker(store);
  tracker.setProjectKeys(context.globalState.get<string[]>(PROJECT_KEYS_KEY, []));
  const timelog = new Timelog(store, context.secrets);

  context.subscriptions.push(tracker, timelog);
  await tracker.start();
  context.subscriptions.push(new StatusBar(timelog, tracker, context.globalState));

  // Project keys let lower-case branch names (feature/pay-142-...) map safely.
  const refreshProjectKeys = async (report: boolean) => {
    const client = await timelog.client();
    if (typeof client === 'string') {
      if (report) {
        void vscode.window.showWarningMessage(client);
      }
      return;
    }
    try {
      const me = await client.myself();
      const keys = await client.projectKeys();
      await context.globalState.update(PROJECT_KEYS_KEY, keys);
      tracker.setProjectKeys(keys);
      if (report) {
        void vscode.window.showInformationMessage(`Connected to Jira as ${me.displayName}. ${keys.length} projects found.`);
      }
    } catch (err) {
      if (report) {
        void vscode.window.showErrorMessage((err as Error).message);
      }
    }
  };
  void refreshProjectKeys(false);

  context.subscriptions.push(
    onSettingsChanged(() => void refreshProjectKeys(false)),

    vscode.commands.registerCommand('lazyJiraTimelog.openReview', () => ReviewPanel.show(context.extensionUri, timelog)),

    vscode.commands.registerCommand('lazyJiraTimelog.setApiToken', async () => {
      const s = settings();
      if (!s.siteUrl || !s.email) {
        const site = await vscode.window.showInputBox({
          title: 'Jira site URL',
          prompt: 'Your Jira Cloud site',
          placeHolder: 'https://your-team.atlassian.net',
          value: s.siteUrl,
          ignoreFocusOut: true,
          validateInput: (v) => (/^https:\/\/\S+$/.test(v.trim()) ? undefined : 'Enter a URL starting with https://'),
        });
        if (!site) {
          return;
        }
        const email = await vscode.window.showInputBox({
          title: 'Atlassian account email',
          value: s.email,
          ignoreFocusOut: true,
          validateInput: (v) => (/\S+@\S+/.test(v.trim()) ? undefined : 'Enter your email address'),
        });
        if (!email) {
          return;
        }
        const config = vscode.workspace.getConfiguration('lazyJiraTimelog');
        await config.update('siteUrl', site.trim(), vscode.ConfigurationTarget.Global);
        await config.update('email', email.trim(), vscode.ConfigurationTarget.Global);
      }
      const token = await vscode.window.showInputBox({
        title: 'Jira API token',
        prompt: `Create one at ${TOKEN_HELP_URL}. It is stored in your OS keychain.`,
        password: true,
        ignoreFocusOut: true,
      });
      if (!token) {
        return;
      }
      await setApiToken(context.secrets, token.trim());
      await refreshProjectKeys(true);
    }),

    vscode.commands.registerCommand('lazyJiraTimelog.clearApiToken', async () => {
      await clearApiToken(context.secrets);
      void vscode.window.showInformationMessage('Jira API token removed.');
    }),

    vscode.commands.registerCommand('lazyJiraTimelog.testConnection', () => refreshProjectKeys(true)),

    vscode.commands.registerCommand('lazyJiraTimelog.showCurrentIssue', () => {
      const current = tracker.current();
      if (!current) {
        void vscode.window.showInformationMessage('No repository or folder is open, so no time is being tracked.');
        return;
      }
      const where = current.branch ? `branch ${current.branch} in ${current.repo}` : current.repo;
      const target = current.key
        ? `Time is going to ${current.key}.`
        : 'Time is collected as Unassigned. Put a Jira key in the branch name, a commit message, or set "Default issue" for this repo.';
      void vscode.window.showInformationMessage(`${target} (${where})`);
    }),
  );
}

export function deactivate(): void {
  // Disposables registered on the context clean up, including the final blur heartbeat.
}
