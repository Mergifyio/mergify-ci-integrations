# @mergifyio/ci-core

Internal shared core for Mergify's test-framework reporters.

This package is not intended for direct consumption. It is consumed by the
published framework reporters:

- [`@mergifyio/vitest`](../vitest) — Vitest reporter.
- [`@mergifyio/playwright`](../playwright) — Playwright reporter.

It provides reporter-agnostic helpers for OpenTelemetry span emission, the
quarantine and flaky-detection lifecycles, and the shared `TestCaseResult` /
`TestRunSession` types.

CI detection and every backend call — quarantine, flaky-detection context, and
the OTLP trace upload — run in Rust, through the
[`@mergifyio/ci-native`](../native) binding, so they are shared with
`pytest-mergify` rather than reimplemented per language.

API stability is **not** guaranteed across minor versions — breaking changes
land without deprecation cycles. Pin the consuming package (`@mergifyio/vitest`
or `@mergifyio/playwright`) instead.
