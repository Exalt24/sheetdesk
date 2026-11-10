# Summaries, PDFs and month close

Source: `src/Reporting.js`, `src/Campaigns.js`. Tests: `test/reporting.test.js`, `test/util.test.js`.

## What it does

`buildClientSummaries()` reads the Campaigns sheet with one `getValues` call, groups it by client, month and channel, and writes one `Summary - <client>` tab per client with one `setValues` call per tab. Each month gets a line per channel and an ALL line with spend, clicks, conversions, cost per click, cost per conversion and conversion rate. A rerun rewrites the tab, so old rows do not stay behind.

`runClientReport(client, month)` builds the monthly PDF:

1. Copies a template Google Doc. The script creates the template on first use, with the placeholders `{{client}}`, `{{month}}`, `{{spend}}`, `{{clicks}}`, `{{conversions}}`, `{{cpc}}`, `{{cpa}}`, `{{generated}}` and `{{table}}`.
2. Fills the placeholders with `replaceText`, and puts the channel table where `{{table}}` was with `insertTable`.
3. Calls `saveAndClose()`, exports the copy to PDF, and writes it into the folder as `<client-slug>-<yyyy-MM>.pdf`.
4. Trashes any older file with the same name, so a rerun replaces the PDF instead of adding a second one. The file id changes, because `DriveApp` cannot overwrite the content of a PDF.
5. Trashes the working copy of the Doc.
6. Emails the PDF with `MailApp.sendEmail`, which needs only the send mail scope. The Report Log sheet keeps the figures of the last email per client and month. A rerun emails again only when the figures changed, or when you pass `force`. If the script property `REPORT_CC` holds an address, it is copied on the email.

**Send to me first.** `runClientReport(client, month, { preview: true })` does the same steps but emails the PDF to the person running the script and never to the client. The subject starts with `[Preview]`. The address comes from `Session.getActiveUser()`. Google gives a blank address in some contexts, so the script then uses the `REPORT_CC` property, and if that is empty too the result is `no_preview_address` and nothing is sent. A preview does not count as the email to the client: `emailed_at` in the Report Log stays empty, and the next real run sends. The sidebar passes its "Send to me first" box to this option, and the box starts ticked.

`runMonthClose(month)` rebuilds the summaries and runs the same steps for every client whose status is `active`. It stops before the 4.5 minute budget and returns the clients still waiting, so a second call finishes them. A client whose PDF is current and who has been emailed (or has no address) is skipped. A report that was only previewed, or whose email failed, is not skipped, so the close sends it. One failing client is reported and does not stop the rest.

Spend in another currency is converted to USD with the rate of that day from the Rates sheet, or the latest earlier day within 7 days (weekends have no rate). A row with no usable rate is counted as rejected and left out. Money is summed in whole cents.

## How it was tested

Against the fake in `test/fake/gas.js`. The totals in the summary tabs are compared with an independent calculation in `scripts/seed.js` (`referenceRollup`) for every client and month of the generated agency. Other tests cover:

- batch calls only (the call counts are asserted)
- a rerun giving the same tab
- bad rows counted and left out
- rate fallback and the 7 day limit
- a PDF with the right text and one table row per channel
- one PDF after two runs
- no email on an unchanged rerun, an email when the figures change
- a preview goes to the person running the script only, does not count as the client's email, falls back to `REPORT_CC`, and a month close afterwards still emails the client
- months such as `2026-10` come back from the Report Log, the summary tabs and the Job Log as text
- a mail quota of zero, and a client with no address
- bad input refused before anything is created
- a client name with a dollar sign, and two client names that would share a file name
- a month close that needs two calls to finish

## What it does NOT do

- It has not run on a real Google account. The PDF in the fake is text with a PDF header, not a rendered page, so page layout is untested.
- It cannot keep the same Drive file id on a rerun. That needs the Drive advanced service.
- A client name with a dollar sign cannot be used in a PDF. The reference does not say how `replaceText` reads `$` in the replacement, so the script refuses it.
- No charts. The table is plain text cells.
