# Client intake form

Source: `src/Forms.js`. Tests: `test/forms.test.js`.

## What it does

`installIntakeTrigger()` creates a Google Form (if the `INTAKE_FORM_ID` script property does not point at a form that still opens) and installs a form submit trigger for `onIntakeSubmit`. Running it again keeps one form and one trigger. Run it once from the editor, after you authorise the script; a simple trigger context is refused.

The form has six items: client name, contact name, contact email, primary channel (a choice), monthly budget (USD) and notes. The first four are required.

`onIntakeSubmit(e)` takes `e.response` and:

1. Reads the answers by item title and checks them: a client name, a valid email, a budget that is a number of zero or more (commas are fine).
2. Takes the script lock, and looks for the response id in the Clients sheet. A response that was already stored returns `duplicate` and does nothing more.
3. Appends one row to Clients. The status is `active`, or `needs_review` when a check failed or the client name already exists (ignoring case). Nothing is thrown away, so a person can look at the odd ones.
4. Flushes, then clears the cached client list so the webhook accepts the new client at once.
5. Sends a confirmation email to the contact, only for an `active` row. If the email fails (for example, no mail quota left) the row stays and the error goes to the log.

Text from the form is written with the same guard as the webhook, so an answer that starts with `=` stays text.

## How it was tested

Against the fake form, which refuses a submission with a required item missing or a choice that is not listed, as the real form does. Tests cover the installer (one form, one trigger, a deleted form, a second run, the simple trigger refusal, the missing Forms scope), a good submission end to end (row, email), bad email and budget values, a repeated client name, the same response delivered twice, two deliveries at the same moment (the second waits on the lock and times out, a retry is a duplicate), a failing email, and a formula-like answer.

## What it does NOT do

- Only the form trigger is handled, not a trigger bound to the response spreadsheet (`e.namedValues`).
- The form has no built-in validation rules. The checks run after the response is saved, so a bad answer cannot be blocked at the form.
- If two deliveries collide and the second waits longer than 30 seconds for the lock, it throws and Apps Script does not retry a form trigger. Collisions this long were only produced in the test, not seen.
- It does not add an ad account id. The `ad_account_id` column is filled by hand.
