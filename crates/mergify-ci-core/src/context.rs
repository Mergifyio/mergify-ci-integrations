//! Typed, OTel-agnostic CI detection contract.
//!
//! This is the canonical output the whole project is built around: bindings
//! map it to native objects, a future `mergify ci detect --json` sidecar serdes
//! it directly, and [`crate::otel_attributes`] maps it to OTel resource
//! attributes. Nothing here knows a semconv string.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// A supported CI provider. String forms match `pytest-mergify`'s `CIProviderT`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Provider {
    #[serde(rename = "github_actions")]
    GithubActions,
    #[serde(rename = "circleci")]
    CircleCi,
    #[serde(rename = "jenkins")]
    Jenkins,
    #[serde(rename = "buildkite")]
    Buildkite,
    #[serde(rename = "pytest_mergify_suite")]
    PytestSuite,
}

impl Provider {
    /// The stable name emitted as `cicd.provider.name` and returned by bindings.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Provider::GithubActions => "github_actions",
            Provider::CircleCi => "circleci",
            Provider::Jenkins => "jenkins",
            Provider::Buildkite => "buildkite",
            Provider::PytestSuite => "pytest_mergify_suite",
        }
    }
}

/// An OTel resource-attribute value: attributes are strings or integers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AttrValue {
    Int(i64),
    Str(String),
}

impl From<&str> for AttrValue {
    fn from(value: &str) -> Self {
        AttrValue::Str(value.to_owned())
    }
}
impl From<String> for AttrValue {
    fn from(value: String) -> Self {
        AttrValue::Str(value)
    }
}
impl From<i64> for AttrValue {
    fn from(value: i64) -> Self {
        AttrValue::Int(value)
    }
}

/// Repository identity (the `vcs.repository.*` attributes).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Repository {
    /// `owner/repo` (`vcs.repository.name`).
    pub name: Option<String>,
    /// Clone/browse URL (`vcs.repository.url.full`).
    pub url: Option<String>,
    /// Numeric repository id (`vcs.repository.id`), when the provider exposes it.
    pub id: Option<i64>,
}

/// Git refs for the build (the `vcs.ref.*` attributes).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Refs {
    /// Head branch (`vcs.ref.head.name`).
    pub head_branch: Option<String>,
    /// Head commit SHA (`vcs.ref.head.revision`).
    pub head_sha: Option<String>,
    /// Head ref type, e.g. `branch`/`tag` (`vcs.ref.head.type`).
    pub head_type: Option<String>,
    /// Base/target branch on PRs (`vcs.ref.base.name`).
    pub base_branch: Option<String>,
}

/// CI pipeline / run context (the `cicd.pipeline.*` attributes).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pipeline {
    /// Pipeline/workflow name (`cicd.pipeline.name`).
    pub name: Option<String>,
    /// Job/task name (`cicd.pipeline.task.name`).
    pub task: Option<String>,
    /// Run id — int on GitHub, string on Jenkins (`cicd.pipeline.run.id`).
    pub run_id: Option<AttrValue>,
    /// Run attempt (`cicd.pipeline.run.attempt`).
    pub attempt: Option<i64>,
    /// Runner/node name (`cicd.pipeline.runner.name`).
    pub runner: Option<String>,
    /// Run URL (`cicd.pipeline.run.url`).
    pub run_url: Option<String>,
}

/// The full detection result.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CiContext {
    /// Detected CI provider, or `None` when not in CI.
    pub provider: Option<Provider>,
    /// API-endpoint `owner/repo` (`get_repository_name`). Distinct from the
    /// `vcs.repository.name` attribute in [`Repository`] — the two can differ
    /// (e.g. CircleCI derives the endpoint from `CIRCLE_REPOSITORY_URL` but the
    /// attribute from the git remote).
    pub repository_name: Option<String>,
    pub repository: Repository,
    pub refs: Refs,
    pub pipeline: Pipeline,
    /// Mergify test job name (`mergify.test.job.name`), from
    /// `MERGIFY_TEST_JOB_NAME`. Emitted regardless of provider — it has no CI
    /// guard in pytest-mergify's Mergify detector.
    pub test_job_name: Option<String>,
    /// Provider-specific attributes with no typed field.
    pub extra: BTreeMap<String, AttrValue>,
}
