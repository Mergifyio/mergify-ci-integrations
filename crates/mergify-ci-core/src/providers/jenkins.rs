//! Jenkins attribute extractor.

use std::collections::BTreeMap;
use std::path::Path;

use super::CiProvider;
use crate::context::{AttrValue, CiContext, Provider};
use crate::repo;

pub(super) struct Jenkins;

impl CiProvider for Jenkins {
    fn provider(&self) -> Provider {
        Provider::Jenkins
    }

    fn detect_var(&self) -> &'static str {
        "JENKINS_URL"
    }

    fn endpoint_name(&self, env: &BTreeMap<String, String>) -> Option<String> {
        repo::from_env_url(env, "GIT_URL")
    }

    fn extract(&self, env: &BTreeMap<String, String>, _cwd: &Path, ctx: &mut CiContext) {
        let string = |key: &str| env.get(key).cloned();

        ctx.pipeline.name = string("JOB_NAME");
        ctx.pipeline.task = string("JOB_NAME");
        ctx.pipeline.run_id = string("BUILD_ID").map(AttrValue::Str);
        ctx.pipeline.run_url = string("BUILD_URL");
        ctx.pipeline.runner = string("NODE_NAME");

        ctx.refs.head_branch = branch(env);
        ctx.refs.head_sha = string("GIT_COMMIT");

        ctx.repository.url = string("GIT_URL");
        ctx.repository.name = repo::from_env_url(env, "GIT_URL");
    }
}

/// `GIT_BRANCH` with a leading `origin/` or `refs/heads/` stripped (Jenkins'
/// Git plugin reports refs like `origin/main`).
fn branch(env: &BTreeMap<String, String>) -> Option<String> {
    let branch = env.get("GIT_BRANCH").filter(|b| !b.is_empty())?;
    for prefix in ["origin/", "refs/heads/"] {
        if let Some(rest) = branch.strip_prefix(prefix) {
            return Some(rest.to_owned());
        }
    }
    Some(branch.clone())
}
