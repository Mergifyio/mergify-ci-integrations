//! Typed request configuration for the Mergify backend API.

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
}
