//! Shared CI provider / job-context detection core.
//!
//! [`detect`] takes the environment and working directory as explicit
//! parameters (never `std::env` globals) so bindings and parity tests can
//! inject fixtures deterministically. Behaviour mirrors `pytest-mergify`'s
//! `pytest_mergify/utils.py` and its OTel resource detectors for parity.
//!
//! Two layers: [`detect`] produces a typed, OTel-agnostic [`CiContext`];
//! [`otel_attributes`] maps that to OpenTelemetry resource attributes.

mod context;
mod git;
mod otel;
mod providers;
mod repo;

use std::collections::BTreeMap;
use std::path::Path;

use providers::CiProvider;

pub use context::{AttrValue, CiContext, Pipeline, Provider, Refs, Repository};
pub use otel::{CiResourceAttributes, attributes as otel_attributes};

/// Detect CI context from an explicit environment map and working directory.
#[must_use]
pub fn detect(env: &BTreeMap<String, String>, cwd: &Path) -> CiContext {
    let active = active_provider(env);
    let mut ctx = CiContext {
        provider: active.map(CiProvider::provider),
        repository_name: match active {
            Some(p) => p.endpoint_name(env),
            None => repo::from_git_remote(cwd),
        },
        test_job_name: env.get("MERGIFY_TEST_JOB_NAME").cloned(),
        ..CiContext::default()
    };

    if let Some(p) = active {
        p.extract(env, cwd, &mut ctx);
        // Git layer fills whatever the provider didn't supply.
        git::fill(&mut ctx, cwd);
    }

    ctx
}

/// Port of `get_ci_provider`: the first provider in [`providers::REGISTRY`]
/// whose detection var is present and truthy. A present-but-falsy var is
/// skipped, not a match.
fn active_provider(env: &BTreeMap<String, String>) -> Option<&'static dyn CiProvider> {
    providers::REGISTRY
        .iter()
        .copied()
        .find(|p| env.get(p.detect_var()).is_some_and(|v| is_truthy(v)))
}

/// Port of `strtobool` plus `utils.py`'s fallback: recognised booleans map as
/// expected; any other value counts as truthy iff it is non-empty after
/// trimming (Python's `bool(value.strip())` on `strtobool`'s `ValueError`).
fn is_truthy(value: &str) -> bool {
    match value.to_ascii_lowercase().as_str() {
        "y" | "yes" | "t" | "true" | "on" | "1" => true,
        "n" | "no" | "f" | "false" | "off" | "0" => false,
        _ => !value.trim().is_empty(),
    }
}

#[cfg(test)]
mod tests {
    use std::process::{Command, Stdio};

    use super::*;

    fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    fn attrs_of(ctx: &CiContext) -> BTreeMap<String, AttrValue> {
        otel_attributes(ctx).into_map()
    }

    // --- provider detection ---

    #[test]
    fn detects_each_provider_and_skips_falsy() {
        let detected =
            |pairs: &[(&str, &str)]| active_provider(&env(pairs)).map(CiProvider::provider);
        assert_eq!(detected(&[]), None);
        assert_eq!(detected(&[("GITHUB_ACTIONS", "true")]), Some(Provider::GithubActions));
        assert_eq!(detected(&[("CIRCLECI", "1")]), Some(Provider::CircleCi));
        assert_eq!(detected(&[("JENKINS_URL", "https://ci/")]), Some(Provider::Jenkins));
        assert_eq!(detected(&[("BUILDKITE", "true")]), Some(Provider::Buildkite));
        assert_eq!(detected(&[("_PYTEST_MERGIFY_TEST", "yes")]), Some(Provider::PytestSuite));
        assert_eq!(detected(&[("GITHUB_ACTIONS", "false")]), None);
        // First enabled in registry order wins; a falsy earlier one is skipped.
        assert_eq!(
            detected(&[("GITHUB_ACTIONS", "false"), ("CIRCLECI", "true")]),
            Some(Provider::CircleCi),
        );
    }

    // --- endpoint repository name (get_repository_name), via detect ---

