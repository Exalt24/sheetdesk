# Testing

Tests: `test/*.test.js`. Mutation harness: `scripts/mutation.js`. Fake: `test/fake/gas.js`.

## Run it

```bash
npm install
npm test            # 493 tests
npm run lint        # ESLint, zero warnings allowed
npm run mutation    # well over an hour for the whole list
```

| Command | Result |
|---|---|
| `npm test` | 493 tests (491 pass, 2 skipped by name, none fail) on Windows 11 with Node 24 |
| `npm run lint` | 0 errors, 0 warnings |
| `npm run mutation` | the list holds 1,522 mutants (203 typed, 1,319 from the syntax tree) and 14 equivalent mutants that are skipped (`EQUIVALENT` in `scripts/mutation.js`, each with its reason, listed below). After the fifth pass the mutants of the touched files (`Reporting.js`, `Menu.js`, `AdPlatform.js`, `Dialog.html`, `Sidebar.html`) were run: 1,087 mutants (90 typed, 997 from the syntax tree), 1,074 caught on the first run, 13 survived for want of an assertion and were caught on a rerun after the assertions were added, none survives. The full set is rerun by the lead; no total for the whole list is claimed until then |

The tests do not touch Google. One run by hand on a live account is written up in [live-run.md](live-run.md). The tests prove the code against [a local fake of Google's services](fake-and-seed.md) that was written from Google's reference, so they are as accurate as that fake.

## What the tests load

The tests load the files in `src/` into one `vm` context beside the fake, the way Apps Script puts every file in one global scope. The fake enforces the 6 minute limit, the lock rules, the 20 trigger limit and the quotas it knows. It also checks that each service call has a scope in the manifest, and the simple trigger restrictions. A few rules come from practice, such as `007` becoming 7 when a cell is set. [fake-and-seed.md](fake-and-seed.md) lists which rules come from the reference and which were seen in practice. Each rule has its own test.

## What the tests check

- **Totals** are compared with an independent calculation (`referenceRollup` in `scripts/seed.js`) for every client and month of the generated agency.
- **Scale.** 50,000 generated rows, about 1 in 60 bad on purpose. The simulated clock charges 0.3 ms per cell read and 0.85 ms per cell written, chosen so the job needs more than one run. Result: 3 runs, 50,000 Clean rows with each source row once at its own row number, 49,166 valid rows counted once, and a 198 line rollup equal to the reference. At most one trigger existed at a time and none were left. The timings are simulated. Real timings were not measured.
- **Kills.** 25 seeded worlds where each run is killed at a random service call about 4 times in 5. That is over 40 kills, and every world ends with every row once.
- **Webhook.** 25 random sequences of 40 requests must end with each accepted lead stored once. They mix wrong secrets, extra fields, lock contention and look-alike ids like `007` and `7`. Separate tests make each step that can throw do so (a renamed header, a cache that refuses a write, a failing flush) and check the caller still gets JSON and the lock is released.
- **HTTP client.** The waits are asserted exactly (500, 1000, 2000, 4000 ms). 30 random fault sequences must end in data or a clear error.
- **Text that Sheets would read as a value.** `sheetText_` is run against numbers, thousands separators, percents, currency, times and dates. The fake converts each form the way Sheets does, so a cell written without the guard changes and a test fails. See [webhook.md](webhook.md).
- **Scopes.** The manifest must list exactly the scopes in the table in [maintenance.md](maintenance.md), and the tests run every feature once with each scope removed in turn. A scope that no feature needs would show up as a run that still passes.
- **Send to me first.** The preview goes to the person running the script and never to the client, and it does not count as the email to the client.
- **Nothing reaches a client before the guards.** Mail is sent in two places only, the report send and the intake confirmation. `test/send-gate.test.js` runs every entry that can mail a report (a single report, a forced one, the sidebar with the box unticked, the month close, its dialog, and the report send called with nothing around it) against a finished month, a running month at several clocks and zones, and each kind of Campaigns row that is left out, with and without the confirmation. It also reads a call graph from `src/` and fails when a function that reaches the report send is not in its table, so a new caller cannot skip the month check or the hold.
- **A skip is a count and a reason.** `test/skips.test.js` runs every value of a client's status cell and every shape of stale summary tab, and `test/ad-dropped.test.js` every reason an ad record is dropped, each against the result and the message that must name it.

## Mutation testing

A mutant is a copy of the code with one guard removed or flipped, for example the secret check deleted, or a `<=` changed to `<`. If the tests still pass on a mutant, no test checks that guard. `scripts/mutation.js` builds each mutant, runs the whole suite against it and expects a failure. A mutant that fails the suite is caught. A mutant that passes is a survivor, and a survivor is a missing test.

The harness refuses a mutant when its text to change is not found exactly once, and it compiles each changed file first, so a mutant that changed nothing or only broke the syntax cannot pass for the wrong reason. It also runs the suite once with no mutant, which must pass.

The guards in the list include the secret check, the lock, the idempotency check, the chunk cursor, the time budget, retry on 429, the PDF replace, the sidebar input checks, the formula guard, each form of text that Sheets would read as a value, the preview recipient, the wrapper that turns an unexpected failure into JSON, and, from the fourth pass, the month that has ended check of the month close, the range of the rate pull, the sentence for rows left out of the totals, the list of clients with no usable address, the forms a budget can be written in, and the name clash check that counts only active rows. The syntax tree mutants cover those functions too.

The mutants of the second review round are not typed. `scripts/mutation-ast.js` parses the changed functions with espree (it comes with ESLint), picks the statements that carry the fixes and derives every mutant from the syntax tree: each comparison and arithmetic operator swapped, each condition made always true, always false or negated, each number moved by one, each string emptied, each call and assignment removed, and the `addCount_` call turned back into a plain `+`. A mutant is an exact position in the file, so it hits the one node it came from. These mutants run only against the corpus replay and the tests named `CLASS-TABLE`, so a fix has to be held by its class test and not by a test written for one mutant. Mutants known to change nothing are listed with the reason in `EQUIVALENT` in `scripts/mutation.js`.

```bash
node scripts/mutation.js              # every mutant, 4 at a time
node scripts/mutation.js preview      # the mutants whose id contains "preview"
node scripts/mutation.js --ast        # only the mutants derived from the syntax tree
```

## The corpus

`test/corpus/corpus_sheetdesk_1.jsonl` holds 98 cases written by an independent reviewer who had only the README and the docs: 85 that the code already passed and 13 that it failed. Each line has an input, the result the docs promise, a reason and whether the case is real or invented. `test/corpus.test.js` replays every line through the code. 12 of the 13 failures were fixed. The last one, a lead whose id is a web address, is skipped by name in the test because the id shape rule was kept on purpose.

## What this does not show

- The fake can differ from Google's services in ways this repo cannot see. Where the reference is silent the fake is strict, so it may refuse something the real service accepts.
- The mutants are guards that were chosen by hand. A guard nobody thought of has no mutant.
- The CI workflow (`.github/workflows/ci.yml`) runs `npm ci`, `npm run lint` and `npm test` on `ubuntu-latest` with Node 24, for pushes to `main` and for pull requests. It runs green on GitHub. The mutation run is not in CI because it takes minutes.
