# rspec-mergify

RSpec plugin for [Mergify Test Insights](https://docs.mergify.com/ci-insights/).

## Features

- **Test tracing** — Sends OpenTelemetry traces for every test to Mergify's API
- **Flaky test detection** — Intelligently reruns tests to detect flakiness with budget constraints
- **Test quarantine** — Quarantines failing tests so they don't block CI
- **Test selection** — Runs only the previously-failing examples when Mergify's merge queue reruns a job

## Installation

Add to your Gemfile:

```ruby
gem 'rspec-mergify'
```

Then run `bundle install`.

### Supported platforms

The gem ships precompiled, so nothing is built on your machine. Each platform gem carries an extension for Ruby 3.1 through 4.0:

| Platform | Requirement |
|---|---|
| Linux x86_64 / aarch64 (glibc) | **glibc 2.30 or newer** — Debian 11+, Ubuntu 20.04+, RHEL 9+, Amazon Linux 2023 |
| Linux x86_64 / aarch64 (musl) | Alpine; on Ruby 3.1 also `apk add libgcc` |
| macOS arm64 / x86_64 | — |
| Windows x64 (UCRT) | — |

Anywhere else, and on glibc older than 2.30 — RHEL, Rocky, AlmaLinux and Oracle Linux 8, Amazon Linux 2, CentOS 7 — the extension cannot load. The gem still installs and your suite still runs, but nothing is reported to Mergify. Pin the last pure-Ruby release on those systems:

```ruby
gem 'rspec-mergify', '0.1.4'
```

## Configuration

Set the `MERGIFY_TOKEN` environment variable with your Mergify API token.

The plugin activates automatically when running in CI (detected via the `CI` environment variable). To enable outside CI, set `RSPEC_MERGIFY_ENABLE=true`.

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `MERGIFY_TOKEN` | Mergify API authentication token | (required) |
| `MERGIFY_API_URL` | Mergify API endpoint | `https://api.mergify.com` |
| `RSPEC_MERGIFY_ENABLE` | Force-enable outside CI | `false` |
| `RSPEC_MERGIFY_DEBUG` | Print spans to console | `false` |
| `MERGIFY_TRACEPARENT` | W3C distributed trace context | — |
| `MERGIFY_TEST_JOB_NAME` | Mergify test job name | — |
| `MERGIFY_TEST_SELECTION_ENABLE` | Opt this job into test selection (see below) | `false` |

### Test selection

When Mergify's merge queue reruns a job — a retry, or a step of a batch
bisection — only the examples that failed on the previous attempt are
informative. The gem asks Mergify whether the current run is such a rerun and,
if so, runs only those examples.

**This is off until you turn it on, per job.** Set
`MERGIFY_TEST_SELECTION_ENABLE=true` on the job you want reduced. Installing the
gem is not enough — a feature that decides not to run tests starts only where
you wrote that it should. Anything that is not a recognised yes (unset, empty,
`false`, unparsable) means no, and a job that has not opted in never asks.

Once opted in, it only ever removes work:

- the answer is applied **after** RSpec's own filters — file and line
  arguments, `--tag`, `-e`, `--only-failures` all still narrow the run, never
  widen it;
- examples are matched by their id (`./spec/models/user_spec.rb[1:2]`), the
  identity RSpec itself reruns failures by;
- if Mergify says the previous attempt already ran every one of these examples
  and they passed, the run executes none and exits green;
- if any example Mergify asks for is not collected here, the full suite runs;
- any error, timeout, or unrecognised answer runs the full suite;
- if Mergify refuses to pick a previous attempt (several runs of this job
  report under one name), the run **fails** with Mergify's explanation: give
  each run its own `MERGIFY_TEST_JOB_NAME`;
- at the end of the run the gem sends Mergify what it concluded (the counts
  and the failing examples) — unless the run failed outside any example (a
  failing `after(:context)` or suite hook), in which case a retry runs the
  full suite.

Each parallel_tests worker, and each CI job handed a slice of the spec files,
is matched to the same slice of the previous attempt, by the examples it
collects. This needs the slices to be the same on both attempts, which is the
case for a split by file size or by a committed runtime log; Knapsack Pro's
Queue Mode hands files out dynamically and is not supported.

### Parallel runs

[parallel_tests](https://github.com/grosser/parallel_tests) and [turbo_tests](https://github.com/serpapi/turbo_tests) need no setup. Each worker is a separate RSpec process, and each reports to Mergify as its own session:

- flaky detection sizes each worker's rerun budget from the tests that worker runs;
- each worker prints its own Mergify report, so a report covers only that worker's tests.

Suites split across CI jobs (knapsack, `circleci tests split`, Buildkite `parallelism`) behave the same way, one session per job.

For detailed documentation, see the [official guide](https://docs.mergify.com/ci-insights/test-frameworks/rspec/).

## Development

### Prerequisites

- Ruby >= 3.1 (`.ruby-version` pins to 4.0.6 — use [rbenv](https://github.com/rbenv/rbenv) or [mise](https://mise.jdx.dev/) to install it)
- Bundler

### Setup

```bash
rbenv install          # install the Ruby version from .ruby-version (if needed)
bundle install
```

### Running Tests

```bash
bundle exec rspec
```

### Linting

```bash
bundle exec rubocop
```

## License

Apache-2.0 — see the [LICENSE](../../LICENSE) at the repository root.
