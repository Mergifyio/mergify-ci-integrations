# rspec-mergify

RSpec plugin for [Mergify Test Insights](https://docs.mergify.com/ci-insights/).

## Features

- **Test tracing** — Sends OpenTelemetry traces for every test to Mergify's API
- **Flaky test detection** — Intelligently reruns tests to detect flakiness with budget constraints
- **Test quarantine** — Quarantines failing tests so they don't block CI

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
