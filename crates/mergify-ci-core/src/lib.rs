//! Shared CI provider / job-context detection core.
//!
//! [`detect`] takes the environment and working directory as explicit
//! parameters (never `std::env` globals) so bindings and parity tests can
//! inject fixtures deterministically. Behaviour mirrors `pytest-mergify`'s
//! `pytest_mergify/utils.py` so every client stays byte-for-byte in parity.

use std::collections::BTreeMap;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

/// CI providers we detect, checked in this order. Mirrors `SUPPORTED_CIs` in
/// `pytest_mergify/utils.py` — order matters, the first *enabled* one wins.
const SUPPORTED_CIS: &[(&str, &str)] = &[
    ("GITHUB_ACTIONS", "github_actions"),
    ("CIRCLECI", "circleci"),
    ("JENKINS_URL", "jenkins"),
    ("_PYTEST_MERGIFY_TEST", "pytest_mergify_suite"),
];

// `re.match` anchors at the start; these patterns anchor the end with `$` too.
static SSH_URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^git@[\w.-]+:(?P<full_name>[\w.-]+/[\w.-]+)(?:\.git)?/?$").unwrap()
});
static HTTP_URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:https?://[\w.-]+(?::\d+)?/)?(?P<full_name>[\w.-]+/[\w.-]+)/?$").unwrap()
});

/// Canonical, serde-serializable detection contract.
///
/// The single struct every binding maps to native objects, and the one a
/// future `mergify ci detect --json` sidecar will emit. New fields land here,
/// once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CiContext {
    /// Detected CI provider (e.g. `"github_actions"`), or `None` when not in CI.
    pub provider: Option<String>,
    /// `owner/repo` for the build, or `None` when it can't be determined.
    pub repository_name: Option<String>,
}

/// Detect CI context from an explicit environment map and working directory.
#[must_use]
pub fn detect(env: &BTreeMap<String, String>, cwd: &Path) -> CiContext {
    let provider = ci_provider(env);
    CiContext {
        provider: provider.map(str::to_owned),
        repository_name: repository_name(provider, env, cwd),
    }
}

/// Port of `get_ci_provider`: return the first provider whose env var is
/// present and truthy. A present-but-falsy var is skipped, not a match.
fn ci_provider(env: &BTreeMap<String, String>) -> Option<&'static str> {
    for (var, name) in SUPPORTED_CIS {
        if let Some(value) = env.get(*var)
            && is_truthy(value)
        {
            return Some(name);
        }
    }
    None
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

