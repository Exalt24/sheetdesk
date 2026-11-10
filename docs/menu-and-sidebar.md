# Menu, sidebar and dialog

Source: `src/Menu.js`, `src/Sidebar.html`, `src/Dialog.html`. Tests: `test/menu.test.js`.

## What it does

`onOpen()` adds a **sheetdesk** menu: open the desk, close a month, rebuild summaries, a Data submenu (pull ad costs, pull currency rates) and set up. `onOpen` is a simple trigger, so it only builds the menu.

The sidebar has a client picker, a month picker, a **Send to me first** box (ticked when the sidebar opens), **Run report** and **Close month**. It calls four server functions through `google.script.run`:

| Function | Does | Checks |
|---|---|---|
| `sidebarGetOptions()` | active clients and the months found in Campaigns | none needed, takes no argument |
| `sidebarRunReport(client, month, sendToMe)` | the monthly report for one client. Only an explicit `false` emails the client. Anything else, including a missing value, sends the PDF to the person running the script | month shape, client exists in the Clients sheet |
| `sidebarRequestMonthClose(month)` | opens the confirm dialog | month shape |
| `dialogConfirmMonthClose(month)` | runs the month close | month shape |

With the box ticked, **Run report** builds the PDF and emails it to you, and the status line says so. Untick the box to email the client. The status line shows the result in words, for example "sent to you, not to the client".

**Close month** opens a modal dialog first. The dialog has the month prefilled, a **Close month** button and **Cancel**. The month close only runs when the button is pressed.

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

## What it does NOT do

- The sidebar was rendered inside Google's iframe on 2026-11-10 and its Run report round trip worked ([live-run.md](live-run.md)). The month close dialog was not opened there, and the layout was judged by eye on one screen size only.
- No keyboard shortcuts, no progress bar during a long month close.
