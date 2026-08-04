# @mergifyio/ci-core

Internal shared core for Mergify's test-framework reporters.

This package is not intended for direct consumption. It is consumed by the
published framework reporters:

- [`@mergifyio/vitest`](../vitest) — Vitest reporter.
- [`@mergifyio/playwright`](../playwright) — Playwright reporter.

It provides reporter-agnostic helpers for OpenTelemetry span emission, CI
provider / repository / Git resource detection, quarantine and flaky-detection
API clients, and the shared `TestCaseResult` / `TestRunSession` types.

API stability is **not** guaranteed across minor versions — breaking changes
land without deprecation cycles. Pin the consuming package (`@mergifyio/vitest`
or `@mergifyio/playwright`) instead.
