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

## Develop

```
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
maturin build --manifest-path clients/pytest-mergify/Cargo.toml
```

CI runs the workspace tests and builds + imports the `pytest-mergify` wheel on
Linux, macOS, and Windows.
