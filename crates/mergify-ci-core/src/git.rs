//! `git` subprocess helper and the git-based attribute fallback layer.

use std::path::Path;
use std::process::{Command, Stdio};

use crate::context::CiContext;
use crate::repo;

/// Port of `git()`: run git in `cwd`, returning trimmed stdout, or `None` if
/// git is missing, exits non-zero, or prints nothing.
pub(crate) fn run(cwd: &Path, args: &[&str]) -> Option<String> {
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

pub(crate) fn remote_url(cwd: &Path) -> Option<String> {
    run(cwd, &["config", "--get", "remote.origin.url"])
}

/// The git `ResourceDetector` layer: fill any refs/repo fields the provider
/// didn't supply from the checkout itself. Runs only when in CI (mirrors
/// pytest-mergify's git detector, which is empty when there is no provider).
pub(crate) fn fill(ctx: &mut CiContext, cwd: &Path) {
    if ctx.refs.head_branch.is_none() {
        ctx.refs.head_branch = run(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]);
    }
    if ctx.refs.head_sha.is_none() {
        ctx.refs.head_sha = run(cwd, &["rev-parse", "HEAD"]);
    }
    if ctx.repository.url.is_none() {
        ctx.repository.url = remote_url(cwd);
    }
    if ctx.repository.name.is_none() {
        ctx.repository.name = ctx.repository.url.as_deref().and_then(repo::from_url);
    }
}
