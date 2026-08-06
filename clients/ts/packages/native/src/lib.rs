//! Node binding over `mergify-ci-core`, packaged as `@mergifyio/ci-native`.
//!
//! One `.node` per platform, published as `@mergifyio/ci-native-<target>`
//! optional dependencies of the loader package. `@mergifyio/ci-core` loads it
//! fail-open: when no prebuilt exists for the platform, detection reports
//! nothing rather than breaking the test run.
//!
//! The API mirrors the `PyO3` binding function-for-function: three calls, each
//! running a fresh detection (environment and cwd are read at call time),
//! returning native JS values built entry-by-entry — no serialization on the
//! boundary.

use std::collections::{BTreeMap, HashMap};

use mergify_ci_core::{AttrValue, CiContext};
use napi::bindgen_prelude::Either;
use napi_derive::napi;

/// Detect from the current process environment and working directory.
fn context() -> CiContext {
    let env: BTreeMap<String, String> = std::env::vars().collect();
    let cwd = std::env::current_dir().unwrap_or_else(|_| ".".into());
    mergify_ci_core::detect(&env, &cwd)
}

/// The detected CI provider, or `null` when not running in a recognized CI.
/// The first provider whose detection variable (`GITHUB_ACTIONS`, `CIRCLECI`,
/// `JENKINS_URL`, `BUILDKITE`) is present *and* truthy wins — a
/// present-but-falsy value like `GITHUB_ACTIONS=false` is skipped, not a
/// match. Returns the stable name emitted as `cicd.provider.name`:
/// `github_actions`, `circleci`, `jenkins`, or `buildkite`. Reads the
/// environment at call time.
#[napi]
#[must_use]
pub fn detect_provider() -> Option<String> {
    context().provider.map(|p| p.as_str().to_owned())
}

/// The API-endpoint `owner/repo` used for CI Insights calls, or `null` when
/// undeterminable. Resolved from the active provider's environment first —
/// `GITHUB_REPOSITORY` on GitHub Actions, parsed from `CIRCLE_REPOSITORY_URL`
/// on CircleCI, `GIT_URL` on Jenkins, `BUILDKITE_REPO` on Buildkite — falling
/// back to parsing the working directory's `origin` git remote when no
/// provider is active. Can legitimately differ from the
/// `vcs.repository.name` *attribute* (e.g. on CircleCI the endpoint comes
/// from the env URL while the attribute may come from the git remote).
#[napi]
#[must_use]
pub fn detect_repository_name() -> Option<String> {
    context().repository_name
}

/// The OTel resource attributes for this run, as a dotted-key map (`cicd.*`,
/// `vcs.*`, `mergify.test.job.name`) with string or number values — integer
/// attributes like `cicd.pipeline.run.id` (GitHub) and
/// `cicd.pipeline.run.attempt` arrive as JS numbers. Provider-scoped
/// attributes are suppressed outside CI; `mergify.test.job.name` is always-on
/// when `MERGIFY_TEST_JOB_NAME` is set. When in CI, the provider's
/// environment is read first and the git CLI fills whatever it didn't supply
/// (head branch/revision, remote URL). Same shape as Rust's
/// `CiResourceAttributes` and Python's `detect_attributes()` dict; the
/// semconv keys flow through untouched, so `otel.rs` stays their single
/// source of truth.
#[napi]
#[must_use]
pub fn detect_attributes() -> HashMap<String, Either<i64, String>> {
    mergify_ci_core::otel_attributes(&context())
        .into_map()
        .into_iter()
        .map(|(key, value)| {
            let value = match value {
                AttrValue::Int(i) => Either::A(i),
                AttrValue::Str(s) => Either::B(s),
            };
            (key, value)
        })
        .collect()
}
