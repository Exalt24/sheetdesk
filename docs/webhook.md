# Lead webhook and web app

Source: `src/Webhook.js`, `src/Dashboard.html`, `src/Clients.js`. Tests: `test/webhook.test.js`, `test/webhook-errors.test.js`, `test/sheet-text.test.js`.

## What it does

`doPost(e)` takes a lead from Zapier or Make and appends it to the Leads sheet.

**Every reply is HTTP 200, so add an `ok` check.** An Apps Script web app cannot set a status code. A lead that is refused (`unknown_client`, `unknown_field`, `invalid_field`, `unauthorized`, `busy`) comes back with HTTP 200 and `{"ok": false, ...}`, and Zapier and Make count a 200 as a success. Add one step after the webhook call in the Zap or the Make scenario that stops the run, or sends you an alert, when `ok` is not true. Without it a refused lead is lost without a sign, and the once-only delivery below only holds for the leads that were accepted. A client row typed by hand into the Clients tab can answer `unknown_client` for up to 5 minutes, because the name list is cached; the check step then catches it and a retry works.

```json
{
  "secret": "the value of the WEBHOOK_SECRET script property",
  "lead_id": "z-1001",
  "client": "Harbor Lane Bakery",
  "name": "Ana Archer",
  "email": "ana.archer@example.com",
  "phone": "+1 555 0123",
  "source": "facebook",
  "campaign": "launch-week",
  "message": "Interested in a quote"
}
```

Only `lead_id` and `client` are required. A lead with a `lead_id` in the right shape and a client from the Clients tab is always stored.

- **`lead_id`** is unique for each client, not across clients. It is 1 to 64 characters from letters, digits and `_ . : -`. Anything else, such as a space or a slash (a booking link used as an id), is refused with `invalid_field`. Send it as text. A number is kept only when it is a whole number up to 9007199254740991, because JSON turns a bigger one (a 17 digit ad platform id) into a nearby number before the script sees it, and two different leads would then share an id. A number that is not exact is refused with `invalid_field` and a `hint` that says to send the id as text.
- **An odd optional value is kept.** An `email` that is not an address (`ana@gmail`, a comma for the dot, `Ana Archer <ana@example.com>`) and a `name`, `phone`, `source`, `campaign` or `message` longer than its usual size (120, 40, 60, 120 and 2,000 characters) are stored as typed, after the text safety step below. The reply then carries a `warnings` list that names each field, for example `{"ok":true,"duplicate":false,"lead_id":"z-1001","warnings":[{"field":"email","issue":"not_an_email"},{"field":"message","issue":"too_long","max":2000}]}`. A lead with nothing odd has no `warnings` key. A retry of a lead that is already stored answers `duplicate` and carries no warnings. The whole body is still capped at 10,000 characters.
- **Still refused:** an object, a list or a true or false value in a field, a `client` over 120 characters, an unknown client, an unknown field and a wrong secret.

A body that is a JSON object is read as JSON whatever its content type says, so a Make HTTP step that sends `text/plain` still works. A body that is not an object is read as form fields, or answered `bad_json` when its content type says JSON.

Order of checks: body size (10,000 characters), parse, secret, unknown fields, field values, client name, then the lock. Every reply is a JSON body with `ok`. Errors have an `error` code: `no_body`, `too_large`, `bad_json`, `not_configured`, `unauthorized`, `unknown_field`, `missing_field`, `invalid_field` (a wrong typed value, a `lead_id` of the wrong shape or a `client` over 120 characters), `unknown_client`, `busy` and `server_error`.

- **The secret** is held in the `WEBHOOK_SECRET` script property. With no secret set, every request is refused (`not_configured`). The comparison does not stop at the first different character. The secret is read from the body field `secret`, or from the `secret` URL parameter when the body has none.
- **Unknown fields** are rejected by name, but only after the secret is right, so a caller without the secret learns nothing about the schema.
- **Idempotency.** The key is the client and the `lead_id` together, with the client as the Clients tab spells it (so `summit yoga` and `Summit Yoga` are one client). A repeat for the same client returns `{"ok": true, "duplicate": true}` and adds no row, so a Zap that retries is safe. The same `lead_id` for another client is a new lead and is stored: ad platforms and forms number their leads per account, so two clients can both have a lead 1001. Within one client an id is still unique. The check and the append happen under `LockService.getScriptLock()`. If the lock is not free in 10 seconds the reply is `busy` and the caller retries. The script calls `SpreadsheetApp.flush()` before it releases the lock, as the Lock documentation asks.
- **An unexpected failure** (a renamed header in the Leads tab, a failing flush) is caught. The caller gets `{"ok": false, "error": "server_error"}`, the cause goes to the execution log, and the lock is released. The reply never carries the message. If the failure came after the row was written, the retry is answered `duplicate`.
- **Text safety.** Anything a caller sends is written with a leading apostrophe when Sheets would read it as something other than text. That covers a formula (`=`, `+`, `-`, `@` at the start), a boolean, and these forms of number, date and time:

  | Form | Examples |
  |---|---|
  | numbers | `007`, `12.50`, `.5`, `1,000`, `1e5` |
  | percent, currency | `50%`, `$5`, a euro, pound, yen or peso sign before digits |
  | times | `10:30`, `2:05 PM` |
  | dates | `2026-10`, `2026-10-03` (and any text that starts with a full date), `2026/10/03`, `3/4`, `3/4/2026`, `3-4`, `Oct 5`, `5 Oct 2026`, `Oct 2026` |

  So `=IMPORTXML(...)` stays text and the id `007` stays `007`. The month and day order follow the US English reading, and the guard also covers the other order. Text that Sheets keeps as text, such as a name or `12 apples`, gets no apostrophe. A form that is not in the table is not guarded, and the fake in the tests converts only the forms in the table, so a form outside the table would pass the tests and could still change in a real Sheet.
