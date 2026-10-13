# Lazy Jira Timelog for Chrome and Edge

A browser extension for Google Chrome and Microsoft Edge that notices the time you spend on anything tied to a Jira issue, like the issue itself, a pull request or a design doc. At the end of the day it hands you a ready-made list of worklogs to send to Jira in one click. There's no timer, no server and no chat bot.

## What it does

- **Notices work, not browsing.** Only the focused tab counts, and only when it's about a Jira issue:
  - a Jira issue page or board with an issue open;
  - a GitHub, GitLab or Bitbucket pull request or branch whose title or name contains the key (for example `PAY-7`);
  - any other page that shows a known key, such as a Confluence page or Figma file.
  Everything else is ignored. Only the issue key and the site name are stored, never page addresses.
- **Stops when you do.** After 15 minutes without input, when the screen locks, or 2 minutes after you switch to something unrelated, time stops counting.
- **Suggests what it couldn't see.** Issues you moved, or that are assigned to you and changed today, appear under "Touched in Jira today", so meetings and offline work are easy to add.
- **One-click review.** The toolbar popup shows today's total and one row per issue, rounded to 15 minutes. Tap a row to change the issue, adjust time with the − / + stepper, edit the comment (PR titles are filled in for you), split or discard. Then press **Log**.
- **One reminder.** The badge shows unlogged time, and a single notification at 17:30 nudges you, only if something is unlogged.

## Install (pilot)

1. Download `lazy-jira-timelog-browser-<version>.zip` and unzip it.
2. Open the extensions page, turn on **Developer mode**, click **Load unpacked** and pick the unzipped folder.
   - Chrome: `chrome://extensions` (Developer mode is the switch at the top right).
   - Edge: `edge://extensions` (Developer mode is the switch in the left sidebar). The same zip works in both.
3. Settings opens automatically. Enter your Jira site, e.g. `https://your-team.atlassian.net`, and click **Test connection**.
   - **Browser** sign-in (default) reuses the Jira session you're already logged in to, so no token is needed.
   - **API token** is the fallback if your company blocks that. Create one at id.atlassian.com → Security → API tokens.
4. Self-hosted GitLab or another tool? Add its domain under **Sites**. The browser will ask you to allow it.

For a team rollout, publish the same zip as an unlisted item on the Chrome Web Store and a hidden listing on Microsoft Edge Add-ons, or push it with Google Admin or Intune, so updates arrive automatically.

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
- `src/ui/` and `static/` contain the popup/review page and Settings.

## Known limits

- Browser sign-in relies on Jira accepting cookie-authenticated API calls from the extension. If your site refuses, switch to an API token.
- Time spent outside the browser is only captured through the "Touched in Jira today" suggestions, unless you also use the Cursor extension.
