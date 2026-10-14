# Lazy Jira Timelog for Chrome and Edge

A browser extension for Google Chrome and Microsoft Edge that notices the time you spend on anything tied to a Jira issue, like the issue itself, a pull request or a design doc. At the end of the day it hands you a ready-made list of worklogs to send to Jira in one click. There's no timer, no server and no chat bot.

## What it does

- **Notices work, not browsing.** Only the focused tab counts, and only when it's about a Jira issue:
  - a Jira issue page or board with an issue open;
  - a GitHub, GitLab or Bitbucket pull request or branch whose title or name contains the key (for example `PAY-7`);
  - any other page that shows a known key, such as a Confluence page or Figma file;
  - a pull request without a key, kept as **Unassigned** time under the PR title so you can pick the issue at review.
  Everything else is ignored. Only the issue key, the site name and PR titles are stored, never page addresses.
- **Stops when you do.** After 15 minutes without input, when the screen locks, or 2 minutes after you switch to something unrelated, time stops counting.
- **Suggests what it couldn't see.** Issues you moved, or that are assigned to you and changed today, appear under "Touched in Jira today", so meetings and offline work are easy to add.
- **One-click review.** The toolbar popup shows today's total and one row per issue, rounded to 15 minutes. Tap a row to change the issue, adjust time with the − / + stepper, edit the comment (PR titles are filled in for you), split or discard. Then press **Log**.
- **Fill in with AI (optional).** Add a Cursor API key in Settings and each day on the review screen gets a **Fill in with AI** button. Cursor writes a one-line comment for every entry and matches unassigned time to one of the open issues assigned to you, with a short reason. Matches are checked in code against your assigned issues, and nothing is logged until you press **Log**.
- **Describe your day (optional, with AI).** Press **Fill in with AI** and, if you like, write a line about your day, such as "standup 15m, 1h pairing on PAY-12, sprint planning". Cursor uses the times you mention and adds entries for meetings and other work nothing tracked. Issues come only from those assigned to you or the ones you name yourself; anything else is left for you to pick.
- **Your ticket list.** The **Tickets** tab shows the tickets you're working on. Search Jira to add one, paste a batch of keys or links, or fetch every open ticket assigned to you in one click. Flag the ones that are a priority right now, one at a time or by selecting several. Tickets are grouped under their parent: sub-tasks sit under a parent on the list, and when the parent isn't on the list it still appears as a heading over its sub-tasks, whose checkbox selects them all. Collapse any parent with the count button beside it; the list remembers what you collapsed. The list starts newest-created first; drag a ticket (or use its handle with the arrow keys) to set your own order, and **Sort by created date** puts it back. Saved tickets show first in the issue picker, flagged ones on top.
- **AI that asks when unsure.** Fill in with AI matches time to your ticket list first, flagged tickets before the rest, which matters when Jira is shared by many teams. Where it can't tell which ticket some time belongs to, it asks, with two to four of your tickets as one-click answers, plus **Another issue…** and **Skip**.
- **Calendar of past worklogs.** The **Calendar** tab shows a month view of what you've logged in Jira, with hours per day. Pick a day to change a worklog's start time, duration or comment, or delete it.
- **Tabs, not new windows.** A tab bar at the top switches between Review, Tickets, Calendar and Settings in place, in the popup and in a full page. Settings opens in a page from the popup, since the browser's site-access prompt would close the popup. The arrow button opens the current view in a page.
- **One reminder.** The badge shows unlogged time, and a single notification at 17:30 nudges you, only if something is unlogged.

## Install (pilot)

