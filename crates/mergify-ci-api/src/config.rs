//! Typed request configuration for the Mergify backend API.

use std::fmt;

/// Default API base URL, used when `MERGIFY_API_URL` is unset.
pub const DEFAULT_API_URL: &str = "https://api.mergify.com";

/// Everything the client needs to address a repository.
///
/// `owner` and `repo` are kept as separate segments because the endpoints
/// interpolate them individually (`…/{owner}/repositories/{repo}/…`), not as a
/// single `owner/repo` component.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiConfig {
    /// API base URL (`MERGIFY_API_URL`, default [`DEFAULT_API_URL`]).
    pub api_url: String,
    /// Bearer token (`MERGIFY_TOKEN`).
    pub token: String,
    /// Repository owner — the first path segment.
    pub owner: String,
    /// Repository name — the second path segment.
    pub repo: String,
}

impl ApiConfig {
    /// Build a config from an explicit `owner` / `repo`.
    #[must_use]
    pub fn new(
        api_url: impl Into<String>,
        token: impl Into<String>,
        owner: impl Into<String>,
        repo: impl Into<String>,
    ) -> Self {
        Self {
            api_url: api_url.into(),
            token: token.into(),
            owner: owner.into(),
            repo: repo.into(),
        }
    }

    /// Build a config from a full `owner/repo` name.
    ///
    /// Returns `None` unless the name is exactly two non-empty segments,
    /// mirroring the clients' `split_full_repo_name`.
    #[must_use]
    pub fn from_full_name(
        api_url: impl Into<String>,
        token: impl Into<String>,
        full_name: &str,
    ) -> Option<Self> {
        let (owner, repo) = split_full_name(full_name)?;
        Some(Self::new(api_url, token, owner, repo))
    }
}

/// Who is calling, sent as the `User-Agent` on every request so the backend's
/// access logs can attribute traffic to an integration and a version — how the
/// adoption of these clients is measured.
///
/// The crate version is no use for that: it is a `0.0.0` placeholder, and what
/// users actually install is the *client distribution* (the wheel, gem, or npm
/// package), whose version is stamped at build time. So each binding passes the
/// name and version of the distribution it ships inside.
///
/// Rendered as `{name}/{version} ({runtime}; {os}; {arch})` — e.g.
/// `pytest-mergify/2026.8.5.3 (python/3.12.1; linux; x86_64)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientInfo {
    name: String,
    version: String,
    /// Language runtime, pre-rendered as `python/3.12.1`.
    runtime: Option<String>,
}

impl ClientInfo {
    /// Identify the client distribution by `name` and `version`.
    #[must_use]
    pub fn new(name: &str, version: &str) -> Self {
        Self { name: sanitize(name), version: sanitize(version), runtime: None }
    }

    /// Also report the language runtime the client runs on, e.g.
    /// `("python", "3.12.1")`.
    #[must_use]
    pub fn with_runtime(mut self, name: &str, version: &str) -> Self {
        self.runtime = Some(format!("{}/{}", sanitize(name), sanitize(version)));
        self
    }
}

impl fmt::Display for ClientInfo {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}/{} (", self.name, self.version)?;
        if let Some(runtime) = &self.runtime {
            write!(formatter, "{runtime}; ")?;
        }
        write!(formatter, "{}; {})", std::env::consts::OS, std::env::consts::ARCH)
    }
}

/// Reduce a `User-Agent` component to characters that always make a valid
/// header value.
///
/// The versions come from whatever package manager installed the client, so a
/// surprising one (a local dev version, a distro patch suffix) must never fail
/// the HTTP client build: these integrations degrade, they don't crash the test
/// run they are observing.
fn sanitize(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_' | '+') {
                character
            } else {
                '-'
            }
        })
        .collect();
    if cleaned.is_empty() { "unknown".to_owned() } else { cleaned }
}

/// Split an `owner/repo` string into its two segments, or `None` unless it is
/// exactly two non-empty parts (an empty owner or repo, or a third segment,
/// is rejected).
#[must_use]
pub fn split_full_name(full_name: &str) -> Option<(String, String)> {
    let (owner, repo) = full_name.split_once('/')?;
    if owner.is_empty() || repo.is_empty() || repo.contains('/') {
        return None;
    }
    Some((owner.to_owned(), repo.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_owner_repo() {
        assert_eq!(
            split_full_name("Mergifyio/pytest-mergify"),
            Some(("Mergifyio".to_owned(), "pytest-mergify".to_owned())),
        );
        assert_eq!(split_full_name("nope"), None);
        assert_eq!(split_full_name("a/b/c"), None);
        assert_eq!(split_full_name("owner/"), None);
        assert_eq!(split_full_name("/repo"), None);
    }

    #[test]
    fn from_full_name_builds_config() {
        let cfg = ApiConfig::from_full_name(DEFAULT_API_URL, "tok", "Mergifyio/x").unwrap();
        assert_eq!(cfg.owner, "Mergifyio");
        assert_eq!(cfg.repo, "x");
        assert_eq!(cfg.api_url, "https://api.mergify.com");
        assert_eq!(cfg.token, "tok");
    }

    #[test]
    fn from_full_name_rejects_bad_name() {
        assert_eq!(ApiConfig::from_full_name(DEFAULT_API_URL, "tok", "nope"), None);
    }

    fn platform() -> String {
        format!("{}; {})", std::env::consts::OS, std::env::consts::ARCH)
    }

    #[test]
    fn user_agent_reports_client_runtime_and_platform() {
        let agent = ClientInfo::new("pytest-mergify", "2026.8.5.3")
            .with_runtime("python", "3.12.1")
            .to_string();
        assert_eq!(
            agent,
            format!("pytest-mergify/2026.8.5.3 (python/3.12.1; {}", platform()),
        );
    }

    #[test]
    fn user_agent_omits_an_unset_runtime() {
        let agent = ClientInfo::new("rspec-mergify", "1.2.3").to_string();
        assert_eq!(agent, format!("rspec-mergify/1.2.3 ({}", platform()));
    }

    #[test]
    fn user_agent_components_stay_header_safe() {
        // Whatever the installed version turns out to be, the result is still a
        // valid header value — the client build cannot fail on it.
        let agent = ClientInfo::new("pytest mergify", "1.0.0 (dev)")
            .with_runtime("python", "3.14.0\n")
            .to_string();
        assert_eq!(
            agent,
            format!("pytest-mergify/1.0.0--dev- (python/3.14.0-; {}", platform()),
        );
        assert!(agent.chars().all(|character| character.is_ascii_graphic() || character == ' '));
    }

    #[test]
    fn user_agent_never_leaves_an_empty_component() {
        let agent = ClientInfo::new("", "").to_string();
        assert!(agent.starts_with("unknown/unknown ("), "{agent}");
    }
}
