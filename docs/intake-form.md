# Client intake form

Source: `src/Forms.js`. Tests: `test/forms.test.js`.

## What it does

`installIntakeTrigger()` creates a Google Form (if the `INTAKE_FORM_ID` script property does not point at a form that still opens) and installs a form submit trigger for `onIntakeSubmit`. Running it again keeps one form and one trigger. Run it once from the editor, after you authorise the script; a simple trigger context is refused. The form link (the published URL) is written to the execution log at the bottom of the editor, and the form is a file in your Drive named after the agency, for example `Fernwood Digital client intake`.

The form has six items: client name, contact name, contact email, primary channel (a choice), monthly budget (USD) and notes. The first four are required. The Clients tab has two columns for what the form collects beyond the nine client columns: `notes` (the Notes answer, kept as typed) and `review_reason` (which check failed, empty for an active row). They sit after `created_at`. The form adds the two headers itself when cells J1 and K1 are both empty. If either cell already holds text of your own, the form leaves both alone, the row keeps its nine columns, and the execution log says the notes were not kept.

`onIntakeSubmit(e)` takes `e.response` and:

1. Reads the answers by item title and checks them: a client name, a valid email, a budget that is a number of zero or more. The budget can be written as people write it: `2500`, `2,500`, `$2,500`, `USD 2,500`, `2500 USD` or `2.5k` (a `k` means thousand, in either case). Anything else, such as `about 2500` or `2500 dollars`, fails the check, and the budget is stored as 0.
2. Takes the script lock, and looks for the response id in the Clients sheet. A response that was already stored returns `duplicate` and does nothing more.
3. Appends one row to Clients. The status is `active`, or `needs_review` when a check failed or the client name would share a report file name or a summary tab with an active client (`Harbor Lane Bakery.` and `harbor lane bakery` both clash with `Harbor Lane Bakery`). Only active rows count for the name check: a row that is itself `needs_review` or `paused` is not a client and never holds a new name back. Nothing is thrown away, so a person can look at the odd ones, and the `review_reason` cell says why a row was held, for example `Check failed: monthly budget.` or the name that it clashes with. The same text is in the `reason` key of the return value.
4. Flushes, then clears the cached client list so the webhook accepts the new client at once.
5. Sends a confirmation email to the contact with `MailApp.sendEmail`, only for an `active` row. If the email fails (for example, no mail quota left) the row stays and the error goes to the log.

Text from the form, notes included, is written with the same guard as the webhook, so an answer that starts with `=` stays text. A note is kept up to 50,000 characters, the size of a Sheets cell.

## How it was tested

Against the fake form, which refuses a submission with a required item missing or a choice that is not listed, as the real form does. `test/intake.test.js` runs each way of writing a budget, each Notes answer, each set of failed checks, each state of the two extra columns and each status of an existing row with the same name. Tests cover the installer (one form, one trigger, a deleted form, a second run, the simple trigger refusal, the missing Forms scope), a good submission end to end (row, email), bad email and budget values, a repeated client name, the same response delivered twice, two deliveries at the same moment (the second waits on the lock and times out, a retry is a duplicate), a failing email, and a formula-like answer.

## What it does NOT do

- Only the form trigger is handled, not a trigger bound to the response spreadsheet (`e.namedValues`).
- The form has no built-in validation rules. The checks run after the response is saved, so a bad answer cannot be blocked at the form.
- If two deliveries collide and the second waits longer than 30 seconds for the lock, it throws and Apps Script does not retry a form trigger. Collisions this long were only produced in the test, not seen.
- It does not add an ad account id. The `ad_account_id` column is filled by hand.
