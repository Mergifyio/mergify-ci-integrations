# rspec-mergify

RSpec plugin for [Mergify CI Insights](https://docs.mergify.com/ci-insights/).

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

## Development

### Prerequisites

- Ruby >= 3.1 (`.ruby-version` pins to 3.4.4 — use [rbenv](https://github.com/rbenv/rbenv) or [mise](https://mise.jdx.dev/) to install it)
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

GPL-3.0-only
