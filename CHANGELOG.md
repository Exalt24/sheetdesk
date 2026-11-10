# Changelog

## 0.2.0, 2026-11-10

Changes after an independent review of 0.1.0.

- The manifest asked for `gmail.send`, which the Google reference does not list for any `GmailApp` method. Mail now goes through `MailApp`, which needs only `script.send_mail`. The fake in the tests accepts only the scopes the reference lists for each call, and a test fails if the manifest is wrong.
- Months and dates written by the script (`2026-10`, `2026-10-03`) are written as text in the Report Log, the Job Log, Clean, Rollup and the summary tabs. Sheets would read them as dates, and the month close would then rebuild reports it had already sent.
- `sheetText_` now also guards scientific notation, thousands separators, percents, currency, times, and slash and word dates. The fake converts each of these the way Sheets does.
- `doPost` and `doGet` return `{"ok": false, "error": "server_error"}` for an unexpected failure instead of an error page. The cause goes to the log and the lock is released.
- New: a "Send to me first" box in the sidebar, ticked by default, and `runClientReport(client, month, { preview: true })`. A preview goes to the person running the script and does not count as the email to the client.
- A month close no longer skips a report that was only previewed or whose email failed.
- The bulk job's time budget now counts the time spent clearing the Clean sheet and growing the grid.
- The menu reads dates in the spreadsheet time zone, the zone the data is dated in.
- `.clasp.json` sets `rootDir` and the push order. `fixtures/rates.csv` is new, for importing the Rates tab.
- The manifest has a test that runs every feature with each scope removed in turn.
- New pages: `docs/maintenance.md` and `docs/testing.md`. The README starts with what the tool does, and the deploy steps are corrected.

## 0.1.0, 2026-11-10

First version: summaries, PDF reports and month close, menu and sidebar, lead webhook, intake form, ad costs and currency rates, the 50,000 row job, the local fake of Google's services and the seeded data.
