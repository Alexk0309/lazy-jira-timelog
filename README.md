# Lazy Jira Timelog

A Cursor / VS Code extension that tracks how long you actively code on each git branch, works out which Jira issue that time belongs to, and turns it into worklogs you confirm in one click. No timers to start or stop, no server, no Slack bot.

## How it works

1. **Capture.** While a Cursor window is focused, edits, saves, cursor moves, scrolling, terminal and debug activity write small "heartbeats" (time, repo, branch, issue key) to local storage. Gaps longer than 15 minutes end a session. If the window loses focus, up to 2 minutes still count, so a quick look at docs in the browser isn't lost.
2. **Attribute.** Each heartbeat gets an issue key, in this order:
   1. a key in the branch name, e.g. `feature/PAY-142-refunds` (lower-case `pay-142` also works once the extension has read your Jira project keys);
   2. a key in a commit message you made on the branch;
   3. the repo's **Default issue** setting;
   4. otherwise the time is kept as **Unassigned**, and you pick the issue when you review.
3. **Review.** The status bar shows `⏱ 6h 10m to log`. Click it (or wait for the one 17:30 reminder) to open the review panel: one row per issue per day, rounded to 15 minutes, with the comment pre-filled from your commit subjects. Confirm, edit the time or comment, reassign, split or discard, then **Log all**.
4. **Log.** Each confirmed row becomes a Jira worklog posted with your own credentials. Posted and discarded time is remembered, so nothing is logged twice, and the panel warns you if you already logged time by hand on the same issue that day.

Raw activity never leaves your machine and is deleted after 30 days. Only the worklogs you confirm are sent to Jira.

## Install (pilot)

1. Download `lazy-jira-timelog-<version>.vsix`.
2. In Cursor: Command Palette → **Extensions: Install from VSIX...** → pick the file.
3. Command Palette → **Jira Timelog: Set Jira API token**. It asks for your Jira site (`https://your-team.atlassian.net`), your Atlassian email and an API token from <https://id.atlassian.com/manage-profile/security/api-tokens>. The token is stored in your OS keychain.
4. Run **Jira Timelog: Test Jira connection** to check it works.

That's it. Keep coding; review when the badge or the reminder tells you to.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `lazyJiraTimelog.siteUrl` | | Your Jira Cloud site URL |
| `lazyJiraTimelog.email` | | Your Atlassian account email |
| `lazyJiraTimelog.defaultIssue` | | Issue for branches with no key. Set it in a repo's `.vscode/settings.json` to make it per repo |
| `lazyJiraTimelog.idleMinutes` | 15 | A gap longer than this ends a session |
| `lazyJiraTimelog.roundMinutes` | 15 | Worklogs are rounded to the nearest multiple |
| `lazyJiraTimelog.minSessionMinutes` | 5 | Shorter sessions are dropped |
| `lazyJiraTimelog.reminderTime` | 17:30 | Daily reminder time; empty turns it off |
| `lazyJiraTimelog.retentionDays` | 30 | Raw activity older than this is deleted |

## Commands

- **Jira Timelog: Review and log time** opens the review panel.
- **Jira Timelog: Show which issue time is going to** explains the current attribution.
- **Jira Timelog: Set / Clear Jira API token**, **Test Jira connection**.

## Requirements

- Jira Cloud with time tracking turned on, and the **Work on issues** permission in the projects you log to.
- Cursor or VS Code 1.90+, with the built-in Git extension enabled.

## Development

```sh
npm install
npm test          # unit tests plus an end-to-end test against a fake editor and fake Jira
npm run typecheck
npm run build     # bundles to dist/extension.js
npm run package   # typecheck, test, build and produce the .vsix
```

Press F5 in VS Code or Cursor with this folder open to launch an Extension Development Host.

Code layout:

- `src/core/` holds pure logic with no editor dependency: issue key matching, sessions, drafts, rounding, reminders and time formats.
- `src/jira/client.ts` is a minimal Jira Cloud REST v3 client (worklogs, issue lookup, picker search, project keys).
- `src/tracker.ts` listens to editor and git events and writes heartbeats.
- `src/store.ts` is append-only JSON Lines storage in the extension's global storage folder.
- `src/timelog.ts`, `src/reviewPanel.ts`, `src/statusBar.ts` and `media/` make up the review flow and the badge.

## Known limits (MVP)

- Only time in the editor is captured. Meetings, browser code reviews and chat aren't.
- Authentication uses a personal API token. OAuth sign-in is planned for after the pilot.
- In remote or dev-container workspaces, branch detection works through the Git extension, but focus tracking hasn't been tested there yet.
