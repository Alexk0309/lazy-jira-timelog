import * as vscode from 'vscode';
import { parseClock } from './core/time';

const SECTION = 'lazyJiraTimelog';
const TOKEN_SECRET = 'lazyJiraTimelog.apiToken';

export interface Settings {
  siteUrl: string;
  email: string;
  idleMinutes: number;
  roundMinutes: number;
  minSessionMinutes: number;
  reminderMinutes: number | null;
  retentionDays: number;
}

export function settings(): Settings {
  const c = vscode.workspace.getConfiguration(SECTION);
  return {
    siteUrl: c.get<string>('siteUrl', '').trim(),
    email: c.get<string>('email', '').trim(),
    idleMinutes: c.get<number>('idleMinutes', 15),
    roundMinutes: c.get<number>('roundMinutes', 15),
    minSessionMinutes: c.get<number>('minSessionMinutes', 5),
    reminderMinutes: parseClock(c.get<string>('reminderTime', '17:30')),
    retentionDays: c.get<number>('retentionDays', 30),
  };
}

/** Per-repo default issue: read with the repo folder as scope so workspace-folder settings apply. */
export function defaultIssueFor(folder: vscode.Uri | undefined): string {
  return vscode.workspace.getConfiguration(SECTION, folder).get<string>('defaultIssue', '').trim();
}

export function onSettingsChanged(listener: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(SECTION)) {
      listener();
    }
  });
}

export async function getApiToken(secrets: vscode.SecretStorage): Promise<string | undefined> {
  return secrets.get(TOKEN_SECRET);
}

export async function setApiToken(secrets: vscode.SecretStorage, token: string): Promise<void> {
  await secrets.store(TOKEN_SECRET, token);
}

export async function clearApiToken(secrets: vscode.SecretStorage): Promise<void> {
  await secrets.delete(TOKEN_SECRET);
}
