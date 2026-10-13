// Subset of the built-in vscode.git extension API (extensions/git/src/api/git.d.ts)
// that this extension uses. Cursor ships the same built-in git extension.
import type { Event, Uri } from 'vscode';

export interface Branch {
  readonly name?: string;
  readonly commit?: string;
}

export interface Commit {
  readonly hash: string;
  readonly message: string;
  readonly authorDate?: Date;
}

export interface RepositoryState {
  readonly HEAD: Branch | undefined;
  readonly onDidChange: Event<void>;
}

export interface Repository {
  readonly rootUri: Uri;
  readonly state: RepositoryState;
  getCommit(ref: string): Promise<Commit>;
}

export interface API {
  readonly state: 'uninitialized' | 'initialized';
  readonly onDidChangeState: Event<'uninitialized' | 'initialized'>;
  readonly repositories: Repository[];
  readonly onDidOpenRepository: Event<Repository>;
  readonly onDidCloseRepository: Event<Repository>;
  getRepository(uri: Uri): Repository | null;
}

export interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): API;
}
