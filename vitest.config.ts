import * as path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { vscode: path.resolve(__dirname, 'test/fakeVscode.ts') },
  },
});