- **Client names** are matched ignoring case and outer spaces, and stored in the spelling from the Clients sheet. The list is cached for 5 minutes in `CacheService`. The intake form clears the cache when it adds a client.

`doGet(e)`:

- no `view` parameter: `{"ok": true, "service": "sheetdesk"}`, nothing else.
- `?view=status&secret=...`: JSON with total leads and leads per client.
- `?view=dashboard&secret=...`: an HTML table of leads per client and in the last 7 days. Names are escaped. The sample leads in `fixtures/leads.csv` end on 2026-10-31, so the last 7 days column shows only leads posted since, and reads 0 until a new one arrives.
- an unexpected failure gives the same `server_error` JSON as `doPost`.

## Call it

Replace the URL and the secret. The secret is the `WEBHOOK_SECRET` script property (Project settings, Script properties). The URL is the web app URL from the deployment.

```bash
curl -L -X POST "https://script.google.com/macros/s/DEPLOYMENT_ID/exec" \
  -H "Content-Type: application/json" \
  -d '{"secret":"SECRET_VALUE","lead_id":"curl-1001","client":"Harbor Lane Bakery","name":"Ana Archer","email":"ana.archer@example.com","source":"curl","message":"Interested in a quote"}'
```

A good reply is `{"ok":true,"duplicate":false,"lead_id":"curl-1001"}`. Run it a second time and the reply is `{"ok":true,"duplicate":true,"lead_id":"curl-1001"}` and the Leads tab still has one row.

The `-L` matters. Google answers a web app call with a redirect, and a client that does not follow it sees a redirect and no JSON.

## What to know about Apps Script web apps

- **Headers and status codes.** A web app cannot read request headers, so a header such as `X-Secret` never reaches the script. It cannot set an HTTP status code either. Every reply has HTTP status 200, including the error replies. In plain words: a 200 does not mean the lead was stored. The result is in the JSON, so the caller must read `ok`, and treat `ok: false` as a failure. In Zapier or Make, add a step that stops the run when `ok` is not true.
- **The redirect.** Google's guide on returning content says: "For security, content returned by the Content service is redirected to a one-time URL at script.googleusercontent.com. If you use the Content service to return data to another application, ensure the HTTP client is configured to follow redirects." ([Content Service guide](https://developers.google.com/apps-script/guides/content)). The guide adds `-L` for curl. Look at the HTTP step in Zapier or Make for a follow-redirects option and turn it on, or the step sees the redirect and not the JSON. This has not been tried with Zapier or Make.
- **The secret travels in the body or the URL.** A secret in a URL can end up in logs, so the status and dashboard URLs are private.
- **Anonymous access.** The manifest sets `access: ANYONE_ANONYMOUS` because Zapier and Make do not sign in with Google. The secret is the only gate.

## The shared secret

One secret covers every caller. There is no secret per caller or per client, and the script cannot tell two callers apart.

- **Rotate it** when it may have leaked or when someone who knew it leaves. In the editor open Project settings, Script properties, and replace the value of `WEBHOOK_SECRET` with a new long random string. The old one stops working at once. Then change the secret in each Zap and Make scenario, because every caller breaks until you do.
- **Do not paste it into a URL** that is shared, logged or bookmarked. Put it in the JSON body.
- **Delete the property** to switch the webhook off. Every request is then refused with `not_configured`.
- Running Set up again does not replace an existing secret.
- To tell callers apart you would need a second web app deployment or a secret per caller in the code. Neither is built.

## How it was tested

Against the fake, with the secret, bad body, field and client cases, a table of every optional field against odd and ordinary values (`test/webhook-optional.test.js`) and the adversary's cases in `test/corpus/corpus_sheetdesk_1.jsonl` (`test/corpus.test.js`), the formula and number text cases, the lock held by another run (busy, then a successful retry), two overlapping requests for one `lead_id` (the second is told to retry, and a later call is `duplicate`), a client added after the cache filled, the status counts against the fixtures, the escaped dashboard, and a seeded property test: 25 random sequences of 40 requests with wrong secrets, extra fields, bad emails, lock contention, case variants of the client name and look-alike ids (`007`, `7`, `7` as a number). Each sequence must end with every accepted id stored once and nothing else.

Each step that can throw has a test that makes it throw: a renamed header on Leads or Clients, a cache that refuses a write or a read, a failing append, a failing flush, a lock service that fails. The test checks the reply is the `server_error` JSON with no message in it, the cause is in the log, the lock is released, and a retry after a failed flush is a duplicate.

## What it does NOT do

- No check that an email is real, or that a phone is a phone. Those are stored as typed and reported in `warnings`, and nothing reads the warnings but the caller.
- No rate limiting. A caller with the secret can send as fast as Apps Script allows.
- No per-caller secrets, see above.
- It was not called by Zapier or Make. The request shape follows their documented JSON payload.
- It reads the Leads id column on each request. That is expected to be fine for a few thousand leads and to slow down as the sheet grows. This is expected, not tested: the largest sheet in the tests has 300 leads, and the fake's clock does not model real read speed.
