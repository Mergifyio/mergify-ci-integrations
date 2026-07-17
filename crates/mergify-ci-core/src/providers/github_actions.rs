//! GitHub Actions attribute extractor.

use std::collections::BTreeMap;
use std::path::Path;

use super::CiProvider;
use crate::context::{CiContext, Provider};

pub(super) struct GithubActions;

impl CiProvider for GithubActions {
    fn provider(&self) -> Provider {
        Provider::GithubActions
    }

    fn detect_var(&self) -> &'static str {
        "GITHUB_ACTIONS"
    }

    fn endpoint_name(&self, env: &BTreeMap<String, String>) -> Option<String> {
        env.get("GITHUB_REPOSITORY").cloned()
    }

    fn extract(&self, env: &BTreeMap<String, String>, _cwd: &Path, ctx: &mut CiContext) {
        let string = |key: &str| env.get(key).cloned();
        let int = |key: &str| env.get(key).and_then(|v| v.parse::<i64>().ok());

        ctx.pipeline.name = string("GITHUB_WORKFLOW");
        ctx.pipeline.task = string("GITHUB_JOB");
        ctx.pipeline.run_id = int("GITHUB_RUN_ID").map(Into::into);
        ctx.pipeline.attempt = int("GITHUB_RUN_ATTEMPT");
        ctx.pipeline.runner = string("RUNNER_NAME");

        ctx.refs.head_branch = head_ref_name(env);
        ctx.refs.head_type = string("GITHUB_REF_TYPE");
        ctx.refs.base_branch = string("GITHUB_BASE_REF");
        ctx.refs.head_sha = head_sha(env);

        ctx.repository.name = string("GITHUB_REPOSITORY");
        ctx.repository.id = int("GITHUB_REPOSITORY_ID");
        ctx.repository.url = repository_url(env);
    }
}

/// `GITHUB_HEAD_REF` (set only on PRs) if non-empty, else `GITHUB_REF_NAME`
/// (which is `<pr>/merge` on PRs but the branch name otherwise).
fn head_ref_name(env: &BTreeMap<String, String>) -> Option<String> {
    env.get("GITHUB_HEAD_REF")
        .filter(|v| !v.is_empty())
        .or_else(|| env.get("GITHUB_REF_NAME"))
        .cloned()
}

/// `GITHUB_SERVER_URL` + `/` + `GITHUB_REPOSITORY`, when both are present.
fn repository_url(env: &BTreeMap<String, String>) -> Option<String> {
    let server = env.get("GITHUB_SERVER_URL")?;
    let repository = env.get("GITHUB_REPOSITORY")?;
    Some(format!("{server}/{repository}"))
}

/// The PR head SHA from the event payload on `pull_request` events (the
/// `GITHUB_SHA` there is the merge commit, not the head), else `GITHUB_SHA`.
fn head_sha(env: &BTreeMap<String, String>) -> Option<String> {
    if env.get("GITHUB_EVENT_NAME").map(String::as_str) == Some("pull_request")
        && let Some(path) = env.get("GITHUB_EVENT_PATH")
        && let Some(sha) = pull_request_head_sha(Path::new(path))
    {
        return Some(sha);
    }
    env.get("GITHUB_SHA").cloned()
}

fn pull_request_head_sha(event_path: &Path) -> Option<String> {
    let bytes = std::fs::read(event_path).ok()?;
    let event: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    event
        .get("pull_request")?
        .get("head")?
        .get("sha")?
        .as_str()
        .map(str::to_owned)
}
