import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';

const { version } = JSON.parse(readFileSync('dist/manifest.json', 'utf8'));
const out = `lazy-jira-timelog-browser-${version}.zip`;
execFileSync('zip', ['-qr', `../${out}`, '.'], { cwd: 'dist', stdio: 'inherit' });
console.log(`Packaged ${out}`);
