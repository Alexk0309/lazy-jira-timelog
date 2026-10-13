// End-to-end check in a real Chromium: loads the built extension, points it at a
// fake Jira on localhost, tracks a real tab, then logs time from the review page.
// Run: npm run build -- --test-hosts && node scripts/e2e.mjs [screenshot-dir]
import { createServer } from 'http';
import { existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { chromium } from 'playwright';

const shots = process.argv[2] ? resolve(process.argv[2]) : null;
const posted = [];

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (body, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const p = url.pathname;
    if (p.startsWith('/browse/')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`<title>[${p.slice(8)}] Refund flow for card payments - Jira</title><h1>${p.slice(8)}</h1>`);
    }
    if (p === '/rest/api/3/myself') return send({ accountId: 'me', displayName: 'Alex' });
    if (p === '/rest/api/3/project/search') return send({ values: [{ key: 'PAY' }, { key: 'OPS' }], isLast: true });
    if (p === '/rest/api/3/search/jql') return send({ issues: [{ key: 'OPS-12', fields: { summary: 'Rotate staging credentials' } }] });
    if (p === '/rest/api/3/issue/picker') return send({ sections: [{ issues: [{ key: 'OPS-12', summaryText: 'Rotate staging credentials' }] }] });
    if (p === '/rest/api/3/issue/PAY-7/worklog' && req.method === 'POST') {
      posted.push({ key: 'PAY-7', ...JSON.parse(body), xsrf: req.headers['x-atlassian-token'] });
      return send({ id: String(1000 + posted.length) }, 201);
    }
    if (p.endsWith('/worklog')) return send({ worklogs: [] });
    if (p === '/rest/api/3/issue/PAY-7') return send({ key: 'PAY-7', fields: { summary: 'Refund flow for card payments' } });
    if (p === '/rest/api/3/issue/PAY-8') return send({ key: 'PAY-8', fields: { summary: 'Payout reports for finance' } });
    send({ errorMessages: ['not found'] }, 404);
  });
});
await new Promise((r) => server.listen(0, r));
const site = `http://localhost:${server.address().port}`;

const ext = resolve('dist');
const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'ljt-')), {
  executablePath: process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined),
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--headless=new'],
  viewport: { width: 760, height: 900 },
});

const fail = (msg) => {
  console.error('FAIL:', msg);
  process.exitCode = 1;
};
try {
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const page = (p) => `chrome-extension://${id}/${p}`;

  // 1. Settings: set the site and test the connection through the UI.
  const options = (await context.pages())[0] ?? (await context.newPage());
  await options.goto(page('options.html'));
  await options.fill('#siteUrl', site);
  await options.press('#siteUrl', 'Tab');
  await options.waitForTimeout(300);
  await options.click('#connect');
  await options.waitForFunction(() => /Connected/.test(document.querySelector('#connect-result').textContent), null, { timeout: 5000 });
  console.log('connect:', await options.textContent('#connect-result'));
  if (shots) await options.screenshot({ path: join(shots, 'settings.png'), fullPage: true });

  // 2. Real tracking: open an issue tab and let the worker tick.
  const issueTab = await context.newPage();
  await issueTab.goto(`${site}/browse/PAY-7`);
  await issueTab.bringToFront();
  await worker.evaluate(() => new Promise((r) => setTimeout(r, 500)));
  const tracked = await worker.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return Object.entries(all).filter(([k]) => k.startsWith('hb:')).flatMap(([, v]) => v);
  });
  console.log('heartbeats from the real tab:', tracked.map((h) => `${h.key}@${h.repo}:${h.signal}`).join(', ') || 'none');
  if (!tracked.some((h) => h.key === 'PAY-7')) fail('no heartbeat recorded for the PAY-7 tab');

  // 3. Seed a realistic morning (52 min on PAY-7, 20 on PAY-8, 25 unassigned-free) so the review has content.
  await worker.evaluate(async () => {
    const day = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const key = `hb:${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9, 0).getTime();
    const beats = [];
    for (let m = 0; m <= 52; m++) beats.push({ t: start + m * 60000, repo: 'localhost', branch: 'PAY-7', key: 'PAY-7', signal: 'tick' });
    for (let m = 60; m <= 80; m++) beats.push({ t: start + m * 60000, repo: 'github.com', branch: 'PAY-8', key: 'PAY-8', signal: 'tick' });
    await chrome.storage.local.set({
      [key]: beats,
      notes: [{ t: start + 70 * 60000, repo: 'github.com', branch: 'PAY-8', hash: 'gh/1', subject: 'PAY-8 Export payouts as CSV (#42)' }],
      lastSeen: null,
    });
  });

  // 4. Review page.
  const review = await context.newPage();
  await review.goto(page('review.html'));
  await review.waitForSelector('.row');
  await review.waitForTimeout(500);
  const rows = await review.$$eval('.row', (rs) => rs.map((r) => r.querySelector('.row-key').textContent + ' ' + r.querySelector('.row-time').textContent));
  console.log('review rows:', rows.join(' | '));
  if (shots) await review.screenshot({ path: join(shots, 'review.png'), fullPage: true });

  // Open the PAY-7 row, bump it 15 minutes, log it.
  await review.click('.row:has(.row-key:text-is("PAY-7")) .row-main');
  if (shots) await review.screenshot({ path: join(shots, 'review-open.png'), fullPage: true });
  await review.click('.row.open .stepper button:last-child');
  await review.click('.row.open .btn-primary');
  await review.waitForSelector('.row.done');
  console.log('posted:', JSON.stringify(posted));
  if (posted.length !== 1 || posted[0].timeSpentSeconds !== 4500 || posted[0].xsrf !== 'no-check') fail('unexpected worklog post');

  // Popup-sized and dark-mode views.
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 380, height: 600 });
  await popup.goto(page('review.html?popup=1'));
  await popup.waitForTimeout(800);
  if (shots) await popup.screenshot({ path: join(shots, 'popup.png') });
  await popup.emulateMedia({ colorScheme: 'dark' });
  if (shots) await popup.screenshot({ path: join(shots, 'popup-dark.png') });

  const badge = await worker.evaluate(() => chrome.action.getBadgeText({}));
  console.log('badge:', badge);
} catch (err) {
  fail(err.stack || err.message);
} finally {
  await context.close();
  server.close();
}
console.log(process.exitCode ? 'E2E FAILED' : 'E2E PASSED');
