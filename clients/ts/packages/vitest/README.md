# @mergifyio/vitest

A **Vitest** reporter that integrates seamlessly with **Mergify**, uploading
OpenTelemetry traces of test executions to Mergify CI Insights, along with
optional **quarantine** and **flaky-test detection**.

More information at https://mergify.com

## Installation

Install the package as a dev dependency alongside `vitest` (>= 3.0.0):

```bash
npm install --save-dev @mergifyio/vitest
```

## Usage

Register `MergifyReporter` in your `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import MergifyReporter from '@mergifyio/vitest';

export default defineConfig({
  test: {
    reporters: ['default', new MergifyReporter()],
  },
});
```

Set `MERGIFY_TOKEN` in your CI environment so the reporter can upload test
traces. Without it, the reporter stays silent and tests run normally.

### Environment variables

| Variable | Description | Default |
|---|---|---|
| `MERGIFY_TOKEN` | Mergify API authentication token | (required) |
| `MERGIFY_API_URL` | Mergify API endpoint | `https://api.mergify.com` |
| `VITEST_MERGIFY_ENABLE` | Force-enable outside CI | `false` |
| `MERGIFY_CI_DEBUG` | Print spans to console instead of uploading | `false` |
| `MERGIFY_TRACEPARENT` | W3C distributed trace context | — |

For detailed documentation, see the [official guide](https://docs.mergify.com/ci-insights/test-frameworks/vitest/).

## Development

Clone the repo and install dependencies:

```bash
pnpm install
```

Available scripts (from this package's directory or with `pnpm --filter @mergifyio/vitest`):

| Command | What it does |
|---|---|
| `pnpm test` | Run the test suite once (`vitest run`) |
| `pnpm run build` | Bundle the package with `tsdown` |
