import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
// End-to-end tests point the extension at a fake Jira on localhost.
const testHosts = process.argv.includes('--test-hosts');

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
cpSync('static', 'dist', { recursive: true });
if (testHosts) {
  const manifest = JSON.parse(readFileSync('dist/manifest.json', 'utf8'));
  manifest.host_permissions.push('http://localhost/*', 'http://127.0.0.1/*');
  writeFileSync('dist/manifest.json', JSON.stringify(manifest, null, 2));
}

const ctx = await esbuild.context({
  entryPoints: {
    background: 'src/background.ts',
    review: 'src/ui/review.ts',
    options: 'src/ui/options.ts',
    calendar: 'src/ui/calendar.ts',
    tickets: 'src/ui/tickets.ts',
  },
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  outdir: 'dist',
  sourcemap: production ? false : 'inline',
  minify: production,
  logLevel: 'info',
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
