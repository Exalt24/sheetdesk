# A run on a real Google account

On 2026-11-10 the code in `src/` was deployed to a real Google account and driven by hand. This page says what ran, what came back and what did not run. The fake in `test/fake/` is still the main proof. This is the check that the fake and Google agree on the parts below.

## What ran

1. `clasp create --type sheets` made a new Sheet and a bound script. `clasp push` sent all 15 files, and Google accepted the manifest in `src/appsscript.json`. clasp was 3.4.1. `clasp create-deployment` made a web app deployment.
2. Opening the Sheet ran `onOpen`: the **sheetdesk** menu appeared with Open desk, Close a month, Rebuild summaries, Data and Set up.
3. **Set up** asked for permission. The "Google hasn't verified this app" screen came first, as the README says, and the nine scopes were granted on the account that owns the script. After that it answered "Sheets are ready." and created the Campaigns, Clients, Leads and Rates tabs and the three script properties `REPORT_FOLDER_ID`, `REPORT_TEMPLATE_ID` and `WEBHOOK_SECRET`.
4. The four fixture files were loaded into the tabs through the Sheets API: 9 clients, 2,024 campaign rows, 300 leads and 142 rate rows.
5. **Rebuild summaries** built one Summary tab per client from those rows ([picture](live-run/summary-tab.png)). The totals row of a month is the sum of its channel rows.
6. **Open desk** showed the sidebar in Google's iframe, filled with the clients and months from the Sheet. **Run report** with "Send to me first" ticked answered "Report ready: copperline-plumbing-2026-10.pdf. Email: sent to you, not to the client." ([picture](live-run/sidebar-run-report.png)). A Report Log row was written. The email arrived with the PDF attached, and the PDF is one page and its figures add up: spend 13,362.80, which is 5,160.76 plus 4,295.95 plus 3,906.09, 11,657 clicks and 610 conversions ([the file](live-run/copperline-plumbing-2026-10.pdf), [page](live-run/report-pdf-page.png)). The layout is plain text and a table, as the page on summaries says.
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

## What did not run

Month close, the intake form trigger, the 50,000 row bulk job with its continuation trigger, the ad platform and exchange rate syncs, and a report to a client's own address. The run used one account, one Sheet and invented data. No quota was measured.

## One thing it found

Loading the leads through the Sheets API with value conversion on turned phone numbers that begin with `+` into `#ERROR!` cells, because Sheets read them as formulas. The README's import step now tells the person to untick the conversion option in the import dialog. The script's own writes were not affected: its guard keeps text that looks like a formula as text, which the `=1+1` call above shows on the real service.
