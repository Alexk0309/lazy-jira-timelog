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
const cursorCalls = [];
const edits = [];

// Issues the fake Jira knows, with what the ticket list shows. PAY-1 and PAY-10 are epics; PAY-9 and OPS-13 are sub-tasks.
const issues = {
  'PAY-1': { summary: 'Finance payouts', created: '2026-08-20T09:00:00.000+0000', type: 'Epic' },
  'PAY-7': { summary: 'Refund flow for card payments', created: '2026-09-01T09:00:00.000+0000', estimate: 4 * 3600, spent: 3600 },
  'PAY-8': { summary: 'Payout reports for finance', created: '2026-09-05T09:00:00.000+0000', parent: 'PAY-1', estimate: 2 * 3600, spent: 5400 },
  'PAY-9': { summary: 'Payout CSV export for finance', created: '2026-09-10T09:00:00.000+0000', parent: 'PAY-8', type: 'Sub-task', estimate: 3600, spent: 0 },
  'OPS-12': { summary: 'Rotate staging credentials', created: '2026-09-20T09:00:00.000+0000' },
  'OPS-13': { summary: 'Rotate the payout service key', created: '2026-09-25T09:00:00.000+0000', parent: 'OPS-12', type: 'Sub-task' },
  'PAY-10': { summary: 'Payouts in euros', created: '2026-09-26T09:00:00.000+0000', type: 'Epic' },
  'PAY-11': { summary: 'Euro bank details form', created: '2026-09-27T09:00:00.000+0000', parent: 'PAY-10' },
  'PAY-12': { summary: 'Euro payout fees', created: '2026-09-28T09:00:00.000+0000', parent: 'PAY-10' },
};
const LEVELS = { Epic: 1, Story: 0, 'Sub-task': -1 };
const issueType = (key) => {
  const name = issues[key].type ?? 'Story';
  return { name, subtask: name === 'Sub-task', hierarchyLevel: LEVELS[name] };
};
const issueJson = (key) => {
  const i = issues[key];
  return {
    key,
    fields: {
      summary: i.summary,
      status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
      issuetype: issueType(key),
      created: i.created,
      ...(i.parent ? { parent: { key: i.parent, fields: { summary: issues[i.parent].summary, issuetype: issueType(i.parent) } } } : {}),
      timetracking: timetracking(key),
    },
  };
};

