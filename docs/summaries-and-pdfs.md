# Summaries, PDFs and month close

Source: `src/Reporting.js`, `src/Campaigns.js`. Tests: `test/reporting.test.js`, `test/util.test.js`.

## What it does

`buildClientSummaries()` reads the Campaigns sheet with one `getValues` call, groups it by client, month and channel, and writes one `Summary - <client>` tab per client with one `setValues` call per tab. Each month gets a line per channel and an ALL line with spend, clicks, conversions, cost per click, cost per conversion and conversion rate. A rerun rewrites the tab, so old rows do not stay behind. A client that has no Campaigns row left in the totals (its rows were deleted, or every one is left out) keeps no old figures either: its tab is emptied to its header row and named in `emptied` (the count, up to 10 tabs, a sentence), and the menu message says so. Only tabs that start with `Summary - ` are touched, a tab that already holds only its header is left as it is and not named again, and the tab of a name that clashes is left alone because `skipped` already names it.

`runClientReport(client, month)` builds the monthly PDF:

1. Copies a template Google Doc. The script creates the template on first use, with the placeholders `{{client}}`, `{{month}}`, `{{spend}}`, `{{clicks}}`, `{{conversions}}`, `{{cpc}}`, `{{cpa}}`, `{{generated}}` and `{{table}}`.
2. Fills the placeholders with `replaceText`, and puts the channel table where `{{table}}` was with `insertTable`.
3. Calls `saveAndClose()`, exports the copy to PDF, and writes it into the folder as `<client-slug>-<yyyy-MM>.pdf`.
4. Trashes any older file with the same name, so a rerun replaces the PDF instead of adding a second one. The file id changes, because `DriveApp` cannot overwrite the content of a PDF.
5. Trashes the working copy of the Doc.
6. Emails the PDF with `MailApp.sendEmail`, which needs only the send mail scope. The Report Log sheet keeps the figures of the last email per client and month. A rerun emails again only when the figures changed, or when you pass `force`. If the script property `REPORT_CC` holds an address, it is copied on the email.

**Send to me first.** `runClientReport(client, month, { preview: true })` does the same steps but emails the PDF to the person running the script and never to the client. The subject starts with `[Preview]`. The address comes from `Session.getActiveUser()`. Google gives a blank address in some contexts, so the script then uses the `REPORT_CC` property, and if that is empty too the result is `no_preview_address` and nothing is sent. A preview does not count as the email to the client: it never sets `emailed_at` in the Report Log. When the figures have changed since the last email, the row starts with an empty `emailed_at`, so the next real run sends. A failed email for changed figures works the same way. The sidebar passes its "Send to me first" box to this option, and the box starts ticked.

Only active clients count for a name clash: a row held as `needs_review` or `paused` never stops an active client. Two client names that would share one PDF file name or one summary tab (`Harbor Lane Bakery` and `harbor lane bakery`, `A/B Co` and `A-B Co`) stop only those clients. Run report refuses either name with a message that names both, Rebuild summaries leaves both tabs out and lists the clash in `skipped`, and the month close lists each of them as an error and reports every other client. A Campaigns row whose client is not the exact name of any client in the Clients tab is in no report, so the result carries `unmatched` with the row count and the names (at most 10), and the menu message, the sidebar and the month close dialog say so.

`runMonthClose(month)` rebuilds the summaries and runs the same steps for every client whose status is `active`. It is refused for a month that has not ended in the Sheet's time zone, because it emails every client. Before it builds or emails anything it checks the Campaigns rows: when any is left out of the totals, or names a client that is not in the Clients tab, it returns `held` (the count, the reasons and the sentence) with no result, and emails nobody, until it is called again with `{ acknowledgeLeftOut: true }`. A client whose status is none of `active`, `inactive`, `paused` or `needs_review` (a blank cell, `yes`, `actve`) gets no report and is named in `unknownStatus` with the status it has; the four known statuses are on purpose and need no mention. A client whose address is empty or not one address gets its report but no email and is named in `noAddress` (`count`, up to 10 `clients`, a sentence). It stops before the 4.5 minute budget and returns the clients still waiting, so a second call finishes them. A client whose PDF is current and who has been emailed (or has no address) is skipped. A report that was only previewed, or whose email failed, is not skipped, so the close sends it. One failing client is reported and does not stop the rest.

Spend in another currency is converted to USD with the rate of that day from the Rates sheet, or the latest earlier day within 7 days (weekends have no rate). A row with no usable rate is counted as rejected and left out. Money is summed in whole cents.

