//! Shared CI provider / job-context detection core.
//!
//! [`detect`] takes the environment and working directory as explicit
//! parameters (never `std::env` globals) so bindings and parity tests can
//! inject fixtures deterministically. Behaviour mirrors `pytest-mergify`'s
//! `pytest_mergify/utils.py` so every client stays byte-for-byte in parity.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// CI providers we detect, checked in this order. Mirrors `SUPPORTED_CIs` in
/// `pytest_mergify/utils.py` — order matters, the first *enabled* one wins.
const SUPPORTED_CIS: &[(&str, &str)] = &[
    ("GITHUB_ACTIONS", "github_actions"),
    ("CIRCLECI", "circleci"),
    ("JENKINS_URL", "jenkins"),
    ("_PYTEST_MERGIFY_TEST", "pytest_mergify_suite"),
];

/// Canonical, serde-serializable detection contract.
///
/// The single struct every binding maps to native objects, and the one a
/// future `mergify ci detect --json` sidecar will emit. New fields land here,
/// once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CiContext {
    /// Detected CI provider (e.g. `"github_actions"`), or `None` when not in CI.
    pub provider: Option<String>,
}

/// Detect CI context from an explicit environment map and working directory.
#[must_use]
pub fn detect(env: &BTreeMap<String, String>, _cwd: &Path) -> CiContext {
    CiContext {
        provider: ci_provider(env).map(str::to_owned),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(pairs: &[(&str, &str)]) -> Option<String> {
        let env: BTreeMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        detect(&env, Path::new(".")).provider
    }

    #[test]
    fn no_ci_is_none() {
        assert_eq!(provider(&[]), None);
    }

    #[test]
    fn github_actions_when_truthy() {
        assert_eq!(
            provider(&[("GITHUB_ACTIONS", "true")]).as_deref(),
            Some("github_actions"),
        );
    }

    #[test]
    fn circleci_and_jenkins() {
        assert_eq!(provider(&[("CIRCLECI", "1")]).as_deref(), Some("circleci"));
        // JENKINS_URL holds a URL, not a boolean: truthy via the non-empty fallback.
        assert_eq!(
            provider(&[("JENKINS_URL", "https://ci.example/")]).as_deref(),
            Some("jenkins"),
        );
    }

    #[test]
    fn pytest_suite_pseudo_provider() {
        assert_eq!(
            provider(&[("_PYTEST_MERGIFY_TEST", "yes")]).as_deref(),
            Some("pytest_mergify_suite"),
        );
    }

    #[test]
    fn present_but_falsy_is_skipped() {
        assert_eq!(provider(&[("GITHUB_ACTIONS", "false")]), None);
        assert_eq!(provider(&[("GITHUB_ACTIONS", "0")]), None);
        assert_eq!(provider(&[("GITHUB_ACTIONS", "")]), None);
        assert_eq!(provider(&[("GITHUB_ACTIONS", "   ")]), None);
    }

    #[test]
    fn first_enabled_in_table_order_wins() {
        assert_eq!(
            provider(&[("GITHUB_ACTIONS", "true"), ("CIRCLECI", "true")]).as_deref(),
            Some("github_actions"),
        );
        // Falsy github_actions is skipped; circleci then wins.
        assert_eq!(
            provider(&[("GITHUB_ACTIONS", "false"), ("CIRCLECI", "true")]).as_deref(),
            Some("circleci"),
        );
    }

    #[test]
    fn context_round_trips_through_json() {
        let ctx = CiContext {
            provider: Some("github_actions".to_owned()),
        };
        let json = serde_json::to_string(&ctx).unwrap();
        assert_eq!(serde_json::from_str::<CiContext>(&json).unwrap(), ctx);
    }
}
