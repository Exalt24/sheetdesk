# Menu, sidebar and dialog

Source: `src/Menu.js`, `src/Sidebar.html`, `src/Dialog.html`. Tests: `test/menu.test.js`.

## What it does

`onOpen()` adds a **sheetdesk** menu: open the desk, close a month, rebuild summaries, a Data submenu (pull ad costs, pull currency rates) and set up. `onOpen` is a simple trigger, so it only builds the menu.

The sidebar has a client picker, a month picker, a **Send to me first** box (ticked when the sidebar opens), **Run report** and **Close month**. It calls four server functions through `google.script.run`:

| Function | Does | Checks |
|---|---|---|
| `sidebarGetOptions()` | active clients, the months found in Campaigns (newest first) and `defaultMonth`, the newest of them that has ended, which the month picker starts on. The key is left out when every month is still running | none needed, takes no argument |
| `sidebarRunReport(client, month, sendToMe, acknowledgeLeftOut)` | the monthly report for one client. Only an explicit `false` emails the client. Anything else, including a missing value, sends the PDF to the person running the script. A report to the client is refused for a month that has not ended, and is held (status `held`, nothing sent) while Campaigns rows are left out, until `acknowledgeLeftOut` is `true` | month shape, client exists in the Clients sheet, and for a report to the client that the month has ended |
| `sidebarRequestMonthClose(month)` | opens the confirm dialog | month shape, and that the month has ended |
| `dialogConfirmMonthClose(month, acknowledgeLeftOut)` | runs the month close. The first press only checks: it returns `held` and emails nobody while Campaigns rows are left out | month shape, and that the month has ended |

With the box ticked, **Run report** builds the PDF and emails it to you, and the status line says so. Untick the box to email the client. The status line shows the result in words, for example "sent to you, not to the client".

**Rows that are left out are said before any email goes.** On the first press of **Close month** in the dialog, and on the first press of **Run report** with the box unticked, the server checks the Campaigns rows. When any is left out of the figures (no currency rate for the day, a date typed as text, a spend that is not a number, a client name that is not in the Clients tab) nothing is emailed: the dialog or the sidebar shows how many rows and why, and the button turns into **Close month anyway** or **Send anyway**. Pressing it again for the same month (and client) sends. Changing the month, the client or the box puts the button back, so the second press cannot confirm something the page did not show. A preview (the box ticked) is never held.

A client whose status is none of `active`, `inactive`, `paused` or `needs_review` is not in the picker, and the sidebar says so when it opens (`unknownStatus` in `sidebarGetOptions`, with the status each one has), so a typo does not read as a client with no reports.

**Close month** opens a modal dialog first. The dialog says "This builds a report for every active client and emails each client the PDF. Send to me first does not apply here.", and has the month prefilled, a **Close month** button and **Cancel**. The month close only runs when the button is pressed. It emails clients, so the picker starts on the last month that has ended and a month that has not ended in the Sheet's time zone is refused with the reason ("The month 2026-11 has not ended yet: it is 2026-11-10 in the Sheet time zone (Asia/Manila), and a month close emails every client. Close it on or after 2026-12-01."), both when the dialog is opened and when the button is pressed. Run report with the box ticked is not refused for a running month, so a report for it can still be previewed; with the box unticked it is refused for a running month the same way, because it would email the client half a month.

After a close the dialog line says how many clients are done, failed, waiting, emailed and not emailed. Then, only when there is something to say, it says which clients were left out, which Campaigns rows match no client, how many Campaigns rows were left out of the totals and why (`leftOut`, for example no currency rate for the day), and which clients have no usable email address (`noAddress`: empty, a comma or semicolon list, no dot after the @). Those clients get their report built but no email. The Run report line carries the same `leftOut` sentence, and a month where every row was left out reads "No report for that month" with the sentence, not "No data for that month".

All four are public and end without an underscore, because Apps Script hides functions that end in `_` from `google.script.run`. The browser can call them with any argument, so each one checks its own input. They return plain objects only, since `google.script.run` cannot carry a `Date`.

## How it was tested

- Every function named in `Sidebar.html` and `Dialog.html` is found by reading the HTML (including handlers with semicolons inside), and the test checks that it exists and is public. The list must be exactly the four above.
- Every menu item runs a function that exists and is public.
- Bad input for each function: `undefined`, `null`, numbers, objects, arrays, empty text, `2026-13`, a script tag, trailing spaces and newlines, a wrong case client name. Each must throw, open no dialog, write nothing to Drive and send no mail.
- `onOpen` is run as a simple trigger. The fake refuses Drive, mail, `UrlFetchApp` and trigger calls in that mode, as the real service does.
- Return values survive a JSON round trip.
- The sidebar and dialog write server text with `textContent`, never `innerHTML`.
- The dialog opens with last month, also in January. Last month is read in the spreadsheet time zone, the zone the data is dated in. A test sets a spreadsheet zone that differs from the script zone near a month end.
- The box is a checkbox that starts ticked, its value is passed to the server, and a missing, `0`, `null` or `"false"` value is a preview.
- The two confirmations: the dialog and the sidebar say what is left out and send nothing on the first press, confirm on the second press for the same month and client only, and put the button back when the month, the client or the box changes (`test/send-gate.test.js`). Only an explicit `true` confirms on the server.

## What it does NOT do

- The sidebar was rendered inside Google's iframe on 2026-11-10 and its Run report round trip worked ([live-run.md](live-run.md)). The month close dialog was not opened there, and the layout was judged by eye on one screen size only.
- No keyboard shortcuts, no progress bar during a long month close.
