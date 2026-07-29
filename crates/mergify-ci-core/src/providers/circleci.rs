//! CircleCI attribute extractor.
//!
//! CircleCI checks out a detached HEAD, so the git layer would report `HEAD`
//! for the branch and cannot recover the pipeline coordinates at all. Every
//! attribute therefore comes from the `CIRCLE_*` environment instead.

use std::collections::BTreeMap;
use std::path::Path;

use super::CiProvider;
use crate::context::{AttrValue, CiContext, Provider};
use crate::repo;

pub(super) struct CircleCi;

impl CiProvider for CircleCi {
    fn provider(&self) -> Provider {
        Provider::CircleCi
    }

    fn detect_var(&self) -> &'static str {
        "CIRCLECI"
    }

    fn endpoint_name(&self, env: &BTreeMap<String, String>) -> Option<String> {
        repo::from_env_url(env, "CIRCLE_REPOSITORY_URL")
    }

    fn extract(&self, env: &BTreeMap<String, String>, _cwd: &Path, ctx: &mut CiContext) {
        let string = |key: &str| env.get(key).cloned();

        // CircleCI publishes no workflow name: `CIRCLE_WORKFLOW_ID` is a per-run
        // UUID that cannot identify the same pipeline across runs, so the job
        // name stands in for both pipeline and task (as Jenkins does with
        // `JOB_NAME`) -- job names are unique within a project's config.
        ctx.pipeline.name = string("CIRCLE_JOB");
        ctx.pipeline.task = string("CIRCLE_JOB");
        ctx.pipeline.run_id = string("CIRCLE_WORKFLOW_ID").map(AttrValue::Str);
        ctx.pipeline.run_url = string("CIRCLE_BUILD_URL");

        // No base branch is published, so a pull request run is not
        // distinguishable from a branch run here -- flaky detection reads that
        // absence as a push run and stays in `unhealthy` mode.
        ctx.refs.head_branch = string("CIRCLE_BRANCH");
        ctx.refs.head_sha = string("CIRCLE_SHA1");

        ctx.repository.url = string("CIRCLE_REPOSITORY_URL");
        ctx.repository.name = repo::from_env_url(env, "CIRCLE_REPOSITORY_URL");
    }
}