**Every report that can reach a client passes two guards.** A single report that would be emailed to the client (the box "Send to me first" unticked, or `runClientReport` without `preview`) is refused for a month that has not ended, with the reason, so a client never gets half a month. When Campaigns rows are left out of the totals it is held in the same way as a month close: the result has the status `held`, nothing is built, no file is made and nothing is sent, and `held` says how many rows and why. Call it again with `{ acknowledgeLeftOut: true }` (the sidebar's **Send anyway** button does) to send it. Both guards sit in `buildReport_`, the one place a report is mailed, so a new caller cannot skip them, and `test/send-gate.test.js` fails when one tries. A preview to the person running the script, and a run that sends nothing, are never refused and never held.

**A row that is left out is shown, not hidden.** The result of Rebuild summaries, Run report and the month close carries `rejected` (the count, for Rebuild summaries) and `leftOut`: the count, the reasons with their counts and one sentence, for example "11 Campaigns rows are left out of the totals: 11 with no currency rate for the day (sheetdesk, Data, Pull currency rates fetches them)." The menu message, the sidebar line and the month close dialog print that sentence. The counts cover the whole Campaigns tab, so a bad row of another client shows too. The key is present only when at least one row was left out. Pull currency rates now asks for every day from the first day of the earliest month with a row in another currency up to today (at most 3 years back, in pieces of 92 days), so last month's euro rows have their rate.

Only the date and the spend must be there. A blank `clicks` or `conversions` cell counts as 0 (an email channel has no clicks, an awareness campaign no conversions), and `conversions` may be fractional, such as the 2.5 a Google Ads export gives with data driven attribution. Fractional conversions are added with 4 decimals, so 0.1 and 0.2 make 0.3. Text, a negative number or fractional `clicks` still reject the row: it is counted in `rejected`, left out, and its spend is not in the totals. The bulk job reads the rows the same way (`bad_clicks` or `bad_conversions` in Clean).

## How it was tested

Against the fake in `test/fake/gas.js`. The totals in the summary tabs are compared with an independent calculation in `scripts/seed.js` (`referenceRollup`) for every client and month of the generated agency. Other tests cover:

- batch calls only (the call counts are asserted)
- a rerun giving the same tab
- bad rows counted and left out
- rate fallback and the 7 day limit
- every value of a count cell against both count columns, and sums of fractional conversions (`test/reporting-counts.test.js`), with the adversary's cases in `test/corpus/corpus_sheetdesk_1.jsonl`
- a PDF with the right text and one table row per channel
- one PDF after two runs
- no email on an unchanged rerun, an email when the figures change
- a preview goes to the person running the script only, does not count as the client's email, falls back to `REPORT_CC`, and a month close afterwards still emails the client
- months such as `2026-10` come back from the Report Log, the summary tabs and the Job Log as text
- a mail quota of zero, and a client with no address
- bad input refused before anything is created
- a client name with a dollar sign, and two client names that would share a file name (`test/name-collisions.test.js` runs each kind of clash against the report, the summaries, the month close and the intake form)
- a month close that needs two calls to finish
- a row left out for each reason shown in the report, the summaries, the menu message, the month close and the two pages, and a month where every row was left out (`test/left-out.test.js`)
- the month close refused around a month boundary for several Sheet time zones, the month the sidebar starts on, and each kind of unusable address against each status a close returns (`test/close-month.test.js`)
- every entry that can mail a report against a running month, each kind of row left out and the confirmation, and a call graph read from `src/` that fails when a function that reaches the report send is not in the table (`test/send-gate.test.js`)
- every value of the status cell against the month close, its dialog and the picker, and every shape of stale summary tab (`test/skips.test.js`)

## What it does NOT do

- One report ran on a real Google account on 2026-11-10 and its PDF was read ([live-run.md](live-run.md)). Month close and the email to a client's own address have not. The PDF in the fake is text with a PDF header. The real one was read on 2026-11-10: one page, plain text and a table, no agency name or logo.
- It cannot keep the same Drive file id on a rerun. That needs the Drive advanced service.
- A client name with a dollar sign cannot be used in a PDF. The reference does not say how `replaceText` reads `$` in the replacement, so the script refuses it.
- No charts. The table is plain text cells.

## What the column names mean

- `cpc` is cost per click: spend divided by clicks.
- `cpa` is cost per conversion (an acquisition, such as a lead or a sale): spend divided by conversions.
- `conv_rate` is conversions divided by clicks.
- The Report Log `figures` cell holds `spend in cents|clicks|conversions` for the month, so `1383329|12072|634` is 13,833.29 spend, 12,072 clicks and 634 conversions. The month close compares it with the figures now, and a client is not emailed the same report twice.

