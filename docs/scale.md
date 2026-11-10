# Large sheets inside the 6 minute limit

Source: `src/BulkProcess.js`. Tests: `test/bulk.test.js`.

## What it does

`startBulkNormalize()` (start it from the editor, see [maintenance.md](maintenance.md)) cleans every Campaigns row into the Clean sheet (same row number, a status of `ok` or `bad:<reason>`, spend converted to USD) and then writes a client and month rollup to the Rollup sheet. It works in chunks of 5,000 rows and stays inside one Apps Script run by checking a time budget.

How a run works:

1. It takes the script lock. If another run holds it, it returns `locked` and does nothing. The time budget below counts from the start of the first run, so the time spent clearing the Clean sheet and growing the grid is part of it.
2. It creates a continuation trigger with `ScriptApp.newTrigger('continueBulkJob').timeBased().after(7 minutes)` first. If the run is killed, that trigger resumes the job.
3. It reads a chunk with one `getValues`, cleans it in memory, and writes it to the same row numbers in Clean with one `setValues`. Writing to fixed rows means a chunk done twice (for example after a kill) rewrites the same rows and cannot add rows or count anything twice.
4. It saves the cursor (next row, rows done, last chunk time) in the `BULK_CURSOR` script property after every chunk.
5. Before every chunk after the first it checks that `elapsed + 1.25 * last chunk time` is under the 4.5 minute budget. The first chunk of a run always runs, so a slow chunk cannot stall the job.
6. When the budget is used it replaces the trigger with one that fires in 1 minute and ends. The new trigger is created before the old one is deleted, so a job that exists always has a trigger.
7. The rollup is one pass over Clean. It starts only when the time left covers an estimate made from the measured read speed. It rewrites the whole Rollup sheet, so running it twice gives one result.
8. At the end it writes one Job Log row (replacing a row from an earlier finish of the same job), deletes the cursor, then deletes the triggers. If the run is killed between those steps, a leftover trigger finds no cursor and removes itself.

Rows with a blank client, text or negative spend, a bad date, a bad count or a currency without a rate stay in Clean with their reason and are left out of the rollup.

## How it was tested

Against the fake, which enforces the 6 minute limit, charges simulated time for every service call and for every cell read or written, and has a 20 trigger limit.

- **50,000 generated rows** (about 1 in 60 bad on purpose) with a slow clock (0.3 ms per cell read, 0.85 ms per cell written, chosen so the job needs more than one run). It finished in 3 runs: `continuing`, `continuing`, `done`. Clean holds 50,000 rows, each source row once at its own row number. The rollup (198 client and month lines) matches an independent calculation in `scripts/seed.js` for cents, clicks, conversions and row counts, and the valid row count equals the generator's. At most one trigger existed at a time and none were left. These timings are simulated; real Apps Script timings were not measured.
- **A seeded kill test**: 25 random worlds of 2,500 rows in chunks of 500, where each run is killed at a random service call about 4 times out of 5. After a kill the fake stops all further service calls, as the real limit does. Over all worlds this killed the job more than 40 times, and every world still ended with every row once, a correct rollup and no triggers left.
- A kill after the third chunk was written: the cursor already holds those three chunks, and the safety trigger is waiting.
- A kill after the log row and before the cursor is deleted: the next run finishes and leaves one log row.
- One chunk per run when a chunk alone takes most of the budget.
- A second run while one is running (`locked`), a late trigger after the job is done, a start while a job is running (refused), a restart, an empty sheet, a job on a smaller sheet after a bigger one.

## What it does NOT do

- The bulk job was not run on a real account, so the chunk size and the budget are not tuned to real speeds. Reading 5,000 rows by 7 columns and writing 5,000 rows by 9 columns is expected to be faster than the simulated clock. That is expected, not measured. The budget check makes the job correct at any speed.
- Rows added to Campaigns while a job runs are picked up by the next job, not this one. The job works on the row count it saw at the start. A test adds two rows between runs and checks both halves of that.
- The cursor is one script property, so there is one job at a time per script.
- Time driven triggers have their own daily runtime limit (90 minutes on a consumer account, 6 hours on Workspace). A very large sheet can hit it.
