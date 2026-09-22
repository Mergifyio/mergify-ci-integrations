# @mergifyio/playwright

A **Playwright** reporter that integrates seamlessly with **Mergify**, uploading
OpenTelemetry traces of test executions to Mergify CI Insights and absorbing
failures of tests quarantined via Mergify's CI Insights Quarantine feature.

More information at https://mergify.com

## Installation

Install the package as a dev dependency alongside `@playwright/test` (>= 1.40.0):

```bash
npm install --save-dev @mergifyio/playwright
```

## Usage

Wrap your `playwright.config.ts` with `withMergify` and import `test` /
`expect` from `@mergifyio/playwright` instead of `@playwright/test`:

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';
import { withMergify } from '@mergifyio/playwright';

export default withMergify(defineConfig({
  projects: [{ name: 'chromium', use: { /* ... */ } }],
}));
```

```ts
// tests/example.spec.ts
import { test, expect } from '@mergifyio/playwright';

test('flaky thing', async ({ page }) => {
  // ...
});
```

Set `MERGIFY_TOKEN` in your CI environment. Without it, the integration stays
silent and tests run normally.

`withMergify` registers the reporter that uploads test-run traces to Mergify
CI Insights, plus a `globalSetup` that fetches the quarantine list and a
`globalTeardown` that cleans up. The `test` export is Playwright's base `test`
extended with an auto-fixture: when a test's name is on the quarantine list
AND it fails, the fixture sets `testInfo.expectedStatus = 'failed'` so
Playwright reports the outcome as passing. Quarantined tests that pass are
reported as passing unchanged (no "unexpected pass" penalty — matches
pytest's `xfail(strict=False)`).

At the end of the run, a summary is printed on stderr:

```
[@mergifyio/playwright] Quarantine report:
  fetched: 3
  caught:  1
    - tests/auth.spec.ts > Login > submits form
  unused:  2
    - tests/api.spec.ts > retries once
    - tests/data.spec.ts > builds payload
