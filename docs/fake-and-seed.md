# The fake Google services and the seeded data

Source: `test/fake/gas.js`, `test/fake/services.js`, `test/helpers/load.js`, `scripts/seed.js`. Tests: `test/fake.test.js`, `test/seed.test.js`.

## The fake

`test/fake/gas.js` is a local stand-in for SpreadsheetApp, DocumentApp, DriveApp, GmailApp, FormApp, HtmlService, ContentService, UrlFetchApp, CacheService, PropertiesService, LockService, ScriptApp, Utilities, Logger and Session. It was written from Google's public Apps Script reference. It is not Google's code and has not been compared with a live account.

The loader (`test/helpers/load.js`) puts every file of `src/` into one `vm` context next to the fake, the same way Apps Script uses one global scope. It reads `src/appsscript.json`, so the fake refuses a service whose scope is missing from the manifest.

Where the fake is exact, strict or approximate:

| Rule | Source of the rule |
|---|---|
| `setValues` row and column count messages, `getRange` argument checks | the reference, and messages seen in practice |
| Text is read as if typed: `007` becomes 7, `2026-10-03` becomes a date in the sheet time zone, a leading `'` keeps text, `=` starts a formula | seen in practice, not in the reference |
| A write past the grid fails until rows are inserted | stricter than the real service may be |
| Lock: `tryLock` returns false on timeout, `waitLock` throws, the lock frees when the execution ends, releasing with unflushed writes is recorded | the reference |
| Cache: key at most 250 characters, value at most 100 KB, life at most 6 hours. Properties: value at most 9 KB, store at most 500 KB | the reference |
| At most 20 triggers, `everyMinutes` takes only 1, 5, 10, 15, 30 | the reference |
| GmailApp: valid recipients, subject at most 250 characters, blob attachments, a daily quota | the reference, and the quota message seen in practice |
| A Document is closed after `saveAndClose`, and a PDF made before saving misses the edits | the reference and practice |
| `replaceText` takes an RE2 pattern, so lookahead and backreferences are refused. A `$` in the replacement is refused | the pattern rule is the reference, the `$` rule is deliberately strict |
| A simple trigger cannot use Gmail, Drive, UrlFetchApp or triggers | the reference |
| `UrlFetchApp` throws on an error status unless `muteHttpExceptions` is set, and the error text follows the real one | practice |
| The 6 minute limit, enforced at the next service call | the reference |

Each rule has a test in `test/fake.test.js`. HTML templates support `<?= ?>` (escaped), `<?!= ?>` (raw) and scriptlets.

The fake also keeps a simulated clock. Every call costs a few milliseconds, every cell read or written costs a little more, and `Utilities.sleep` moves the clock without waiting. Tests use it to make "a slow day" without waiting.

## What the fake does not cover

Real quotas other than the ones listed, real latency, concurrent executions on separate machines (two overlapping runs are simulated by running one inside a hook of the other), the Google iframe, authorisation prompts, PDF layout, and every part of each service that this repo does not call.

## The seeded data

`node scripts/seed.js` writes `fixtures/` from a seeded generator. Same seed, same files. Everything is invented: nine clients (one paused), three months of daily campaign rows in USD, EUR and GBP, 300 leads with `example.com` addresses and reserved 555-01xx phone numbers, weekday rates, and the day records the stand-in ad platform serves. `test/seed.test.js` checks that the committed files equal what the generator writes, and that no real looking address appears.

For the scale test the same generator makes 50,000 rows in memory, about 1 in 60 bad on purpose, and `referenceRollup` computes the expected result without any code from `src/`.