    #[test]
    fn endpoint_repository_name_per_provider() {
        let name = |pairs: &[(&str, &str)]| detect(&env(pairs), Path::new(".")).repository_name;
        assert_eq!(
            name(&[("GITHUB_ACTIONS", "true"), ("GITHUB_REPOSITORY", "Mergifyio/x")]).as_deref(),
            Some("Mergifyio/x"),
        );
        assert_eq!(
            name(&[
                ("CIRCLECI", "true"),
                ("CIRCLE_REPOSITORY_URL", "git@github.com:Mergifyio/x.git"),
            ])
            .as_deref(),
            Some("Mergifyio/x"),
        );
        assert_eq!(
            name(&[("_PYTEST_MERGIFY_TEST", "1")]).as_deref(),
            Some("Mergifyio/pytest-mergify"),
        );
    }

    // --- URL parsing quirks ---

    #[test]
    fn url_parsing_quirks() {
        assert_eq!(
            repo::from_url("git@github.com:Mergifyio/example.git").as_deref(),
            Some("Mergifyio/example"),
        );
        assert_eq!(
            repo::from_url("https://github.com:443/Mergifyio/example/").as_deref(),
            Some("Mergifyio/example"),
        );
        // A trailing `.git` is stripped for HTTP(S) too, not only SSH: an
        // HTTPS `git clone` records the suffix, and the API files the run under
        // the bare `owner/repo`.
        assert_eq!(
            repo::from_url("https://github.com/Mergifyio/example.git").as_deref(),
            Some("Mergifyio/example"),
        );
        assert_eq!(repo::from_url("not a url"), None);
    }

    // --- GitHub Actions attributes ---

    fn github_env() -> BTreeMap<String, String> {
        env(&[
            ("GITHUB_ACTIONS", "true"),
            ("GITHUB_WORKFLOW", "CI"),
            ("GITHUB_JOB", "build"),
            ("GITHUB_RUN_ID", "42"),
            ("GITHUB_RUN_ATTEMPT", "1"),
            ("RUNNER_NAME", "runner-1"),
            ("GITHUB_REF_NAME", "main"),
            ("GITHUB_REF_TYPE", "branch"),
            ("GITHUB_REPOSITORY", "Mergifyio/example"),
            ("GITHUB_REPOSITORY_ID", "123"),
            ("GITHUB_SERVER_URL", "https://github.com"),
            ("GITHUB_SHA", "cafe1234"),
        ])
    }

    #[test]
    fn github_actions_attributes() {
        let ctx = detect(&github_env(), Path::new("."));
        let a = attrs_of(&ctx);

        assert_eq!(a["cicd.provider.name"], "github_actions".into());
        assert_eq!(a["vcs.repository.name"], "Mergifyio/example".into());
        assert_eq!(a["vcs.repository.url.full"], "https://github.com/Mergifyio/example".into());
        assert_eq!(a["vcs.repository.id"], AttrValue::Int(123));
        assert_eq!(a["vcs.ref.head.name"], "main".into());
        assert_eq!(a["vcs.ref.head.type"], "branch".into());
        assert_eq!(a["vcs.ref.head.revision"], "cafe1234".into());
        assert_eq!(a["cicd.pipeline.name"], "CI".into());
        assert_eq!(a["cicd.pipeline.task.name"], "build".into());
        assert_eq!(a["cicd.pipeline.run.id"], AttrValue::Int(42));
        assert_eq!(a["cicd.pipeline.run.attempt"], AttrValue::Int(1));
        assert_eq!(a["cicd.pipeline.runner.name"], "runner-1".into());
        // endpoint name matches too
        assert_eq!(ctx.repository_name.as_deref(), Some("Mergifyio/example"));
    }

    // --- Jenkins attributes ---

