//! Buildkite attribute extractor.

use std::collections::BTreeMap;
use std::path::Path;

use super::CiProvider;
use crate::context::{AttrValue, CiContext, Provider};
use crate::repo;

pub(super) struct Buildkite;

impl CiProvider for Buildkite {
    fn provider(&self) -> Provider {
        Provider::Buildkite
    }

    fn detect_var(&self) -> &'static str {
        "BUILDKITE"
    }

    fn endpoint_name(&self, env: &BTreeMap<String, String>) -> Option<String> {
        repo::from_env_url(env, "BUILDKITE_REPO")
    }

    fn extract(&self, env: &BTreeMap<String, String>, _cwd: &Path, ctx: &mut CiContext) {
        let string = |key: &str| env.get(key).cloned();

        ctx.pipeline.name = string("BUILDKITE_PIPELINE_SLUG");
        ctx.pipeline.task = string("BUILDKITE_LABEL")
            .filter(|v| !v.is_empty())
            .or_else(|| string("BUILDKITE_STEP_KEY"));
        ctx.pipeline.run_id = string("BUILDKITE_BUILD_ID").map(AttrValue::Str);
        ctx.pipeline.run_url = string("BUILDKITE_BUILD_URL");
        // Attempt is always present: retry count (0 when unset) plus one.
        ctx.pipeline.attempt = Some(retry_count(env) + 1);
        ctx.pipeline.runner = string("BUILDKITE_AGENT_NAME");

        ctx.refs.head_branch = string("BUILDKITE_BRANCH");
        ctx.refs.base_branch = string("BUILDKITE_PULL_REQUEST_BASE_BRANCH");
        ctx.refs.head_sha = string("BUILDKITE_COMMIT");

        ctx.repository.url = string("BUILDKITE_REPO");
        ctx.repository.name = repo::from_env_url(env, "BUILDKITE_REPO");
    }
}

/// `BUILDKITE_RETRY_COUNT` as an integer, defaulting to 0 when unset or unparseable.
fn retry_count(env: &BTreeMap<String, String>) -> i64 {
    env.get("BUILDKITE_RETRY_COUNT")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0)
}