// Time tracking as Jira keeps it: what was logged before, plus worklogs posted here, against the estimate.
const timetracking = (key) => {
  const i = issues[key];
  if (!i?.estimate) return {};
  const spent = (i.spent ?? 0) + posted.filter((w) => w.key === key && !w.deleted).reduce((sum, w) => sum + w.timeSpentSeconds, 0);
  return { originalEstimateSeconds: i.estimate, remainingEstimateSeconds: Math.max(0, i.estimate - spent), timeSpentSeconds: spent };
};

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
    if (p === '/acme/api/pull/51') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<title>Fix payout CSV export by dev · Pull Request #51 · acme/api · GitHub</title><h1>PR 51</h1>');
    }
    // Fake Cursor Cloud Agents API.
    if (p === '/v1/agents' && req.method === 'POST') {
      cursorCalls.push({ auth: req.headers.authorization, body: JSON.parse(body) });
      return send({ agent: { id: 'bc-1' }, run: { id: 'run-1', status: 'CREATING' } });
    }
    if (p === '/v1/agents/bc-1/runs/run-1') {
      const data = JSON.parse(cursorCalls.at(-1).body.prompt.text.split('Data:\n')[1]);
      const rows = data.rows.map((r) =>
        r.issue ? { id: r.id, comment: `Shipped ${r.title.toLowerCase()}.` } : { id: r.id, comment: 'Fixed the payout CSV export.', key: 'PAY-9', reason: 'the PR is about the payout CSV export' },
      );
      // With a day summary: a meeting on an assigned issue, and a guess at an issue that isn't yours.
      const added = data.personSummary
        ? [
            { key: 'PAY-8', minutes: 45, comment: 'Walked finance through the payout reports.', reason: 'you mentioned the finance demo' },
            { key: 'HR-1', minutes: 30, comment: 'Interviewed a backend candidate.' },
          ]
        : undefined;
      // Unsure where the interview goes, so it asks, offering tickets from your list (and one that isn't allowed).
      const questions =
        data.personSummary && data.savedIssues
          ? [{ for: 'added:1', question: 'Which ticket should the 30m interview go to?', options: [{ key: 'OPS-12', why: 'flagged on your list' }, { key: 'OPS-13' }, { key: 'HR-1' }] }]
          : undefined;
      return send({ id: 'run-1', status: 'FINISHED', result: '```json\n' + JSON.stringify({ rows, added, questions }) + '\n```' });
    }
    if (p === '/v1/agents/bc-1' && req.method === 'DELETE') {
      cursorCalls.push({ deleted: true });
      return send({ id: 'bc-1' });
    }
    if (p.startsWith('/browse/')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`<title>[${p.slice(8)}] Refund flow for card payments - Jira</title><h1>${p.slice(8)}</h1>`);
    }
    if (p === '/rest/api/3/myself') return send({ accountId: 'me', displayName: 'Alex' });
    if (p === '/rest/api/3/project/search') return send({ values: [{ key: 'PAY' }, { key: 'OPS' }], isLast: true });
    if (p === '/rest/api/3/search/jql' && JSON.parse(body).jql.startsWith('assignee = currentUser() AND statusCategory != Done')) {
      return send({ issues: ['PAY-7', 'PAY-8', 'PAY-9'].map(issueJson), isLast: true });
    }
    if (p === '/rest/api/3/search/jql' && JSON.parse(body).jql.startsWith('key in (')) {
      const keys = /key in \((.*)\)/.exec(JSON.parse(body).jql)[1].split(', ');
      if (keys.some((k) => !issues[k])) return send({ errorMessages: ['An issue key does not exist'] }, 400);
      return send({ issues: keys.map(issueJson), isLast: true });
    }
    if (p === '/rest/api/3/search/jql' && JSON.parse(body).jql.startsWith('worklogAuthor = currentUser()')) {
      const keys = [...new Set(posted.filter((w) => !w.deleted).map((w) => w.key))];
      return send({ issues: keys.map((key) => ({ key, fields: { summary: issues[key]?.summary ?? `Summary of ${key}`, timetracking: timetracking(key) } })), isLast: true });
    }
    if (p === '/rest/api/3/search/jql') return send({ issues: [{ key: 'OPS-12', fields: { summary: 'Rotate staging credentials' } }] });
    if (p === '/rest/api/3/issue/picker') return send({ sections: [{ issues: [{ key: 'OPS-12', summaryText: 'Rotate staging credentials' }] }] });
    if (/^\/rest\/api\/3\/issue\/[A-Z]+-\d+\/worklog$/.test(p) && req.method === 'POST') {
      const id = String(1001 + posted.length);
      posted.push({ id, key: p.split('/')[5], ...JSON.parse(body), xsrf: req.headers['x-atlassian-token'] });
      return send({ id }, 201);
    }
    const one = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/worklog\/(\d+)$/.exec(p);
    if (one) {
      const log = posted.find((w) => w.key === one[1] && w.id === one[2] && !w.deleted);
      if (!log) return send({ errorMessages: ['no worklog'] }, 404);
      edits.push({ method: req.method, key: one[1], id: one[2], body: body ? JSON.parse(body) : null });
      if (req.method === 'DELETE') {
        log.deleted = true;
        res.writeHead(204);
        return res.end();
      }
      Object.assign(log, JSON.parse(body));
      return send({ id: log.id });
    }
    if (p.endsWith('/worklog')) {
      const key = p.split('/')[5];
      return send({ worklogs: posted.filter((w) => w.key === key && !w.deleted).map((w) => ({ ...w, author: { accountId: 'me' } })) });
    }
    const single = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)$/.exec(p);
    if (single && issues[single[1]]) return send(issueJson(single[1]));
    send({ errorMessages: ['not found'] }, 404);
  });
});
await new Promise((r) => server.listen(0, r));
const site = `http://localhost:${server.address().port}`;