    #[test]
    fn jenkins_attributes() {
        let e = env(&[
            ("JENKINS_URL", "https://ci.example/"),
            ("JOB_NAME", "my-job"),
            ("BUILD_ID", "57"),
            ("BUILD_URL", "https://ci.example/job/57"),
            ("NODE_NAME", "agent-1"),
            ("GIT_BRANCH", "origin/main"),
            ("GIT_COMMIT", "deadbeef"),
            ("GIT_URL", "git@github.com:Mergifyio/example.git"),
        ]);
        let a = attrs_of(&detect(&e, Path::new(".")));
        assert_eq!(a["cicd.provider.name"], "jenkins".into());
        assert_eq!(a["cicd.pipeline.name"], "my-job".into());
        assert_eq!(a["cicd.pipeline.task.name"], "my-job".into());
        // Jenkins run id is a string, not an int.
        assert_eq!(a["cicd.pipeline.run.id"], "57".into());
        assert_eq!(a["cicd.pipeline.run.url"], "https://ci.example/job/57".into());
        assert_eq!(a["cicd.pipeline.runner.name"], "agent-1".into());
        // `origin/` prefix stripped from the branch.
        assert_eq!(a["vcs.ref.head.name"], "main".into());
        assert_eq!(a["vcs.ref.head.revision"], "deadbeef".into());
        assert_eq!(a["vcs.repository.name"], "Mergifyio/example".into());
    }

    // --- CircleCI attributes ---

    #[test]
    fn circleci_attributes() {
        let e = env(&[
            ("CIRCLECI", "true"),
            ("CIRCLE_JOB", "unit-tests"),
            ("CIRCLE_WORKFLOW_ID", "8f2a1c44-0b6e-4c7a-9d3f-1e5b7a9c2d40"),
            ("CIRCLE_BUILD_URL", "https://circleci.com/gh/Mergifyio/example/42"),
            ("CIRCLE_BRANCH", "main"),
            ("CIRCLE_SHA1", "1860cf377dd5610e256ff52e47cf38816cc04549"),
            ("CIRCLE_REPOSITORY_URL", "https://github.com/Mergifyio/example"),
        ]);
        let a = attrs_of(&detect(&e, Path::new(".")));
        assert_eq!(a["cicd.provider.name"], "circleci".into());
        // No workflow name, so the job name serves as both pipeline and task.
        assert_eq!(a["cicd.pipeline.name"], "unit-tests".into());
        assert_eq!(a["cicd.pipeline.task.name"], "unit-tests".into());
        assert_eq!(a["cicd.pipeline.run.id"], "8f2a1c44-0b6e-4c7a-9d3f-1e5b7a9c2d40".into());
        assert_eq!(
            a["cicd.pipeline.run.url"],
            "https://circleci.com/gh/Mergifyio/example/42".into(),
        );
        // Branch and SHA come from the environment, not the detached-HEAD checkout.
        assert_eq!(a["vcs.ref.head.name"], "main".into());
        assert_eq!(a["vcs.ref.head.revision"], "1860cf377dd5610e256ff52e47cf38816cc04549".into());
        assert_eq!(a["vcs.repository.name"], "Mergifyio/example".into());
        assert_eq!(a["vcs.repository.url.full"], "https://github.com/Mergifyio/example".into());
    }

    // --- Buildkite attributes ---

    #[test]
    fn buildkite_attributes() {
        let e = env(&[
            ("BUILDKITE", "true"),
            ("BUILDKITE_PIPELINE_SLUG", "my-pipe"),
            ("BUILDKITE_LABEL", ":hammer:"),
            ("BUILDKITE_BUILD_ID", "abc-123"),
            ("BUILDKITE_BUILD_URL", "https://bk/builds/1"),
            ("BUILDKITE_RETRY_COUNT", "2"),
            ("BUILDKITE_AGENT_NAME", "agent-x"),
            ("BUILDKITE_BRANCH", "feature"),
            ("BUILDKITE_COMMIT", "cafe"),
            ("BUILDKITE_REPO", "git@github.com:Mergifyio/example.git"),
        ]);
        let a = attrs_of(&detect(&e, Path::new(".")));
        assert_eq!(a["cicd.provider.name"], "buildkite".into());
        assert_eq!(a["cicd.pipeline.name"], "my-pipe".into());
        assert_eq!(a["cicd.pipeline.task.name"], ":hammer:".into());
        assert_eq!(a["cicd.pipeline.run.id"], "abc-123".into());
        // Attempt = retry count + 1.
        assert_eq!(a["cicd.pipeline.run.attempt"], AttrValue::Int(3));
        assert_eq!(a["cicd.pipeline.runner.name"], "agent-x".into());
        assert_eq!(a["vcs.ref.head.name"], "feature".into());
        assert_eq!(a["vcs.ref.head.revision"], "cafe".into());
        assert_eq!(a["vcs.repository.name"], "Mergifyio/example".into());
    }