You need [Git](https://git-scm.com/) and [Node.js](https://nodejs.org/) 18 or later.

1. Clone the repository and build the extension:

   ```sh
   git clone https://github.com/Alexk0309/lazy-jira-timelog.git
   cd lazy-jira-timelog/browser-extension
   npm install
   npm run build
   ```

   This creates a `dist` folder inside `browser-extension`. That folder is the extension.
2. Open the extensions page, turn on **Developer mode**, click **Load unpacked** and pick the `browser-extension/dist` folder.
   - Chrome: `chrome://extensions` (Developer mode is the switch at the top right).
   - Edge: `edge://extensions` (Developer mode is the switch in the left sidebar). The same `dist` folder works in both.
3. Settings opens automatically. Enter your Jira site, e.g. `https://your-team.atlassian.net`, and click **Test connection**.
   - **Browser** sign-in (default) reuses the Jira session you're already logged in to, so no token is needed.
   - **API token** is the fallback if your company blocks that. Create one at id.atlassian.com → Security → API tokens.
4. Self-hosted GitLab or another tool? Add its domain under **Sites**. The browser will ask you to allow it.
5. Optional: to use **Fill in with AI**, add a Cursor API key in Settings (see [Fill in with AI](#fill-in-with-ai)).

Pin the extension from the browser's puzzle-piece menu so its badge and popup are always visible.

### Updating

Pull the latest code and rebuild, then reload the extension:

```sh
cd lazy-jira-timelog/browser-extension
git pull
npm install
npm run build
```

On the extensions page, click the reload icon on the Lazy Jira Timelog card. Your settings, ticket list and tracked time are kept, because the extension stays loaded from the same `dist` folder. Don't remove the extension to update it, since that deletes its saved data.

For a wider rollout, `npm run package` builds a zip that can be published as an unlisted item on the Chrome Web Store and a hidden listing on Microsoft Edge Add-ons, or pushed with Google Admin or Intune, so updates arrive automatically.

## Fill in with AI

1. In Cursor, open **Dashboard → API Keys** and create a user API key.
2. Paste it under **AI with Cursor** in Settings. The browser asks once to allow `api.cursor.com`. Click **Test key**, and optionally pick a model.
3. On the review screen, press **Fill in with AI** next to a day.

Before pressing **Fill in**, you can describe the day in the box that opens. Without a description Cursor only writes comments and matches unassigned time. With one, it also sets the time for tracked entries you give a time for and adds new entries for work the browser couldn't see, each marked "Added from your summary". An issue key you type, such as `PAY-12`, may be used even if it isn't assigned to you, and so may any ticket on your list; every other match is checked against your open assigned issues.

Cursor gets your ticket list (up to 60, flagged first) and is told to prefer it. When two tickets fit about equally, it adds a question to the entry instead of guessing. Picking an answer fills in the ticket straight away, with no second run, and the answer is remembered if you close the popup. Every option is checked in code, so a question can only offer tickets you could have picked anyway. The text you type is kept on this computer until you send it, and is sent to Cursor only when you press **Fill in**.

How it works: the extension calls Cursor's Cloud Agents API directly. The Cursor SDK wraps the same API but needs Node, so it can't run in a browser. Each press starts one short agent with no repository, sends it that day's issue titles, PR titles and times plus your open assigned issues, reads its JSON answer and deletes the agent. Runs are billed to your Cursor plan. If Cursor answers 403, a team admin needs to allow agents without a repository. The API is in beta, and a run typically takes a little while, so the popup can be closed and reopened; the result is waiting when it's done.

## Development

```sh
cd browser-extension
npm install
npm test        # unit tests
npm run e2e     # loads the built extension in Chromium against a fake Jira and logs time end to end
BROWSER=msedge npm run e2e  # the same check in Microsoft Edge (npx playwright install msedge)
npm run build   # outputs dist/ (load it unpacked)
npm run package # typecheck, test, production build, zip
```

- `src/core/` holds the session, draft, rounding and reminder logic shared with the Cursor extension.
- `src/classify.ts` decides which Jira issue, if any, a tab is about.
- `src/tracker.ts` turns browser state into heartbeats; `src/background.ts` wires it to Chrome events and a 30-second alarm.
- `src/service.ts` and `src/jira.ts` cover drafts, posting worklogs, issue search and "touched today" suggestions.
- `src/core/tickets.ts` keeps your ticket list: ordering, flags and parent grouping.
- `src/ui/` and `static/` contain the popup/review page, the ticket list, the calendar and Settings.

## Known limits

- Browser sign-in relies on Jira accepting cookie-authenticated API calls from the extension. If your site refuses, switch to an API token.
- The ticket list is stored in this browser profile, so Chrome and Edge each keep their own.
- Time spent outside the browser is only captured through the "Touched in Jira today" suggestions, unless you also use the Cursor extension.