const ext = resolve('dist');
// BROWSER=msedge runs the same checks in Microsoft Edge. Otherwise use full
// Chromium: Playwright's default headless shell can't load extensions.
const executablePath = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const launch = process.env.BROWSER === 'msedge' ? { channel: 'msedge' } : executablePath ? { executablePath } : { channel: 'chromium' };
console.log('browser:', launch.channel ?? launch.executablePath);
const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'ljt-')), {
  ...launch,
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
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

  // A pull request without a Jira key is kept as unassigned work.
  // A different host than the fake Jira, which only counts /browse pages.
  await issueTab.goto(`${site.replace('localhost', '127.0.0.1')}/acme/api/pull/51`);
  await worker.evaluate(() => new Promise((r) => setTimeout(r, 500)));
  const prKey = await worker.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return Object.entries(all).filter(([k]) => k.startsWith('hb:')).flatMap(([, v]) => v).find((h) => h.key.startsWith('~'))?.key;
  });
  console.log('keyless PR bucket:', prKey);
  if (!prKey) fail('no unassigned heartbeat for the keyless PR');

  // 3. Seed a realistic morning (52 min on PAY-7, 20 on PAY-8, 25 unassigned-free) so the review has content.
  await worker.evaluate(async (prKey) => {
    const day = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const key = `hb:${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9, 0).getTime();
    const beats = [];
    for (let m = 0; m <= 52; m++) beats.push({ t: start + m * 60000, repo: 'localhost', branch: 'PAY-7', key: 'PAY-7', signal: 'tick' });
    for (let m = 60; m <= 80; m++) beats.push({ t: start + m * 60000, repo: 'github.com', branch: 'PAY-8', key: 'PAY-8', signal: 'tick' });
    for (let m = 81; m <= 111; m++) beats.push({ t: start + m * 60000, repo: 'github.com', branch: prKey, key: prKey, signal: 'tick' });
    await chrome.storage.local.set({
      [key]: beats,
      notes: [
        { t: start + 70 * 60000, repo: 'github.com', branch: 'PAY-8', hash: 'gh/1', subject: 'PAY-8 Export payouts as CSV (#42)' },
        { t: start + 85 * 60000, repo: 'github.com', branch: prKey, hash: 'gh/51', subject: 'Fix payout CSV export (#51)' },
      ],
      lastSeen: null,
    });
  }, prKey);

  // 4. Review page.
  const review = await context.newPage();
  await review.goto(page('review.html'));
  await review.waitForSelector('.row');
  await review.waitForTimeout(500);
  const rows = await review.$$eval('.row', (rs) => rs.map((r) => r.querySelector('.row-key > .key').textContent + ' ' + r.querySelector('.row-time').textContent));
  console.log('review rows:', rows.join(' | '));
  const heading = (pg, key) => pg.$eval(`.row:has(.row-key > .key:text-is("${key}"))`, (r) => [r.querySelector('.row-title')?.textContent ?? '', r.querySelector('.estimate-label')?.textContent ?? 'no bar']);
  const pay7 = await heading(review, 'PAY-7');
  console.log('PAY-7 heading:', pay7.join(' · '), '· OPS-12:', (await heading(review, 'OPS-12')).join(' · '));
  if (pay7[0] !== 'Refund flow for card payments' || pay7[1] !== '1h + 1h of 4h') fail('review row is missing the title or the estimate with pending time');
  if ((await heading(review, 'OPS-12'))[1] !== 'no bar') fail('a ticket without an estimate shows a bar');
  if (shots) await review.screenshot({ path: join(shots, 'review.png'), fullPage: true });

  // Open the PAY-7 row, bump it 15 minutes, log it.
  await review.click('.row:has(.row-key > .key:text-is("PAY-7")) .row-main');
  if (shots) await review.screenshot({ path: join(shots, 'review-open.png'), fullPage: true });
  await review.click('.row.open .stepper button:last-child');
  await review.click('.row.open .btn-primary');
  await review.waitForSelector('.row.done');
  await review.waitForFunction(() => document.querySelector('.row.done .estimate-label')?.textContent === '2h 15m of 4h');
  console.log('posted:', JSON.stringify(posted));
  if (posted.length !== 1 || posted[0].timeSpentSeconds !== 4500 || posted[0].xsrf !== 'no-check') fail('unexpected worklog post');

  // 4b. Your ticket list: fetch assigned, search, paste, flag, group and reorder.
  const tickets = await context.newPage();
  await tickets.goto(page('tickets.html'));
  await tickets.waitForSelector('.empty');
  await tickets.click('#fetch-assigned');
  // Headings for epics and "No epic" are rows too, so count only the tickets.
  const ticketCount = (n) => tickets.waitForFunction((n) => document.querySelectorAll('.ticket:not(.parent)').length === n, n);
  await ticketCount(3);
  await tickets.fill('#search', 'rotate');
  await tickets.waitForSelector('#results li');
  await tickets.click('#results li:has-text("OPS-12")');
  await ticketCount(4);
  await tickets.click('#paste-toggle');
  await tickets.fill('#paste-text', 'ops-13 NOPE-1');
  await tickets.click('#paste-add');
  await ticketCount(5);
  const shown = () => tickets.$$eval('.ticket', (rs) => rs.map((r) => `${r.dataset.key}${r.style.getPropertyValue('--depth').trim() === '1' ? '(sub)' : ''}`).join(' '));
  console.log('ticket list:', await shown());
  // PAY-9 is a sub-task of PAY-8, so it joins PAY-8's epic; the rest have no epic.
  if ((await shown()) !== 'PAY-1 PAY-9(sub) PAY-8(sub) no-epic OPS-13(sub) OPS-12(sub) PAY-7(sub)') fail('tickets are not newest first, grouped by epic');
  if ((await tickets.textContent('.ticket.parent[data-key="PAY-1"] .ticket-meta')) !== 'Epic, not on your list') fail('epic heading not labelled');
  await tickets.click('.ticket[data-key="OPS-12"] .flag');
  await tickets.check('.ticket[data-key="PAY-7"] input[type=checkbox]');
  await tickets.check('.ticket[data-key="PAY-9"] input[type=checkbox]');
  await tickets.click('#sel-flag');
  await tickets.waitForFunction(() => document.querySelectorAll('.flag[aria-pressed="true"]').length === 3);
  await tickets.check('.ticket[data-key="PAY-9"] input[type=checkbox]');
  await tickets.click('#sel-unflag');
  await tickets.waitForFunction(() => document.querySelectorAll('.flag[aria-pressed="true"]').length === 2);
  await tickets.dragAndDrop('.ticket[data-key="PAY-7"]', '.ticket[data-key="OPS-13"]', { targetPosition: { x: 200, y: 5 } });
  await tickets.waitForFunction(() => document.querySelector('.ticket[data-key="no-epic"]').nextElementSibling.dataset.key === 'PAY-7');
  await tickets.focus('.ticket[data-key="PAY-8"] .handle');
  await tickets.keyboard.press('ArrowUp');
  await tickets.waitForFunction(() => document.querySelectorAll('.ticket')[1].dataset.key === 'PAY-8');
  // "No epic" stays last: an epic can't move below it.
  await tickets.focus('.ticket[data-key="PAY-1"] .handle');
  await tickets.keyboard.press('ArrowDown');
  console.log('after drag and keyboard move:', await shown(), '·', await tickets.textContent('#list-title'));
  if ((await shown()) !== 'PAY-1 PAY-8(sub) PAY-9(sub) no-epic PAY-7(sub) OPS-13(sub) OPS-12(sub)') fail('drag or keyboard reorder did not stick');
  const storedTickets = await worker.evaluate(async () => (await chrome.storage.local.get('tickets')).tickets);
  if (!storedTickets.manualOrder || storedTickets.tickets.map((t) => t.key).join(' ') !== 'PAY-8 PAY-9 PAY-7 OPS-13 OPS-12') fail('ticket order was not saved');
  if (shots) await tickets.screenshot({ path: join(shots, 'tickets.png'), fullPage: true });
  await tickets.reload();
  await tickets.waitForSelector('.ticket');
  if ((await shown()) !== 'PAY-1 PAY-8(sub) PAY-9(sub) no-epic PAY-7(sub) OPS-13(sub) OPS-12(sub)') fail('ticket order lost after reload');
  await tickets.waitForFunction(() => document.querySelector('.ticket[data-key="PAY-7"] .estimate-label')?.textContent === '2h 15m of 4h');
  if (await tickets.$('.ticket[data-key="OPS-12"] .estimate')) fail('a ticket without an estimate shows a bar on the list');
  console.log('ticket list estimate: PAY-7', await tickets.textContent('.ticket[data-key="PAY-7"] .estimate-label'));

  // Stories of an epic that isn't on the list group under it, and the group collapses.
  await tickets.click('#paste-toggle');
  await tickets.fill('#paste-text', 'PAY-11 PAY-12');
  await tickets.click('#paste-add');
  await tickets.waitForSelector('.ticket.parent[data-key="PAY-10"]');
  console.log('grouped by epic:', await shown());
  if (!(await shown()).startsWith('PAY-10 PAY-12(sub) PAY-11(sub) ')) fail('stories were not grouped under their epic');
  await tickets.check('.ticket.parent[data-key="PAY-10"] input[type=checkbox]');
  if ((await tickets.textContent('#selection-count')) !== '2 selected') fail('epic checkbox did not select its tickets');
  await tickets.click('#sel-clear');
  await tickets.click('.ticket[data-key="PAY-10"] .toggle');
  await tickets.waitForFunction(() => !document.querySelector('.ticket[data-key="PAY-11"]'));
  await tickets.reload();
  await tickets.waitForSelector('.ticket.parent');
  if ((await tickets.$('.ticket[data-key="PAY-11"]')) || (await tickets.getAttribute('.ticket[data-key="PAY-10"] .toggle', 'aria-expanded')) !== 'false') fail('collapsed group did not stay collapsed');
  if (shots) await tickets.screenshot({ path: join(shots, 'tickets-collapsed.png'), fullPage: true });
  await tickets.click('#collapse-all');
  await tickets.waitForFunction(() => document.querySelectorAll('.ticket').length === 3);
  if ((await shown()) !== 'PAY-10 PAY-1 no-epic') fail('collapse all left tickets showing');
  if (!(await tickets.isDisabled('#collapse-all'))) fail('collapse all still enabled with everything collapsed');
  await tickets.click('#expand-all');
  await tickets.waitForSelector('.ticket[data-key="OPS-13"]');
  if (!(await shown()).startsWith('PAY-10 PAY-12(sub) PAY-11(sub) ') || !(await tickets.isDisabled('#expand-all'))) fail('expand all did not open every group');
  console.log('collapse all and expand all: ok');
  if (shots) await tickets.screenshot({ path: join(shots, 'tickets.png'), fullPage: true });
  if (shots) {
    await tickets.emulateMedia({ colorScheme: 'dark' });
    await tickets.screenshot({ path: join(shots, 'tickets-dark.png'), fullPage: true });
  }

  // 5. Fill in with AI through a (fake) Cursor key.
  await worker.evaluate(async (site) => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, cursorApiKey: 'cur_test', cursorApiUrl: site } });
  }, site);
  await review.reload();
  await review.waitForSelector('.ai-button');
  await review.click('.ai-button');
  await review.click('.ai-composer .btn-primary');
  await review.waitForSelector('.note.ai', { timeout: 15000 });
  const matched = await review.$eval('.row:has(.note.ai)', (r) => `${r.querySelector('.row-key > .key').textContent}: ${r.querySelector('.note').textContent}`);
  console.log('AI match:', matched);
  const prompt = cursorCalls[0]?.body.prompt.text ?? '';
  if (cursorCalls[0]?.auth !== 'Bearer cur_test') fail('Cursor call missing the bearer key');
  if (cursorCalls[0]?.body.repos) fail('Cursor agent should run without a repo');
  if (!cursorCalls.some((c) => c.deleted)) fail('Cursor agent was not cleaned up');
  if (!prompt.includes('Fix payout CSV export (#51)') || prompt.includes('/acme/api/pull')) fail('unexpected Cursor prompt');
  if (!matched.startsWith('PAY-9')) fail('unassigned PR was not matched to PAY-9');
  if (shots) await review.screenshot({ path: join(shots, 'review-ai.png'), fullPage: true });
  await review.click('.row:has(.note.ai) .row-main');
  const comment = await review.inputValue('.row.open textarea');
  console.log('AI comment:', comment);
  if (shots) await review.screenshot({ path: join(shots, 'review-ai-open.png'), fullPage: true });
  await review.click('.row.open .btn-primary');
  await review.waitForFunction(() => document.querySelectorAll('.row.done').length >= 1 && !document.querySelector('.row.open'));
  const pay9 = posted.find((p) => p.key === 'PAY-9');
  console.log('posted after AI:', JSON.stringify(pay9));
  if (!pay9 || pay9.timeSpentSeconds !== 1800 || pay9.comment.content[0].content[0].text !== 'Fixed the payout CSV export.') fail('AI-matched entry did not post as expected');

  // 6. Describe the day: AI adds entries for work nothing tracked.
  await review.click('.ai-button');
  await review.fill('.ai-composer textarea', 'Demoed payout reports to finance for 45m, then a 30 minute interview.');
  if (shots) await review.screenshot({ path: join(shots, 'review-summary.png'), fullPage: true });
  await review.click('.ai-composer .btn-primary');
  await review.waitForFunction(() => document.querySelectorAll('.note.ai').length >= 2, null, { timeout: 15000 });
  const added = await review.$$eval('.row', (rs) =>
    rs.filter((r) => /Added from your summary/.test(r.textContent)).map((r) => `${r.querySelector('.row-key > .key').textContent} ${r.querySelector('.row-time').textContent}`),
  );
  console.log('AI added from summary:', added.join(' | '));
  if (!cursorCalls.at(-2)?.body?.prompt.text.includes('"personSummary": "Demoed payout reports')) fail('summary was not sent to Cursor');
  if (added.join('|') !== 'PAY-8 45m|Unassigned 30m') fail('unexpected entries from the day summary');
  const summaryPrompt = cursorCalls.at(-2)?.body?.prompt.text ?? '';
  if (!summaryPrompt.includes('"savedIssues"') || summaryPrompt.indexOf('"key": "PAY-7"') > summaryPrompt.indexOf('"key": "PAY-9"')) fail('saved tickets were not sent flagged-first');
  if (shots) await review.screenshot({ path: join(shots, 'review-summary-ai.png'), fullPage: true });

  // Cursor asked where the interview goes; only tickets you may use are offered.
  await review.waitForSelector('.ask');
  const askOptions = await review.$$eval('.ask-option strong', (os) => os.map((o) => o.textContent));
  console.log('AI question:', await review.textContent('.ask-q'), '· options:', askOptions.join(', '));
  if (askOptions.join('|') !== 'OPS-12|OPS-13') fail('question options should be OPS-12 and OPS-13 only');
  if (shots) await review.screenshot({ path: join(shots, 'review-question.png'), fullPage: true });
  await review.click('.ask-option:has-text("OPS-13")');
  await review.waitForSelector('.row:has(.row-key > .key:text-is("OPS-13"))');
  if (await review.$('.ask')) fail('question did not close after answering');
  const answers = await worker.evaluate(async () => (await chrome.storage.local.get('ai')).ai.answers);
  if (answers?.[0] !== 'OPS-13') fail('answer was not remembered');
  // The issue picker offers your list first, flagged tickets on top.
  await review.click('.row:has(.row-key > .key:text-is("OPS-13")) .row-main');
  await review.fill('.row.open .search input', '');
  await review.waitForSelector('.row.open .results li');
  const picks = await review.$$eval('.row.open .results li strong', (ls) => ls.map((l) => l.textContent));
  console.log('picker before typing:', picks.join(', '));
  if (picks[0] !== 'PAY-7' || picks[1] !== 'OPS-12') fail('picker should start with flagged tickets from your list');
  await review.fill('.row.open .search input', 'OPS-13');
  await review.click('.row:has(.row-key > .key:text-is("OPS-13")) .row-main');
  await review.click('.row:has(.row-key > .key:text-is("PAY-8")):has(.note.ai) .row-main');
  await review.click('.row.open .btn-primary');
  await review.waitForFunction(() => !document.querySelector('.row.open'));
  const demo = posted.find((p) => p.key === 'PAY-8');
  console.log('posted from summary:', JSON.stringify(demo));
  if (!demo || demo.timeSpentSeconds !== 2700) fail('summary entry did not post as expected');

  // 7. Calendar: see, edit and delete what was logged.
  const cal = await context.newPage();
  await cal.goto(page('calendar.html'));
  await cal.waitForSelector('#day .row', { timeout: 10000 });
  const logged = await cal.$$eval('#day .row', (rs) => rs.map((r) => `${r.querySelector('.row-key > .key').textContent} ${r.querySelector('.row-time').textContent}`));
  console.log('calendar day:', logged.join(' | '), '· month:', await cal.textContent('#month-total'));
  if (logged.length !== 3) fail('calendar should list the three worklogs logged today');
  if (shots) await cal.screenshot({ path: join(shots, 'calendar.png'), fullPage: true });
  const pay8 = await heading(cal, 'PAY-8');
  console.log('calendar PAY-8 heading:', pay8.join(' · '));
  if (pay8[0] !== 'Payout reports for finance' || !(await cal.$('#day .estimate.over'))) fail('calendar row is missing the title or the over-estimate bar');
  await cal.click('#day .row:has(.row-key > .key:text-is("PAY-7")) .row-main');
  await cal.fill('.row.open .duration', '1h');
  await cal.fill('.row.open textarea', 'Card refunds, edited');
  if (shots) await cal.screenshot({ path: join(shots, 'calendar-edit.png'), fullPage: true });
  await cal.click('.row.open .btn-primary');
  await cal.waitForFunction(() => !document.querySelector('.row.open'));
  await cal.click('#day .row:has(.row-key > .key:text-is("PAY-9")) .row-main');
  await cal.click('.row.open .btn-danger');
  await cal.click('.row.open .btn-danger');
  await cal.waitForFunction(() => document.querySelectorAll('#day .row').length === 2);
  console.log('calendar edits:', JSON.stringify(edits.map((e) => [e.method, e.key, e.body?.timeSpentSeconds ?? null])));
  const put = edits.find((e) => e.method === 'PUT');
  if (!put || put.key !== 'PAY-7' || put.body.timeSpentSeconds !== 3600 || put.body.comment.content[0].content[0].text !== 'Card refunds, edited') fail('calendar edit did not reach Jira');
  if (!edits.some((e) => e.method === 'DELETE' && e.key === 'PAY-9')) fail('calendar delete did not reach Jira');
  await cal.reload();
  await cal.waitForSelector('#day .row');
  const after = await cal.$$eval('#day .row', (rs) => rs.map((r) => `${r.querySelector('.row-key > .key').textContent} ${r.querySelector('.row-time').textContent}`));
  console.log('calendar after reload:', after.join(' | '));
  if (after.join('|') !== 'PAY-7 1h|PAY-8 45m') fail('calendar does not show the edits after reload');
  if (shots) {
    await cal.emulateMedia({ colorScheme: 'dark' });
    await cal.screenshot({ path: join(shots, 'calendar-dark.png'), fullPage: true });
  }
  await cal.emulateMedia({ colorScheme: 'light' });

  // Move a log to another ticket: Jira adds it there and deletes the original.
  await cal.click('#day .row:has(.row-key > .key:text-is("PAY-8")) .row-main');
  await cal.fill('.row.open .search input', 'rotate');
  await cal.waitForSelector('.row.open .results li:has-text("OPS-12")');
  if (shots) await cal.screenshot({ path: join(shots, 'calendar-move.png'), fullPage: true });
  await cal.click('.row.open .results li:has-text("OPS-12")');
  await cal.click('.row.open .btn-primary');
  await cal.waitForFunction(() => !document.querySelector('.row.open'));
  await cal.waitForSelector('#day .row:has(.row-key > .key:text-is("OPS-12")) .row-title');
  const moved = await cal.$$eval('#day .row', (rs) => rs.map((r) => `${r.querySelector('.row-key > .key').textContent} ${r.querySelector('.row-time').textContent}`));
  console.log('calendar after move:', moved.join(' | '), '·', await cal.textContent('#toast'));
  if (moved.join('|') !== 'PAY-7 1h|OPS-12 45m') fail('move did not show on the calendar');
  const copy = posted.find((w) => w.key === 'OPS-12' && !w.deleted);
  if (!copy || copy.timeSpentSeconds !== 2700 || !posted.find((w) => w.key === 'PAY-8' && w.deleted)) fail('move did not add to OPS-12 and delete from PAY-8');
  await cal.reload();
  await cal.waitForSelector('#day .row');
  const reloaded = await cal.$$eval('#day .row', (rs) => rs.map((r) => r.querySelector('.row-key > .key').textContent).join('|'));
  if (reloaded !== 'PAY-7|OPS-12') fail(`moved log did not stick after reload: ${reloaded}`);

  // Add log on an earlier day opens the review on that day.
  const pad = (n) => String(n).padStart(2, '0');
  const ago = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const earlier = ago(2);

  // Change a log's date: it moves to that day, and the calendar follows it.
  const yesterday = ago(1);
  await cal.click('#day .row:has(.row-key > .key:text-is("OPS-12")) .row-main');
  await cal.fill('.row.open input.date', yesterday);
  if (shots) await cal.screenshot({ path: join(shots, 'calendar-date.png'), fullPage: true });
  await cal.click('.row.open .btn-primary');
  await cal.waitForFunction((d) => document.querySelector('.cal-day.selected')?.dataset.day === d && document.querySelector('#day .row'), yesterday);
  const redated = edits.findLast((e) => e.method === 'PUT');
  const onYesterday = await cal.$$eval('#day .row', (rs) => rs.map((r) => r.querySelector('.row-key > .key').textContent).join('|'));
  console.log('re-dated:', redated?.key, redated?.body.started, '· now on', yesterday, ':', onYesterday);
  if (redated?.key !== 'OPS-12' || !redated.body.started.startsWith(yesterday) || onYesterday !== 'OPS-12') fail('changing the date did not move the log');
  if (!(await cal.$(`.cal-day[data-day="${earlier}"]`))) await cal.click('#prev');
  await cal.click(`.cal-day[data-day="${earlier}"]`);
  await cal.click('#add-log');
  await cal.waitForURL(`**/review.html?day=${earlier}`);
  await cal.waitForSelector('#add-entry');
  const eyebrow = await cal.textContent('#date');
  const selectedChip = await cal.getAttribute('.week .cal-day[aria-pressed="true"]', 'data-day');
  console.log('review opened on:', eyebrow, '· chip', selectedChip);
  if (selectedChip !== earlier) fail('review did not open on the day picked in the calendar');
  await cal.click('#add-entry');
  await cal.fill('.row.open .search input', 'rotate');
  await cal.click('.row.open .results li:has-text("OPS-12")');
  await cal.fill('.row.open .duration', '1h 30m');
  await cal.fill('.row.open textarea', 'Rotated staging keys');
  if (shots) await cal.screenshot({ path: join(shots, 'review-other-day.png'), fullPage: true });
  await cal.click('.row.open .btn-primary');
  await cal.waitForSelector('.row.done');
  const back = posted.at(-1);
  console.log('posted on an earlier day:', back.key, back.timeSpentSeconds, back.started);
  if (back.key !== 'OPS-12' || back.timeSpentSeconds !== 5400 || !back.started.startsWith(`${earlier}T09:00`)) fail('entry on an earlier day did not post on that day');
  await cal.waitForFunction((d) => document.querySelector(`.week .cal-day[data-day="${d}"] .cal-time`)?.textContent === '1h 30m', earlier);

  // The strip switches days, with a dot and a link where time waits to be logged.
  await cal.click('#next-day');
  await cal.click('#to-today');
  await cal.waitForFunction(() => !location.search.includes('day='));
  const pendingToday = await cal.$('.week .cal-day.today.pending');
  console.log('today has a pending dot:', !!pendingToday, '· next-day disabled:', await cal.isDisabled('#next-day'));
  if (!(await cal.isDisabled('#next-day'))) fail('the review lets you go past today');
  if (shots) await cal.screenshot({ path: join(shots, 'review-week.png'), fullPage: true });

  // Popup-sized and dark-mode views.
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 380, height: 600 });
  await popup.goto(page('review.html?popup=1'));
  await popup.waitForTimeout(800);
  if (shots) await popup.screenshot({ path: join(shots, 'popup.png') });
  await popup.emulateMedia({ colorScheme: 'dark' });
  if (shots) await popup.screenshot({ path: join(shots, 'popup-dark.png') });
  await popup.emulateMedia({ colorScheme: 'light' });

  // Tabs switch views inside the popup without opening a browser tab.
  const pagesBefore = context.pages().length;
  for (const [label, file, ready] of [
    ['Tickets', 'tickets.html', '#list'],
    ['Calendar', 'calendar.html', '#cal .cal-day'],
    ['Review', 'review.html', '#days'],
  ]) {
    await popup.click(`#tabs a:text-is("${label}")`);
    await popup.waitForURL(`**/${file}?popup=1`);
    await popup.waitForSelector(ready);
    await popup.waitForTimeout(400);
    const current = await popup.textContent('#tabs a[aria-current="page"]');
    if (current !== label) fail(`popup tab bar marks ${current} instead of ${label}`);
    if (!(await popup.evaluate(() => document.body.classList.contains('popup')))) fail(`${file} lost the popup layout`);
    if (shots && label !== 'Review') await popup.screenshot({ path: join(shots, `popup-${label.toLowerCase()}.png`) });
  }
  if (context.pages().length !== pagesBefore) fail('switching popup tabs opened a new browser tab');
  console.log('popup tabs: switched in place');

  // In a full tab, Settings is a tab too.
  await cal.bringToFront();
  await cal.click('#tabs a:text-is("Settings")');
  await cal.waitForURL('**/options.html');
  await cal.click('#tabs a:text-is("Tickets")');
  await cal.waitForURL('**/tickets.html');
  if (context.pages().length !== pagesBefore) fail('switching tabs in a page opened a new browser tab');

  const badge = await worker.evaluate(() => chrome.action.getBadgeText({}));
  console.log('badge:', badge);
} catch (err) {
  fail(err.stack || err.message);
} finally {
  await context.close();
  server.close();
}
console.log(process.exitCode ? 'E2E FAILED' : 'E2E PASSED');