```

**Gotcha:** wrapping the config with `withMergify` but forgetting to change
the `test` import leaves the quarantine list fetched but never applied —
every entry shows up under "unused" (the `caught` count stays 0).

### Flaky detection (preview)

Flaky detection is opt-in per repository from the Mergify dashboard. Once a
repository has opted in, the reporter:

1. Fetches the API context in `globalSetup` and decides a mode based on
   the run shape:
   - **`new` mode** on PR-like runs (a base ref is detected): newly-added
     tests are candidates; phase-1 failures stand (no absorption).
   - **`unhealthy` mode** on push or scheduled runs: API-listed unhealthy
     tests are candidates; phase-1 failures of those tests are absorbed
     via the same fixture path as the regular quarantine list.
2. Records each candidate's phase-1 outcome and duration during the
   normal test run.
3. After the main run, spawns a single Playwright subprocess
   (`playwright test --test-list '<candidates>' --repeat-each=N`) that
   re-runs each candidate `N` times with native fresh fixtures. The
   subprocess writes per-attempt outcomes to a JSONL file.
4. Aggregates phase-1 + phase-2 outcomes per candidate. Mixed pass/fail →
   the candidate is flagged flaky and four attributes are emitted on its
   span: `cicd.test.flaky_detection`, `cicd.test.new`, `cicd.test.flaky`,
   `cicd.test.rerun_count`.
5. Prints a "Flaky detection report" summary on stderr.

Each phase-2 rerun is a fresh Playwright test invocation, so all fixtures
(including user-defined `test.extend(...)` ones) are re-initialised
between attempts — this matches Playwright's normal test-isolation
guarantees.

#### Caveats

- **Cost.** Phase 2 spawns an extra `playwright test` invocation; large
  candidate sets multiply the wall-clock time.
- **Runtime `test.skip(condition)` inside a candidate body** can produce
  ambiguous outcomes — the test is recorded as skipped, but rerun
  iterations may behave differently from the first.
- **Aggregation only counts phase-2 attempts as `rerunCount`.** Phase 1's
  attempt is included in the flakiness decision but not in the count.

### Reduced merge-queue reruns

**This is off until you turn it on, per job**: set
`MERGIFY_TEST_SELECTION_ENABLE=true` on the job you want reduced. Installing
the reporter is not enough — a feature that decides not to run tests starts
only where you wrote that it should. A job that has not opted in never queries
the endpoint, and anything that is not a recognised yes (unset, empty, `false`,
unparsable) means no.

When Mergify's merge queue relaunches a CI run that failed, it already knows
which tests broke. The reporter asks the API whether this run may replay only
those — from Playwright's `Reporter.preprocess()` hook, once the collection is
known, because the request carries a fingerprint of the tests this run
collected and Mergify only answers a run that collects the same tests the
previous attempt did. The hook runs after your own `--project`, `--grep` and
`.only` filters, so the answer can only ever narrow what you asked for.

Four answers are understood, and the end of the run says which one it got:

- **full** — everything ran, with the reason in one sentence:

  ```
  ✂️ Test selection

  First attempt of this batch, so the full suite ran.
  ```

- **subset** — only the tests that failed on the previous attempt ran:

  ```
  ✂️ Test selection

  The code under test hasn't changed since the previous attempt of this job, where
  2 of its 7 tests failed. Mergify re-executed only those 2 and skipped the 5 that
  had already passed:

    [chromium] > tests/login.spec.ts > logs in
    [chromium] > tests/cart.spec.ts > checks out
  ```

- **empty** — the previous attempt ran these tests and they all passed, so
  nothing ran and the job is green. On an unsharded job Playwright still prints
  `Error: No tests found` before the reporter turns the run green; that line is
  Playwright's, and the block below it says why nothing was executed.

- **refused** — several runs of this job report to Mergify under the same name,
  and Mergify will not guess which one this run repeats. The run **fails**, with
  Mergify's own explanation printed first. The fix is to give each run its own
  name with `MERGIFY_TEST_JOB_NAME` (see sharding below).

The feature can only ever remove work, never coverage. The full suite runs
whenever anything is off-nominal:

- the API errors, times out, or answers in a way this version does not
  understand (the block says so);
- the repository has no subscription, or the engine has no such endpoint;
- **a served name is not among the tests actually collected** — the whole
  answer is declined rather than reduced to the part that matched, so a stale
  subset after a rename never turns into a green run over nothing;
- the job did not set `MERGIFY_TEST_SELECTION_ENABLE=true` — the opt-in above.

Setup and teardown projects always run in full: Playwright makes their tests
read-only, and they are not part of the fingerprinted collection.

#### Sharded jobs

Each `--shard=k/N` leg is its own job for Mergify: it asks with its own
collection and is answered with its own failures. Two things follow:

- **Naming each leg is recommended, not required.** Mergify tells the legs
  apart by what they collected — two legs of one job run different slices, so
  they carry different fingerprints and each is answered from its own previous
  attempt even under one job name. Setting `MERGIFY_TEST_JOB_NAME` per leg
  (for example `e2e-${{ matrix.shard }}`) makes the job log and the Mergify
  page name the legs apart, and covers the one case the fingerprint cannot:
  two legs that collected the same set (an empty slice on both, say), which
  Mergify refuses rather than guesses, as described above.
- **The reporter partitions the suite itself** once the job opted in: it hands
  sharding over through Playwright's `TestRun.skipSharding()` and keeps whole
  files together, in collection order, with Playwright's own arithmetic. The
  partition is the same on every attempt, which is what lets a leg's collection
  match the previous attempt's — and on a rerun each leg runs exactly the tests
  Mergify served it, with no second split. `PWTEST_SHARD_WEIGHTS` is honoured
  as Playwright honours it (colon-separated, one non-negative integer per leg).
- **A leg's slice must be stable from one attempt to the next** — same suite,
  same weights, same number of legs. If it changes, the leg's fingerprint no
  longer matches its previous attempt's and Mergify serves it the full suite:
  never a false green, but no reduction either. Keeping the slice stable is
  the job's responsibility, not something Mergify guesses at.

Only one reporter may take sharding over; a second one calling
`skipSharding()` makes Playwright abort the run.

**Requires `@playwright/test` 1.62 or later**, where `Reporter.preprocess()` was
added. On older versions the hook is never called, the full suite runs, and the
reporter says so on stderr.

### Multi-project test names

When your config defines named [projects](https://playwright.dev/docs/test-projects)
(e.g. one per browser), each project runs the same tests. To keep their results
distinct in CI Insights, Mergify prefixes the project to the test name, following
Playwright's JUnit `includeProjectInTestName` convention:

```
[chromium] > tests/login.spec.ts > logs in
[firefox] > tests/login.spec.ts > logs in
```

This is **opt-in** (off by default, to preserve existing test history). Set
`PLAYWRIGHT_MERGIFY_INCLUDE_PROJECT_IN_TEST_NAME=true` to enable it. Tests with
no project name are never prefixed.

### Environment variables

| Variable | Description | Default |
|---|---|---|
| `MERGIFY_TOKEN` | Mergify API authentication token | (required) |
| `MERGIFY_API_URL` | Mergify API endpoint | `https://api.mergify.com` |
| `PLAYWRIGHT_MERGIFY_ENABLE` | Force-enable outside CI | `false` |
| `PLAYWRIGHT_MERGIFY_INCLUDE_PROJECT_IN_TEST_NAME` | Prefix the project to multi-project test names as `[project] > …` | `false` |
| `MERGIFY_TEST_SELECTION_ENABLE` | Let Mergify reduce a merge-queue rerun of this job; anything unparsable means no | `false` |
| `MERGIFY_TEST_JOB_NAME` | The name this job reports under; recommended per leg of a matrix or a `--shard` run | provider job name |
| `MERGIFY_CI_DEBUG` | Print spans to console instead of uploading | `false` |
| `MERGIFY_TRACEPARENT` | W3C distributed trace context | — |
| `MERGIFY_TEST_RUN_ID` | Test run identifier (set by `withMergify`'s globalSetup; read by workers) | — |
| `MERGIFY_STATE_FILE` | Path to the per-run state file (set by globalSetup; read by workers) | — |
| `MERGIFY_RERUN_FILE` | JSONL file the rerun subprocess writes to (set internally; do not set manually) | — |

For detailed documentation, see the [official guide](https://docs.mergify.com/ci-insights/test-frameworks/).

## Development

Clone the repo and install dependencies:

```bash
pnpm install
```

Available scripts (from this package's directory or with `pnpm --filter @mergifyio/playwright`):

| Command | What it does |
|---|---|
| `pnpm test` | Run the test suite once (`vitest run`) |
| `pnpm run build` | Bundle the package with `tsdown` |
