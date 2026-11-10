# Running and changing it

Source: `src/Config.js`, `src/Clients.js`, `src/Reporting.js`, `src/BulkProcess.js`, `.clasp.json`. Nothing on this page has been run on a live Google account. The steps follow Google's and clasp's documentation.

## Change the agency name

The name is `AGENCY_NAME` in `src/Config.js`. The example agency is `Fernwood Digital`. Change that one line, push, and the new name appears in the sender name of every email, in the dashboard, in the intake form title and in the names of the Drive folder and the template Doc.

The folder and the template are made once and then found again by id (`REPORT_FOLDER_ID` and `REPORT_TEMPLATE_ID` in the script properties). Changing the name later does not rename a folder that already exists. Rename it in Drive by hand.

## Add a client

Three ways, all end in a row in the Clients tab.

1. Type the row. The columns are `client`, `contact_name`, `contact_email`, `ad_account_id`, `primary_channel`, `monthly_budget`, `status`, `intake_response_id`, `created_at`. Set `status` to `active`. A client with any other status is left out of the sidebar picker and the month close. Fill `ad_account_id` if you pull ad costs, because the ad sync maps an account to a client with it.
2. Send the client the intake form. Run `installIntakeTrigger` once from the editor. The form link is written to the execution log at the bottom of the editor (see [intake-form.md](intake-form.md)). A good answer becomes an `active` row. A bad email or a repeated name becomes `needs_review`. Change that to `active` after you have looked at it.
3. The webhook does not add clients. A lead for a name that is not in the Clients tab is refused with `unknown_client`.

The webhook keeps the client list for 5 minutes. A client you type by hand is accepted by the webhook within 5 minutes. The intake form clears that list at once.

Client names must differ after punctuation is removed: `A/B Co` and `A-B Co` would share one summary tab and one PDF name, so the script refuses both.

## Add a channel

A channel is free text in the `channel` column of Campaigns. It is lower cased when it is read, so `Search` and `search` are one channel. No code change is needed, and the next summary and report show a new line for it.

The intake form offers a fixed list (`search`, `social`, `display`, `email`, `video`). To add one there, change the list in `ensureIntakeForm_` in `src/Forms.js`. An existing form keeps its old list until you delete the form and run `installIntakeTrigger` again.

## Add a column

Columns are read by position, so a new column goes at the end.

1. Add the header at the end of the list in `SD.HEADERS` in `src/Config.js`.
2. Change the code that reads or writes that sheet.
3. Add the same header to row 1 of the tab in the Sheet. Until you do, the script stops with `Sheet "X" has unexpected headers`. That stop is on purpose: a renamed or missing header would otherwise shift every value one column.
4. Add the header to `HEADERS` in `test/helpers/load.js` and to the generator in `scripts/seed.js`, then run `npm test`.

## Read the Report Log and the Job Log

**Report Log** has one row per client and month.

| Column | Meaning |
|---|---|
| `client`, `month` | the key. A rerun updates the row |
| `pdf_name`, `pdf_id` | the PDF in the Drive folder. The id changes on a rerun because the old file is trashed |
| `figures` | spend in cents, clicks and conversions joined by `|`. A new email goes out only when this changed |
| `emailed_at` | when the client was emailed. Empty means the client has not been emailed, for example after a "Send to me first" preview |
| `updated_at` | when the PDF was last built |

**Job Log** has one row per finished job: `job`, `run` (the month for a month close, `job-<start time>` for the bulk job), `started_at`, `ended_at`, `rows_done` and a `note`. For a month close the note is `complete`, or `pending:` and the clients still waiting. Run the close again to finish those.

Months such as `2026-10` are written as text in both logs and in the summary tabs. Sheets would otherwise turn them into dates.

## Script properties

Open the editor, Project settings, Script properties. The properties are listed with a note each in `SD.PROP_NOTES` in `src/Config.js`.