    #[test]
    fn buildkite_task_falls_back_to_step_key() {
        // Empty cwd (no git repo) so the git layer stays quiet.
        let dir = tempfile::tempdir().unwrap();
        let e = env(&[("BUILDKITE", "true"), ("BUILDKITE_STEP_KEY", "unit")]);
        let a = attrs_of(&detect(&e, dir.path()));
        assert_eq!(a["cicd.pipeline.task.name"], "unit".into());
    }

    // --- Mergify (always-on) attribute ---

    #[test]
    fn mergify_test_job_name_alongside_ci() {
        let mut e = github_env();
        e.insert("MERGIFY_TEST_JOB_NAME".to_owned(), "e2e".to_owned());
        let a = attrs_of(&detect(&e, Path::new(".")));
        assert_eq!(a["cicd.provider.name"], "github_actions".into());
        assert_eq!(a["mergify.test.job.name"], "e2e".into());
    }

    #[test]
    fn mergify_test_job_name_emitted_even_when_not_in_ci() {
        // No CI provider, empty cwd: only the always-on Mergify attribute.
        let dir = tempfile::tempdir().unwrap();
        let a = attrs_of(&detect(&env(&[("MERGIFY_TEST_JOB_NAME", "unit")]), dir.path()));
        assert_eq!(a.get("cicd.provider.name"), None);
        assert_eq!(a["mergify.test.job.name"], "unit".into());
    }

    #[test]
    fn head_ref_prefers_head_ref_over_ref_name() {
        let mut e = github_env();
        e.insert("GITHUB_HEAD_REF".to_owned(), "feature".to_owned());
        e.insert("GITHUB_REF_NAME".to_owned(), "7/merge".to_owned());
        let a = attrs_of(&detect(&e, Path::new(".")));
        assert_eq!(a["vcs.ref.head.name"], "feature".into());
    }

    #[test]
    fn pull_request_head_sha_from_event_file() {
        let dir = tempfile::tempdir().unwrap();
        let event = dir.path().join("event.json");
        std::fs::write(&event, br#"{"pull_request":{"head":{"sha":"prsha99"}}}"#).unwrap();

        let mut e = github_env();
        e.insert("GITHUB_EVENT_NAME".to_owned(), "pull_request".to_owned());
        e.insert(
            "GITHUB_EVENT_PATH".to_owned(),
            event.to_string_lossy().into_owned(),
        );
        let a = attrs_of(&detect(&e, Path::new(".")));
        // PR head sha from the event payload, not GITHUB_SHA.
        assert_eq!(a["vcs.ref.head.revision"], "prsha99".into());
    }

    // --- not in CI: attributes suppressed, endpoint still falls back to git ---

    #[test]
    fn not_in_ci_suppresses_attributes_but_endpoint_uses_git() {
        let dir = tempfile::tempdir().unwrap();
        run_git(dir.path(), &["init"]);
        run_git(
            dir.path(),
            &["remote", "add", "origin", "git@github.com:Mergifyio/from-git.git"],
        );

        let ctx = detect(&env(&[]), dir.path());
        assert_eq!(ctx.provider, None);
        assert!(attrs_of(&ctx).is_empty(), "no attributes when not in CI");
        assert_eq!(ctx.repository_name.as_deref(), Some("Mergifyio/from-git"));
    }

    #[test]
    fn context_round_trips_through_json() {
        let ctx = detect(&github_env(), Path::new("."));
        let json = serde_json::to_string(&ctx).unwrap();
        assert_eq!(serde_json::from_str::<CiContext>(&json).unwrap(), ctx);
    }

    fn run_git(cwd: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} failed");
    }
}
