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

### Where quarantine, flaky detection and test selection apply

These three act on the run itself. The reporter adds a setup file to every
project of your config, so quarantine and test selection apply the same way in
each of the shapes below (flaky detection runs in Node projects only, see
further down):
- a single Node config;
- each project under `test.projects` (or `test.workspace` before Vitest 3.2);
- browser mode;
- custom pools such as `@cloudflare/vitest-pool-workers`.

A `runner` you configured yourself keeps running underneath. The reporter
supports Vitest 3.0 through 5.0.

The `@mergifyio/vitest/runner` entry point is gone: the reporter no longer
installs a runner. If your config sets `runner: '@mergifyio/vitest/runner'`,
remove that line; the reporter alone now applies everything it used to.

Earlier versions applied them only to a single Node config. Under `projects`, in
browser mode, or with a custom pool they did nothing, and the reporter printed
no warning. If you use one of those shapes, quarantined failures now stop
failing your job, and new tests are rerun in Node projects.

Flaky detection needs a native binary to size its reruns. It runs only in Node
projects:
- browser projects do not rerun new tests;
- a pool that cannot load native modules (the Cloudflare Workers pool) does
  not either.

The end-of-run output says which projects were not checked. It also names any
project where none of the three applied: that happens when a custom `runner`
overrides `onBeforeRunTask` without calling `super`.

### Reduced merge-queue reruns

When the merge queue reruns a CI that failed — a `max_checks_retries` attempt or
a bisection step — Mergify already knows which tests failed on the previous
attempt. The reporter asks for that list and skips every
other test, so the rerun replays only what actually gated.

**It is off until you turn it on, per job**: set
`MERGIFY_TEST_SELECTION_ENABLE=true` on the job you want reduced. Installing
the reporter is not enough — a feature that decides not to run tests starts
only where you wrote that it should. Anything that is not a recognised yes
(unset, empty, `false`, unparsable) means no, and a job that has not opted in
never queries the endpoint.

Sharded jobs (`--shard`) are supported: each shard is matched to the same
shard of the previous attempt, by the files it runs. A shard whose tests all
passed last time runs nothing and stays green.

At the end of the run the reporter sends Mergify what it concluded (the counts
and the failing tests), which is what the next retry of the batch is answered
from.

The selection applies only where Vitest loads the bundled runner: a single
Node project. Under `test.projects`, in browser mode, or with your own
`runner`, the reporter asks for nothing and the full suite runs.

Once opted in, it only ever removes work:

- any error, timeout, or unrecognised answer runs the full suite;
- if Mergify refuses to pick a previous attempt (several runs of this job
  report under one name), the run **fails** with Mergify's explanation: give
  each run its own `MERGIFY_TEST_JOB_NAME`;
- the served subset is matched against the tests Vitest actually collected, and
  it is applied **after** your own filters — `--testNamePattern`, `.only`, tags
  and file arguments all still narrow the run, never widen it;
- tests removed by the selection are not reported at all: a test that never ran
  is not a skipped test, and reporting it as one would distort per-test health
  statistics;
- if any test of the served subset is not collected here (renamed since the
  previous attempt, or named differently on each run), the run **fails**
  rather than turn green without having replayed it;
- if the run fails outside any test (a failing hook, a file that does not
  import, an unhandled error), its results are not sent to Mergify, so a retry
  runs the full suite.

### Environment variables

| Variable | Description | Default |
|---|---|---|
| `MERGIFY_TOKEN` | Mergify API authentication token | (required) |
| `MERGIFY_API_URL` | Mergify API endpoint | `https://api.mergify.com` |
| `VITEST_MERGIFY_ENABLE` | Force-enable outside CI | `false` |
| `MERGIFY_CI_DEBUG` | Print spans to console instead of uploading | `false` |
| `MERGIFY_TEST_SELECTION_ENABLE` | Let Mergify reduce a merge-queue rerun of this job | `false` |
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
