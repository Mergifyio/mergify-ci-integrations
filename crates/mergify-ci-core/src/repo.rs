//! Repository-name logic: URL parsing plus the API-endpoint `owner/repo`.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;

use crate::git;

// `re.match` anchors at the start; these patterns anchor the end with `$` too.
static SSH_URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^git@[\w.-]+:(?P<full_name>[\w.-]+/[\w.-]+)(?:\.git)?/?$").unwrap()
});
static HTTP_URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:https?://[\w.-]+(?::\d+)?/)?(?P<full_name>[\w.-]+/[\w.-]+)/?$").unwrap()
});

/// Port of `get_repository_name_from_url`: SSH first (strips a trailing
/// `.git`), then HTTP(S) — which intentionally does not strip `.git`.
pub(crate) fn from_url(url: &str) -> Option<String> {
    if let Some(caps) = SSH_URL.captures(url) {
        let full = &caps["full_name"];
        return Some(full.strip_suffix(".git").unwrap_or(full).to_owned());
    }
    if let Some(caps) = HTTP_URL.captures(url) {
        return Some(caps["full_name"].to_owned());
    }
    None
}

/// Port of `get_repository_name_from_env_url`: parse the repo from a URL held
/// in `key`, treating an empty value as absent.
pub(crate) fn from_env_url(env: &BTreeMap<String, String>, key: &str) -> Option<String> {
    let url = env.get(key).filter(|u| !u.is_empty())?;
    from_url(url)
}

/// The endpoint `owner/repo` from the checkout's origin remote — the fallback
/// `get_repository_name` uses when no provider is detected. Per-provider
/// endpoints live on each `CiProvider::endpoint_name`.
pub(crate) fn from_git_remote(cwd: &Path) -> Option<String> {
    from_url(&git::remote_url(cwd)?)
}
