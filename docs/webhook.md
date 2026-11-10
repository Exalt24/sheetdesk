# Lead webhook and web app

Source: `src/Webhook.js`, `src/Dashboard.html`, `src/Clients.js`. Tests: `test/webhook.test.js`.

## What it does

`doPost(e)` takes a lead from Zapier or Make and appends it to the Leads sheet.

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

Order of checks: body size (10,000 characters), parse, secret, unknown fields, field values, client name, then the lock. Every reply is a JSON body with `ok`. Errors have an `error` code: `no_body`, `too_large`, `bad_json`, `not_configured`, `unauthorized`, `unknown_field`, `missing_field`, `invalid_field`, `unknown_client`, `busy`.

- **The secret** is held in the `WEBHOOK_SECRET` script property. With no secret set, every request is refused (`not_configured`). The comparison does not stop at the first different character. The secret is read from the body field `secret`, or from the `secret` URL parameter when the body has none.
- **Unknown fields** are rejected by name, but only after the secret is right, so a caller without the secret learns nothing about the schema.
- **Idempotency.** `lead_id` is the key. A repeat returns `{"ok": true, "duplicate": true}` and adds no row, so a Zap that retries is safe. The check and the append happen under `LockService.getScriptLock()`; if the lock is not free in 10 seconds the reply is `busy` and the caller retries. The script calls `SpreadsheetApp.flush()` before it releases the lock, as the Lock documentation asks.
- **Text safety.** Anything a caller sends is written with a leading apostrophe when Sheets would read it as a formula (`=`, `+`, `-`, `@`), a number (`007`), a date or a boolean. So `=IMPORTXML(...)` stays text and the id `007` stays `007`.
- **Client names** are matched ignoring case and outer spaces, and stored in the spelling from the Clients sheet. The list is cached for 5 minutes in `CacheService`; the intake form clears the cache when it adds a client.

`doGet(e)`:

- no `view` parameter: `{"ok": true, "service": "sheetdesk"}`, nothing else.
- `?view=status&secret=...`: JSON with total leads and leads per client.
- `?view=dashboard&secret=...`: an HTML table of leads per client and in the last 7 days. Names are escaped.

## Apps Script limits that shape this

Apps Script web apps **cannot read request headers**, so a header such as `X-Secret` never reaches the script. They also **cannot set an HTTP status code**; every reply is 200. That is why the secret travels in the body or the URL, and why callers must read `ok`. A secret in a URL can end up in logs, so the dashboard and status URLs are private.

The manifest sets `access: ANYONE_ANONYMOUS` because Zapier and Make do not sign in with Google. The secret is the only gate.

## How it was tested

Against the fake, with the secret, bad body, field and client cases, the formula and number text cases, the lock held by another run (busy, then a successful retry), two overlapping requests for one `lead_id` (the second is told to retry, and a later call is `duplicate`), a client added after the cache filled, the status counts against the fixtures, the escaped dashboard, and a seeded property test: 25 random sequences of 40 requests with wrong secrets, extra fields, bad emails, lock contention, case variants of the client name and look-alike ids (`007`, `7`, `7` as a number). Each sequence must end with every accepted id stored once and nothing else.

## What it does NOT do

- No rate limiting. A caller with the secret can send as fast as Apps Script allows.
- No per-client secrets. One secret covers all clients.
- It was not called by Zapier or Make. The request shape follows their documented JSON payload.
- It reads the Leads id column on each request, which is fine for tens of thousands of leads and slow beyond that.
