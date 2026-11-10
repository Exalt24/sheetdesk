# Menu, sidebar and dialog

Source: `src/Menu.js`, `src/Sidebar.html`, `src/Dialog.html`. Tests: `test/menu.test.js`.

## What it does

`onOpen()` adds a **sheetdesk** menu: open the desk, close a month, rebuild summaries, a Data submenu (pull ad costs, pull currency rates) and set up. `onOpen` is a simple trigger, so it only builds the menu.

The sidebar has a client picker, a month picker, **Run report** and **Close month**. It calls four server functions through `google.script.run`:

| Function | Does | Checks |
|---|---|---|
| `sidebarGetOptions()` | active clients and the months found in Campaigns | none needed, takes no argument |
| `sidebarRunReport(client, month)` | the monthly report for one client | month shape, client exists in the Clients sheet |
| `sidebarRequestMonthClose(month)` | opens the confirm dialog | month shape |
| `dialogConfirmMonthClose(month)` | runs the month close | month shape |

**Close month** opens a modal dialog first. The dialog has the month prefilled, a **Close month** button and **Cancel**. The month close only runs when the button is pressed.

All four are public and end without an underscore, because Apps Script hides functions that end in `_` from `google.script.run`. The browser can call them with any argument, so each one checks its own input. They return plain objects only, since `google.script.run` cannot carry a `Date`.

## How it was tested

- Every function named in `Sidebar.html` and `Dialog.html` is found by reading the HTML (including handlers with semicolons inside), and the test checks that it exists and is public. The list must be exactly the four above.
- Every menu item runs a function that exists and is public.
- Bad input for each function: `undefined`, `null`, numbers, objects, arrays, empty text, `2026-13`, a script tag, trailing spaces and newlines, a wrong case client name. Each must throw, open no dialog, write nothing to Drive and send no mail.
- `onOpen` is run as a simple trigger. The fake refuses Drive, Gmail, `UrlFetchApp` and trigger calls in that mode, as the real service does.
- Return values survive a JSON round trip.
- The sidebar and dialog write server text with `textContent`, never `innerHTML`.
- The dialog opens with last month, also in January.

## What it does NOT do

- The HTML was never rendered in a browser or inside the Google iframe. Layout and the `google.script.run` round trip are untested; only the server side and the names are.
- No keyboard shortcuts, no progress bar during a long month close.
