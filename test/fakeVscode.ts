// A tiny stand-in for the `vscode` module, enough to drive the extension end to end in tests.
import * as path from 'path';

type Listener<T> = (e: T) => unknown;

export class EventEmitter<T> {
  private listeners: Listener<T>[] = [];
  event = (listener: Listener<T>) => {
    this.listeners.push(listener);
    return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== listener)) };
  };
  fire(e?: T) {
    this.listeners.forEach((l) => l(e as T));
  }
  dispose() {
    this.listeners = [];
  }
}

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly path: string,
  ) {}
  static file(p: string) {
    return new Uri('file', p);
  }
  static joinPath(base: Uri, ...parts: string[]) {
    return new Uri(base.scheme, path.join(base.path, ...parts));
  }
  get fsPath() {
    return this.path;
  }
  toString() {
    return `${this.scheme}://${this.path}`;
  }
}

export class MarkdownString {
  constructor(readonly value: string) {}
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}
export enum ViewColumn {
  Active = -1,
}
export enum ConfigurationTarget {
  Global = 1,
}

/** Everything a test needs to poke at. */
export const fake = {
  focused: true,
  config: {} as Record<string, unknown>,
  messages: [] as string[],
  statusText: '',
  events: {
    textChange: new EventEmitter<unknown>(),
    save: new EventEmitter<unknown>(),
    activeEditor: new EventEmitter<unknown>(),
    selection: new EventEmitter<unknown>(),
    visibleRanges: new EventEmitter<unknown>(),
    activeTerminal: new EventEmitter<unknown>(),
    openTerminal: new EventEmitter<unknown>(),
    windowState: new EventEmitter<{ focused: boolean }>(),
    config: new EventEmitter<{ affectsConfiguration: (s: string) => boolean }>(),
    debug: new EventEmitter<unknown>(),
  },
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  webview: {
    toHost: new EventEmitter<unknown>(),
    fromHost: [] as any[],
  },
  repo: {
    rootUri: Uri.file('/work/api'),
    state: { HEAD: { name: 'feature/PAY-7-refunds', commit: 'c1' } as { name?: string; commit?: string }, onDidChange: new EventEmitter<void>().event },
    getCommit: async (hash: string) => ({ hash, message: `PAY-7 commit ${hash}`, authorDate: new Date() }),
  },
  activeDocUri: Uri.file('/work/api/src/index.ts'),
  repoChange: new EventEmitter<void>(),
};
fake.repo.state.onDidChange = fake.repoChange.event;

export const window = {
  get state() {
    return { focused: fake.focused };
  },
  get activeTextEditor() {
    return { document: { uri: fake.activeDocUri } };
  },
  onDidChangeActiveTextEditor: fake.events.activeEditor.event,
  onDidChangeTextEditorSelection: fake.events.selection.event,
  onDidChangeTextEditorVisibleRanges: fake.events.visibleRanges.event,
  onDidChangeActiveTerminal: fake.events.activeTerminal.event,
  onDidOpenTerminal: fake.events.openTerminal.event,
  onDidChangeWindowState: fake.events.windowState.event,
  createStatusBarItem: () => ({
    set text(v: string) {
      fake.statusText = v;
    },
    get text() {
      return fake.statusText;
    },
    tooltip: undefined as unknown,
    command: undefined as unknown,
    name: '',
    show() {},
    dispose() {},
  }),
  showInformationMessage: async (m: string) => {
    fake.messages.push(m);
    return undefined;
  },
  showWarningMessage: async (m: string) => {
    fake.messages.push(m);
    return undefined;
  },
  showErrorMessage: async (m: string) => {
    fake.messages.push(m);
    return undefined;
  },
  showInputBox: async () => undefined,
  createWebviewPanel: () => {
    const disposeEmitter = new EventEmitter<void>();
    return {
      webview: {
        html: '',
        cspSource: 'vscode-resource:',
        asWebviewUri: (u: Uri) => u,
        postMessage: async (m: unknown) => {
          fake.webview.fromHost.push(m);
          return true;
        },
        onDidReceiveMessage: fake.webview.toHost.event,
      },
      reveal() {},
      onDidDispose: disposeEmitter.event,
      dispose() {},
    };
  },
};

export const workspace = {
  getConfiguration: () => ({
    get: <T>(key: string, fallback: T) => (key in fake.config ? (fake.config[key] as T) : fallback),
    update: async (key: string, value: unknown) => {
      fake.config[key] = value;
    },
  }),
  onDidChangeTextDocument: fake.events.textChange.event,
  onDidSaveTextDocument: fake.events.save.event,
  onDidChangeConfiguration: fake.events.config.event,
  getWorkspaceFolder: () => ({ uri: Uri.file('/work/api') }),
  workspaceFolders: [{ uri: Uri.file('/work/api') }],
};

export const debug = {
  onDidStartDebugSession: fake.events.debug.event,
  activeDebugSession: undefined,
};

export const extensions = {
  getExtension: () => ({
    isActive: true,
    exports: {
      enabled: true,
      getAPI: () => ({
        state: 'initialized',
        repositories: [fake.repo],
        onDidOpenRepository: new EventEmitter<unknown>().event,
        onDidCloseRepository: new EventEmitter<unknown>().event,
        onDidChangeState: new EventEmitter<unknown>().event,
        getRepository: () => fake.repo,
      }),
    },
  }),
};

export const commands = {
  registerCommand: (id: string, fn: (...args: unknown[]) => unknown) => {
    fake.commands.set(id, fn);
    return { dispose: () => fake.commands.delete(id) };
  },
  executeCommand: async (id: string, ...args: unknown[]) => fake.commands.get(id)?.(...args),
};
