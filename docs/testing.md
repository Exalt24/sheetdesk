# Testing

Tests: `test/*.test.js`. Mutation harness: `scripts/mutation.js`. Fake: `test/fake/gas.js`.

## Run it

```bash
npm install
npm test            # 228 tests
npm run lint        # ESLint, zero warnings allowed
npm run mutation    # 143 mutants, about 15 minutes
```

| Command | Result |
|---|---|
| `npm test` | 228 tests pass in about 9 seconds on Windows 11 with Node 24 |
| `npm run lint` | 0 errors, 0 warnings |
| `npm run mutation` | 143 mutants, 143 caught, 0 survived |

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

## Mutation testing

A mutant is a copy of the code with one guard removed or flipped, for example the secret check deleted, or a `<=` changed to `<`. If the tests still pass on a mutant, no test checks that guard. `scripts/mutation.js` builds each mutant, runs the whole suite against it and expects a failure. A mutant that fails the suite is caught. A mutant that passes is a survivor, and a survivor is a missing test.

The harness refuses a mutant when its text to change is not found exactly once, and it compiles each changed file first, so a mutant that changed nothing or only broke the syntax cannot pass for the wrong reason. It also runs the suite once with no mutant, which must pass.

The guards in the list include the secret check, the lock, the idempotency check, the chunk cursor, the time budget, retry on 429, the PDF replace, the sidebar input checks, the formula guard, each form of text that Sheets would read as a value, the preview recipient, and the wrapper that turns an unexpected failure into JSON.

```bash
node scripts/mutation.js              # every mutant, 4 at a time
node scripts/mutation.js preview      # the mutants whose id contains "preview"
```

## What this does not show

- The fake can differ from Google's services in ways this repo cannot see. Where the reference is silent the fake is strict, so it may refuse something the real service accepts.
- The mutants are guards that were chosen by hand. A guard nobody thought of has no mutant.
- The CI workflow (`.github/workflows/ci.yml`) runs `npm ci`, `npm run lint` and `npm test` on `ubuntu-latest` with Node 24, for pushes to `main` and for pull requests. It runs green on GitHub. The mutation run is not in CI because it takes minutes.
