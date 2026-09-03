# pytest-mergify

Pytest plugin for [Mergify Test Insights](https://docs.mergify.com/ci-insights/).

More information at https://mergify.com

## Features

- **Test tracing** — Sends OpenTelemetry traces for every test to Mergify's API
- **Flaky test detection** — Intelligently reruns tests to detect flakiness with budget constraints
- **Test quarantine** — Quarantines failing tests so they don't block CI
- **Test selection** — Runs only the previously-failing tests when Mergify's merge queue reruns a job

## Installation

Install the package alongside `pytest` (>= 6.0.0):

```bash
pip install pytest-mergify
```

The plugin is auto-discovered by pytest — no manual registration required.

## Configuration

Set the `MERGIFY_TOKEN` environment variable with your Mergify API token.

The plugin activates automatically when running in CI (detected via the `CI` environment variable). To enable outside CI, set `PYTEST_MERGIFY_ENABLE=true`.

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `MERGIFY_TOKEN` | Mergify API authentication token | (required) |
| `MERGIFY_API_URL` | Mergify API endpoint | `https://api.mergify.com` |
| `PYTEST_MERGIFY_ENABLE` | Force-enable outside CI | `false` |
| `PYTEST_MERGIFY_DEBUG` | Print spans to console | `false` |
| `MERGIFY_TRACEPARENT` | W3C distributed trace context | — |
| `MERGIFY_TEST_JOB_NAME` | Mergify test job name | — |
| `MERGIFY_TEST_SELECTION_DISABLE` | Opt out of test selection (see below) | `false` |

For detailed documentation, see the [official guide](https://docs.mergify.com/ci-insights/test-frameworks/pytest/).

### Test selection

When Mergify's merge queue reruns a job — a retry, or a step of a batch
bisection — only the tests that failed on the previous attempt are
informative. The plugin asks Mergify whether the current run is such a rerun
and, if so, runs only those tests; the rest are reported as deselected.

Two other answers exist. Mergify may say the previous attempt of this job
already ran every one of these tests and they all passed: the run then executes
no test and exits green, and still reports itself so the attempt is visible.
Or Mergify may stop the run outright. That happens when several runs of this
job report under the same name and run the same tests: Mergify cannot tell
which one the current run repeats, and it will not guess which tests to skip.
The run then **fails**, showing Mergify's explanation of what it saw — usually
asking you to give each of those runs its own `MERGIFY_TEST_JOB_NAME`.

Otherwise there is nothing to configure: the plugin uses the token and job
identity it already has, and Mergify decides. Every remaining situation — a
normal run, a rerun Mergify has no previous results for, an unreachable API, an
answer from a newer Mergify this plugin does not understand — runs the full
suite, so the feature never costs coverage. It is also enabled per organization
on Mergify's side, so it stays inactive until your organization is opted in.

Set `MERGIFY_TEST_SELECTION_DISABLE=true` in your CI to opt out: the plugin
then always runs the full suite and never queries the endpoint. It is scoped
to this feature only — test tracing, flaky detection and quarantine keep
working (unset `MERGIFY_TOKEN` to turn the plugin off entirely).

## Development

### Prerequisites

- Python >= 3.8
- [uv](https://docs.astral.sh/uv/)

### Setup

```bash
uv sync
```

### Running Tests

```bash
uv run poe test
```

### Linting

```bash
uv run poe linters
```

## License

Apache-2.0
