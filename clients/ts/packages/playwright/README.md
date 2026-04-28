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

### Environment variables

| Variable | Description | Default |
|---|---|---|
| `MERGIFY_TOKEN` | Mergify API authentication token | (required) |
| `MERGIFY_API_URL` | Mergify API endpoint | `https://api.mergify.com` |
| `PLAYWRIGHT_MERGIFY_ENABLE` | Force-enable outside CI | `false` |
| `MERGIFY_CI_DEBUG` | Print spans to console instead of uploading | `false` |
| `MERGIFY_TRACEPARENT` | W3C distributed trace context | — |
| `MERGIFY_TEST_RUN_ID` | Test run identifier (set by `withMergify`'s globalSetup; read by workers) | — |
| `MERGIFY_STATE_FILE` | Path to the per-run quarantine state file (set by globalSetup; read by workers) | — |

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