/// Port of `get_repository_name`: a per-provider lookup, falling back to the
/// checkout's `origin` remote when the provider is unknown or absent.
///
/// Note the asymmetry, kept for parity: `github_actions` returns
/// `GITHUB_REPOSITORY` raw (even if empty), whereas the URL-based providers
/// treat an empty value as "not set".
fn repository_name(
    provider: Option<&str>,
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> Option<String> {
    match provider {
        Some("github_actions") => env.get("GITHUB_REPOSITORY").cloned(),
        Some("circleci") => repo_name_from_env_url(env, "CIRCLE_REPOSITORY_URL"),
        Some("jenkins") => repo_name_from_env_url(env, "GIT_URL"),
        Some("pytest_mergify_suite") => Some("Mergifyio/pytest-mergify".to_owned()),
        _ => repo_name_from_url(&git(cwd, &["config", "--get", "remote.origin.url"])?),
    }
}

/// Port of `get_repository_name_from_env_url`: parse the repo out of a URL held
/// in `key`, treating an empty value as absent (Python's `if repository_url:`).
fn repo_name_from_env_url(env: &BTreeMap<String, String>, key: &str) -> Option<String> {
    let url = env.get(key).filter(|u| !u.is_empty())?;
    repo_name_from_url(url)
}

/// Port of `get_repository_name_from_url`: try the SSH form first, then
/// HTTP(S). Only the SSH branch strips a trailing `.git` (a parity quirk —
/// the HTTP branch intentionally does not).
fn repo_name_from_url(url: &str) -> Option<String> {
    if let Some(caps) = SSH_URL.captures(url) {
        let full = &caps["full_name"];
        return Some(full.strip_suffix(".git").unwrap_or(full).to_owned());
    }
    if let Some(caps) = HTTP_URL.captures(url) {
        return Some(caps["full_name"].to_owned());
    }
    None
}

/// Port of `git()`: run git in `cwd`, returning trimmed stdout, or `None` if
/// git is missing, exits non-zero, or prints nothing.
fn git(cwd: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    // --- provider detection (get_ci_provider) ---

    #[test]
    fn no_ci_is_none() {
        assert_eq!(ci_provider(&env(&[])), None);
    }

    #[test]
    fn each_provider_when_truthy() {
        assert_eq!(
            ci_provider(&env(&[("GITHUB_ACTIONS", "true")])),
            Some("github_actions"),
        );
        assert_eq!(ci_provider(&env(&[("CIRCLECI", "1")])), Some("circleci"));
        // JENKINS_URL is a URL, not a boolean: truthy via the non-empty fallback.
        assert_eq!(
            ci_provider(&env(&[("JENKINS_URL", "https://ci.example/")])),
            Some("jenkins"),
        );
        assert_eq!(
            ci_provider(&env(&[("_PYTEST_MERGIFY_TEST", "yes")])),
            Some("pytest_mergify_suite"),
        );
    }

    #[test]
    fn present_but_falsy_is_skipped() {
        assert_eq!(ci_provider(&env(&[("GITHUB_ACTIONS", "false")])), None);
        assert_eq!(ci_provider(&env(&[("GITHUB_ACTIONS", "0")])), None);
        assert_eq!(ci_provider(&env(&[("GITHUB_ACTIONS", "")])), None);
        assert_eq!(ci_provider(&env(&[("GITHUB_ACTIONS", "   ")])), None);
    }

    #[test]
    fn first_enabled_in_table_order_wins() {
        assert_eq!(
            ci_provider(&env(&[("GITHUB_ACTIONS", "true"), ("CIRCLECI", "true")])),
            Some("github_actions"),
        );
        // Falsy github_actions is skipped; circleci then wins.
        assert_eq!(
            ci_provider(&env(&[("GITHUB_ACTIONS", "false"), ("CIRCLECI", "true")])),
            Some("circleci"),
        );
    }

    // --- URL parsing (get_repository_name_from_url) ---

    #[test]
    fn ssh_url_strips_trailing_dot_git() {
        assert_eq!(
            repo_name_from_url("git@github.com:Mergifyio/example.git").as_deref(),
            Some("Mergifyio/example"),
        );
        assert_eq!(
            repo_name_from_url("git@github.com:Mergifyio/example").as_deref(),
            Some("Mergifyio/example"),
        );
    }

    #[test]
    fn https_url_shapes() {
        assert_eq!(
            repo_name_from_url("https://github.com/Mergifyio/example").as_deref(),
            Some("Mergifyio/example"),
        );
        assert_eq!(
            repo_name_from_url("https://github.com:443/Mergifyio/example/").as_deref(),
            Some("Mergifyio/example"),
        );
        // Scheme-less "owner/repo" is accepted by the HTTP branch.
        assert_eq!(
            repo_name_from_url("Mergifyio/example").as_deref(),
            Some("Mergifyio/example"),
        );
        // HTTP does NOT strip .git (parity quirk).
        assert_eq!(
            repo_name_from_url("https://github.com/Mergifyio/example.git").as_deref(),
            Some("Mergifyio/example.git"),
        );
    }

    #[test]
    fn unparseable_url_is_none() {
        assert_eq!(repo_name_from_url("not a url"), None);
        assert_eq!(repo_name_from_url("https://github.com/onlyowner"), None);
        assert_eq!(repo_name_from_url(""), None);
    }

    // --- repository name per provider (get_repository_name) ---

    #[test]
    fn repo_name_github_actions_is_raw_env() {
        let e = env(&[("GITHUB_REPOSITORY", "Mergifyio/example")]);
        assert_eq!(
            repository_name(Some("github_actions"), &e, Path::new(".")).as_deref(),
            Some("Mergifyio/example"),
        );
    }

    #[test]
    fn repo_name_circleci_and_jenkins_parse_urls() {
        let circle = env(&[("CIRCLE_REPOSITORY_URL", "git@github.com:Mergifyio/example.git")]);
        assert_eq!(
            repository_name(Some("circleci"), &circle, Path::new(".")).as_deref(),
            Some("Mergifyio/example"),
        );
        let jenkins = env(&[("GIT_URL", "https://github.com/Mergifyio/example")]);
        assert_eq!(
            repository_name(Some("jenkins"), &jenkins, Path::new(".")).as_deref(),
            Some("Mergifyio/example"),
        );
    }

    #[test]
    fn repo_name_pytest_suite_is_constant() {
        assert_eq!(
            repository_name(Some("pytest_mergify_suite"), &env(&[]), Path::new(".")).as_deref(),
            Some("Mergifyio/pytest-mergify"),
        );
    }

    // --- git fallback (get_repository_name's `git config` path) ---

    #[test]
    fn repo_name_falls_back_to_git_origin() {
        let dir = tempfile::tempdir().unwrap();
        run_git(dir.path(), &["init"]);
        run_git(
            dir.path(),
            &["remote", "add", "origin", "git@github.com:Mergifyio/from-git.git"],
        );
        // Empty env -> provider None -> git fallback in the given cwd.
        let ctx = detect(&env(&[]), dir.path());
        assert_eq!(ctx.provider, None);
        assert_eq!(ctx.repository_name.as_deref(), Some("Mergifyio/from-git"));
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

    // --- serialization ---

    #[test]
    fn context_round_trips_through_json() {
        let ctx = CiContext {
            provider: Some("github_actions".to_owned()),
            repository_name: Some("Mergifyio/example".to_owned()),
        };
        let json = serde_json::to_string(&ctx).unwrap();
        assert_eq!(serde_json::from_str::<CiContext>(&json).unwrap(), ctx);
    }
}
