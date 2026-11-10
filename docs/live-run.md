# A run on a real Google account

On 2026-11-10 the code in `src/` was deployed to a real Google account and driven by hand. This page says what ran, what came back, what it found and what did not run. The fake in `test/fake/` is still the main proof. This is the check that the fake and Google agree on the parts below.

## What ran

1. `clasp create --type sheets` made a new Sheet and a bound script. `clasp push` sent all 15 files, and Google accepted the manifest in `src/appsscript.json`. clasp was 3.4.1. `clasp create-deployment` made a web app deployment.
2. Opening the Sheet ran `onOpen`: the **sheetdesk** menu appeared with Open desk, Close a month, Rebuild summaries, Data and Set up.
3. **Set up** asked for permission. The "Google hasn't verified this app" screen came first, as the README says, and the nine scopes were granted on the account that owns the script. After that it answered "Sheets are ready." and created the Campaigns, Clients, Leads and Rates tabs and the `WEBHOOK_SECRET` script property. The report folder and template ids are made by the first report.
4. The four fixture files were loaded into the tabs through the Sheets API: 9 clients, 2,024 campaign rows, 300 leads and 142 rate rows.
5. **Rebuild summaries** built one Summary tab per client from those rows ([picture](live-run/summary-tab.png)).
6. **Open desk** showed the sidebar in Google's iframe, filled with the clients and months from the Sheet. **Run report** with "Send to me first" ticked answered "Report ready: copperline-plumbing-2026-10.pdf. Email: sent to you, not to the client." ([picture](live-run/sidebar-run-report.png)). A Report Log row was written and the email arrived with the PDF attached ([the file](live-run/copperline-plumbing-2026-10.pdf), [page](live-run/report-pdf-page.png)). The PDF figures were checked against `fixtures/campaigns.csv` with a separate script: October for Copperline Plumbing is 13,833.29 spend, 12,072 clicks and 634 conversions in both, and the Tidewater Tutors August email row in the Summary tab is 1,466.58, 1,291 and 57 in both. The PDF is one page of plain text and a table, with no agency name or logo.
7. The web app answered from the deployed URL, with the redirect Google sends followed:

| Call | Reply |
|---|---|
| Good lead with the secret | `{"ok":true,"duplicate":false,"lead_id":"live-1001"}` |
| The same lead again | `{"ok":true,"duplicate":true,"lead_id":"live-1001"}` |
| Wrong secret | `{"ok":false,"error":"unauthorized"}` |
| A name of `=1+1` and a message of `1e5` | accepted, and both cells hold the text as typed, not `2` and not a number |
| An unknown field `colour` | `{"ok":false,"error":"unknown_field","fields":["colour"]}` |
| `GET` with no secret | `{"ok":true,"service":"sheetdesk"}` |
| `GET ?view=dashboard&secret=...` | the HTML page "Leads by client" |

Every reply was HTTP 200 with the answer in the JSON, as `docs/webhook.md` says.

## What it found

The first pass of the run produced summaries and a PDF that were a day out: a client whose data starts on 1 August showed a July block, and the October figures were October minus 1 October. The cause was not in the date code. The Sheet made by clasp held the time zone `Etc/GMT` in the Sheets API while `getSpreadsheetTimeZone()` answered `America/Los_Angeles`, so every date cell was formatted in the wrong zone. The fake could not show this because it has one zone.

The fix is in `setUp()`: it sets the Sheet's time zone to the script's (`timeZone` in `src/appsscript.json`), with a test and a mutant. After Set up was run again and the data reloaded, the figures above matched the fixtures. The first, wrong pass is the reason this page checks the figures against the CSV and not only against themselves.

A smaller finding: loading phone numbers that begin with a plus sign through the Sheets API with value conversion on turned them into `#ERROR!` cells, because Sheets read them as formulas. The Leads tab is filled by the webhook, which keeps such text as text (the `=1+1` call above), so the import steps do not touch it.

## What did not run

Month close, the intake form trigger, the 50,000 row bulk job with its continuation trigger, the ad platform and exchange rate syncs, and a report to a client's own address. The run used one account, one Sheet and sample data. No quota was measured. The dialog and the web app dashboard page were not looked at in a browser.
