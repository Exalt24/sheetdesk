# Try it and send a lead

What to do once the Sheet is deployed: run a report from the sidebar, send a test lead to the web app, and start the 50,000 row job. The deploy steps are in the [README](../README.md).

## Try it

1. Open the Sheet and the sidebar: **sheetdesk**, then **Open desk**.
2. Pick **Harbor Lane Bakery** and **2026-10**. Leave "Send to me first" ticked and press **Run report**. The status line says the report is ready and sent to you.
3. Open your mail for the PDF. In Drive, the folder `Fernwood Digital reports` holds `harbor-lane-bakery-2026-10.pdf`. The **Report Log** tab has one row for that client and month, and its `emailed_at` column is empty because the client has not been emailed.
4. The sample clients have invented addresses, so first change `contact_email` of Harbor Lane Bakery in the Clients tab to an address you own. Then untick the box and run it again to email the client. The row now has an `emailed_at` time. Running it a third time sends nothing, because the figures have not changed.
5. Send a test lead, as in the next section, and look for the row in the **Leads** tab.

## Send a lead to the web app

Zapier and Make post to the web app URL. This is the same call from a terminal. Use your URL and the `WEBHOOK_SECRET` value from Project settings, Script properties.

```bash
curl -L -X POST "https://script.google.com/macros/s/DEPLOYMENT_ID/exec" \
  -H "Content-Type: application/json" \
  -d '{"secret":"SECRET_VALUE","lead_id":"curl-1001","client":"Harbor Lane Bakery","name":"Ana Archer","email":"ana.archer@example.com","message":"Interested in a quote"}'
```

A good reply is `{"ok":true,"duplicate":false,"lead_id":"curl-1001"}`. Apps Script web apps cannot read request headers and cannot set an HTTP status code. The secret therefore travels in the body, every reply has HTTP status 200, and the caller must read `ok` in the JSON. Google also answers with a redirect, so the caller must follow redirects (`-L` in curl). [webhook.md](webhook.md) has the details, the error codes and what to do about the shared secret.

In Zapier (Webhooks, POST, payload type JSON) or Make (HTTP, Make a request, JSON body), send the same body with your secret in the `secret` field.

## Start the big job

The 50,000 row job has no menu item. In the editor pick `startBulkNormalize` and press Run. See [maintenance.md](maintenance.md).
