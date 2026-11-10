# Changelog

## Unreleased

Changes after a fourth pass, a blind recall of the README, docs, source and tests that found seven problems.

- Pull currency rates covers every month the foreign currency rows are in (up to 3 years back, in pieces of 92 days), not the last 30 days. A row with no rate was left out of the totals and nothing said so. The report result, the Run report line, the Rebuild summaries message and the month close dialog now count the rows left out and say why in one sentence, and a month where every row was left out no longer reads "No data for that month".
- The month close dialog says that it emails every client. The month picker starts on the last month that has ended, and a month close for a month that has not ended in the Sheet's time zone is refused with the reason.
- A lead_id is unique for each client, not across clients. A second client's lead with an id another client already used was dropped while the reply said ok.
- The month close names the clients whose report was built but who got no email because the address is empty or not one address.
- The intake form keeps the Notes answer in a `notes` column, reads a budget written as `$2,500`, `2500 USD` or `2.5k`, and records which check failed in a `review_reason` column and in the return value.
- A row held as `needs_review` no longer stops the active client of the same name: only active rows count for a name clash, and when a paused row and an active row share a name the active one is reported.
- The README Set up step and docs/maintenance.md say that Set up changes the Sheet's time zone to the script's, and a test checks the README line names the zone.

Changes after a third pass, a blind adversary corpus of 53 cases (now in `test/corpus/corpus_sheetdesk_blind_2.jsonl`).

- A numeric `lead_id` that is not an exact whole number (a 17 digit id, 1.5) is refused with a hint to send it as text. JSON had already changed its last digits, so two leads shared an id and the second was answered `duplicate` and never stored.
- A JSON body sent as `text/plain` is read as JSON, so the right secret is no longer answered `unauthorized`.
- Two client names that would share a PDF file name or a summary tab stop only those two clients, not Run report, Rebuild summaries and the month close for everyone. The result names both.
- The intake form holds a name that would clash with a listed client as `needs_review` and sends no confirmation.
- A Campaigns row whose client matches no client is counted and named in the result and the menu message, not dropped silently.

Changes after a second independent review, which sent 98 test cases through the code (now in `test/corpus/`).

- A lead with a `lead_id` and a client is always stored. An email that is not an address, or a name, phone, source, campaign or message over its usual size, is kept as typed and the reply lists it in `warnings`. It used to refuse the whole lead and lose the phone and message with it. The `lead_id` shape, the secret and the unknown field checks are unchanged.
- A blank clicks or conversions cell counts as 0 and conversions may be fractional, so a row is no longer left out of the summaries, and its spend with it, for an email channel or a Google Ads export. Text, negative counts and fractional clicks still reject the row.
- The bulk job learns its read time per row only from a batch of 100 rows or more. A last batch of one row made the rollup look too slow, so a sheet of 10,001 rows never finished.

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
