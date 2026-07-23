//! CI providers.
//!
//! Everything provider-specific — how it is detected, its endpoint repository
//! name, and how it fills attributes — lives behind a single [`CiProvider`]
//! trait, and [`REGISTRY`] is the one ordered list the engine drives off of.
//! Adding a provider is one module plus one entry in `REGISTRY`; the OTel
//! mapping never changes, since it reads typed fields, not per-provider tables.

mod buildkite;
mod circleci;
mod github_actions;
mod jenkins;
mod pytest_suite;

use std::collections::BTreeMap;
use std::path::Path;

use crate::context::{CiContext, Provider};

/// A CI provider: detection, endpoint repository name, and attribute filling.
pub(crate) trait CiProvider: Sync {
    /// Typed identity, emitted as the provider and `cicd.provider.name`.
    fn provider(&self) -> Provider;

    /// Env var whose truthy presence activates this provider. Precedence when
    /// several match follows `REGISTRY` order.
    fn detect_var(&self) -> &'static str;

    /// The API-endpoint `owner/repo` (`get_repository_name`) for this provider.
    fn endpoint_name(&self, env: &BTreeMap<String, String>) -> Option<String>;

    /// Fill typed attribute fields from the environment. Defaults to nothing —
    /// providers whose attributes the git layer already covers (e.g. CircleCI)
    /// need no override.
    fn extract(&self, _env: &BTreeMap<String, String>, _cwd: &Path, _ctx: &mut CiContext) {}
}

/// Every supported provider, in detection-precedence order. Single source of
/// truth: the detection loop and endpoint lookup both iterate this.
pub(crate) static REGISTRY: &[&dyn CiProvider] = &[
    &github_actions::GithubActions,
    &circleci::CircleCi,
    &jenkins::Jenkins,
    &buildkite::Buildkite,
    &pytest_suite::PytestSuite,
];
