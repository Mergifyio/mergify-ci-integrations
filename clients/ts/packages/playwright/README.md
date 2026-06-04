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

Set `_MERGIFY_TEST_NEW_FLAKY_DETECTION=true` to opt into Mergify's flaky-
detection feature. When enabled, the reporter:

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

| Variable | Description | Default |
|---|---|---|
| `_MERGIFY_TEST_NEW_FLAKY_DETECTION` | Enable flaky detection | `false` |

#### Caveats

- **Cost.** Phase 2 spawns an extra `playwright test` invocation; large
  candidate sets multiply the wall-clock time.
- **Runtime `test.skip(condition)` inside a candidate body** can produce
  ambiguous outcomes — the test is recorded as skipped, but rerun
  iterations may behave differently from the first.
- **Aggregation only counts phase-2 attempts as `rerunCount`.** Phase 1's
  attempt is included in the flakiness decision but not in the count.

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
| `MERGIFY_CI_DEBUG` | Print spans to console instead of uploading | `false` |
| `MERGIFY_TRACEPARENT` | W3C distributed trace context | — |
| `MERGIFY_TEST_RUN_ID` | Test run identifier (set by `withMergify`'s globalSetup; read by workers) | — |
| `MERGIFY_STATE_FILE` | Path to the per-run state file (set by globalSetup; read by workers) | — |
| `MERGIFY_RERUN_FILE` | JSONL file the rerun subprocess writes to (set internally; do not set manually) | — |
| `_MERGIFY_TEST_NEW_FLAKY_DETECTION` | Enable flaky-detection preview | `false` |

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
