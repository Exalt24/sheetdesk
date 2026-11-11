# Ad costs and currency rates

Source: `src/HttpClient.js`, `src/AdPlatform.js`. Tests: `test/http.test.js`.

## What it does

**HTTP client.** `httpJson_(url, options)` wraps `UrlFetchApp.fetch` with `muteHttpExceptions` so the status code can be read.

- Retries on 429, on any 5xx and on a thrown fetch error (no DNS, timeout). Up to 5 attempts.
- The wait is `500 ms * 2^(attempt-1)`, capped at 30 seconds, with jitter between half and the full wait. A `Retry-After` header in seconds is used instead, also capped.
- Other 4xx are not retried: a wrong key or a missing page will not fix itself.
- A 200 whose content type is not JSON, or whose body does not parse, or that the caller's `validate` function rejects, is an error and is not retried.
- An optional deadline stops a retry that would run past the time budget.
- `fetchAllPages_` follows a `next_page_token` until it is empty, and stops on a repeated token or after 200 pages.

**Ad costs.** `syncAdCosts(from, to)` pulls `GET {base}/v1/costs?from=&to=&page_token=` from a stand-in ad platform with `Authorization: Bearer <AD_API_KEY>`. Each record has a date, account id, channel, `cost_micros`, currency, clicks and conversions. The script checks each record, maps the account id to a client through the Clients sheet, and upserts into Campaigns by client, channel and day. Changed rows are written in contiguous runs and new rows in one block. A rerun for the same days changes nothing. Conversions may be fractional (Google Ads gives 2.5 with data driven attribution) and are kept to 4 decimals; clicks and the cost stay whole numbers. A record that does not become its own Campaigns row is counted with the reason in `dropped` (a record that is not an object, no usable date, no account id, no channel, a bad cost, a bad currency, bad clicks, bad conversions, an account id that no client has, and a record replaced by a later one for the same client, channel and day), and the Pull ad costs message says how many and why after the new and changed counts. `dropped` is present only when there is something to say. The write happens under the script lock. A range is at most 92 days.

The stand-in host `ads.example.test` exists only in the test fake (`test/fake/services.js`). To use a real platform, set the `AD_API_BASE` script property to its base URL, put its key in `AD_API_KEY`, and change the field mapping in `checkAdItem_` and `syncAdCosts`.

**Currency rates.** `syncCurrencyRates(from, to)` asks the Frankfurter API for rates against USD for every non USD currency used in Campaigns: `https://api.frankfurter.dev/v2/rates?base=USD&quotes=EUR,GBP&from=2026-10-01&to=2026-10-10`. The reply is a list of `{date, base, quote, rate}`. The script checks every record and upserts into the Rates sheet. A rate is units of the currency per 1 USD, so a euro amount is divided by it.

The menu item **Pull currency rates** asks for every day from the first day of the earliest month that has a Campaigns row in another currency up to today, never more than 3 years back, and with no such row for the last 30 days. A long range goes in pieces of at most 92 days (the size of one ad cost pull), so one call never asks for a very long stretch. A report needs the rate of each row's own day: with only the last 30 days pulled, the rows of last month had no rate and were left out of the totals.

## How it was tested

Against the fake only. `UrlFetchApp` in the fake serves the stand-in ad platform and a Frankfurter stand-in built from the generated rates.

- The backoff waits are asserted exactly (500, 1000, 2000, 4000 with the jitter fixed), the cap, the `Retry-After` cases, the attempt count, no wait after the last attempt, no retry for 400, 401, 403, 404 and 422, retry of a thrown DNS error, an HTML page with status 200, broken JSON, a failing `validate`, the deadline.
- A seeded property test runs 30 random fault sequences and checks that each ends in the data or in an error that carries the status and the attempt count.
- Pagination: several pages in order, a repeated token, a page with no list, no end.
- The ad sync: pages and counts against the fixtures, rerun changes nothing, new days, unknown accounts, bad records, a 429 and a 503 on the way, a wrong key, bad arguments before any request, an outage, a maintenance page, the lock.
- The rates sync: the exact URL, a rerun, a restated rate, a gap filled, rates feeding the summaries, USD only, bad arguments, a bad rate in the reply.

## What it does NOT do

- **Frankfurter has not been called by this repo's code.** The reply shape was checked by hand with a few `curl` requests on 2026-11-10 and copied into the stand-in.
- The ad platform is invented. Real platforms (Google Ads, Meta) use OAuth, their own report formats and their own limits.
- No OAuth flow, no token refresh.
- Daily quota use is not tracked. Apps Script allows 20,000 URL fetch calls a day on a consumer account and 100,000 on Workspace.
