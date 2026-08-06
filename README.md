# mergify-ci-integrations

CI provider / job-context detection for Mergify's test-client integrations — a
shared Rust core and the language bindings that wrap it, in one repo.

## Layout

```
crates/
  mergify-ci-core/     Rust detection core (standalone, crates.io-publishable)
clients/
  pytest-mergify/      pytest plugin: a PyO3 (abi3) binding over the core,
                       built as a maturin mixed project
  ts/                  TypeScript workspace (pnpm): the @mergifyio/vitest and
                       @mergifyio/playwright reporters over a shared
                       @mergifyio/ci-core; CI detection via @mergifyio/ci-native,
                       a napi binding over the core (prebuilt per platform)
```

## Core

`mergify-ci-core` exposes `detect(env, cwd) -> CiContext`, taking the
environment and working directory as explicit arguments (no `std::env`
globals). It detects the CI provider — GitHub Actions, CircleCI, Jenkins, and
the pytest-mergify test suite — with the same rules as `pytest-mergify`'s
`get_ci_provider`.

## Clients

A client bundles the core into its own published package via a Cargo path
dependency; there is no separate binding artifact. `pytest-mergify` compiles
the PyO3 binding into its wheel as `pytest_mergify._mergify_ci`, so users
`pip install pytest-mergify` with no Rust toolchain.

The TypeScript workspace under `clients/ts/` (imported from
[mergify-ci-plugins-ts](https://github.com/Mergifyio/mergify-ci-plugins-ts)
with its git history) is the exception to the bundled model: npm natives ship
as per-platform packages, so `@mergifyio/ci-native` wraps the core behind napi
and `@mergifyio/ci-core` consumes it for CI detection, fail-open — platforms
without a prebuilt binary detect nothing rather than breaking the run. The
API client is still TypeScript (MRGFY-8439). The packages release from this
repo via `ts-v<SemVer>` tags (fixed version across the workspace, two-step
draft-then-publish like pytest-mergify).

## Develop

```
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
maturin build --manifest-path clients/pytest-mergify/Cargo.toml
pnpm -C clients/ts install && pnpm -C clients/ts run build && pnpm -C clients/ts test
```

CI runs the workspace tests, builds + imports the `pytest-mergify` wheel on
Linux, macOS, and Windows, and runs the TS workspace's lint + test matrix
(node 22/24).