| Property | Use |
|---|---|
| `WEBHOOK_SECRET` | made by Set up. Replace the value to rotate it |
| `REPORT_CC` | optional, one address. Copied on every email to a client. Also receives "Send to me first" previews when Google gives no address for the person running the script |
| `AD_API_BASE` | optional. The ad platform base URL. Without it the stand-in host `https://ads.example.test` is used, and that host exists only in the tests |
| `AD_API_KEY` | needed to pull ad costs |
| `SPREADSHEET_ID` | only for a script that is not bound to the Sheet |
| `REPORT_FOLDER_ID`, `REPORT_TEMPLATE_ID`, `INTAKE_FORM_ID` | made by the script. Delete one to make a new folder, template or form |
| `BULK_CURSOR` | internal. Where the bulk job stands |

## Start the bulk job

The bulk job cleans every Campaigns row into the Clean tab and writes the Rollup tab (see [scale.md](scale.md)). There is no menu item for it. In the editor, pick `startBulkNormalize` in the function list and press Run. It does the first run, then time triggers finish it. Watch the Job Log tab for the line `bulk normalize`.

To drop a job that is stuck: in Project settings delete the `BULK_CURSOR` property, open Triggers (the clock icon) and delete any `continueBulkJob` trigger, then run `startBulkNormalize` again.

## Scopes

`src/appsscript.json` lists the permissions the script asks for. Each one below is the scope that Google's Apps Script reference lists for a method this repo calls. `test/manifest.test.js` checks that the list is exactly this one and that every feature stops when any one of them is removed.

| Scope | Why |
|---|---|
| `spreadsheets` | read and write the Sheet. The narrower `spreadsheets.currentonly` does not cover `SpreadsheetApp.openById`, which the script uses when it is not bound to a Sheet |
| `documents` | build the report from a template Doc |
| `drive` | copy the template, save the PDF, trash the working copy and the older PDF. The reference lists no narrower scope for these calls |
| `script.send_mail` | email the report and the intake confirmation with `MailApp.sendEmail` |
| `forms` | create the intake form |
| `script.external_request` | call the ad platform and the rates API |
| `script.scriptapp` | create the form trigger and the bulk job triggers |
| `script.container.ui` | the menu, the sidebar and the dialog |
| `userinfo.email` | find the address of the person running the script for "Send to me first" |

The script sends mail with `MailApp`, not `GmailApp`. The reference lists only `https://mail.google.com/` for every `GmailApp` method, which is access to the whole mailbox. `MailApp.sendEmail` takes the same options (attachments, cc, sender name) and needs only `script.send_mail`.

The script has not been submitted for Google's OAuth verification. Expect Google to show "Google hasn't verified this app" when you first authorise it (see [Google's page on unverified apps](https://developers.google.com/apps-script/guides/client-verification)). You wrote or deployed the script yourself, so choose Advanced, then Go to the project name, then Allow.

## Roll a version with clasp

`clasp push` uploads `src/`. The folder is set by `rootDir` in `.clasp.json`, which also puts `Config.js` and `Util.js` first with `filePushOrder`.

```bash
clasp push
clasp create-version "what changed"
clasp list-deployments
clasp update-deployment <deploymentId>
```

`update-deployment` points an existing web app deployment at a new version, so the URL that Zapier or Make holds does not change. `clasp create-deployment` makes a new deployment with a new URL. These are the clasp 3 command names. Older clasp versions call them `version` and `deploy`.

`.clasp.json` holds no script id. Add your own when you set up (see the README). Do not commit it.

## When a trigger stops

Open the editor, then Triggers (the clock icon) for the list and Executions for the errors.

- **Authorization is required.** A trigger runs in the background and cannot ask for a permission that was revoked or never granted. Google says such a run fails at once with that message ([Authorization Scopes](https://developers.google.com/apps-script/concepts/scopes)). Run a function from the editor and accept the permission prompt again, then check the next trigger run in Executions.
- **Intake form trigger.** Run `installIntakeTrigger` again. It removes the old trigger and makes one new one, so it is safe to repeat.
- **Bulk job trigger.** The job saves its place after every chunk, so run `continueBulkJob` from the editor. If the Job Log shows no `bulk normalize` line and nothing is running, start again as described above.
- **Daily trigger time.** A consumer account has 90 minutes of trigger runtime a day. A very large job can use it up and carry on the next day.
- **Lead webhook.** It is a web app, not a trigger. If Zapier or Make gets `server_error`, open Executions, find the failed `doPost` run and read the message. The message is in the log and never in the reply.
