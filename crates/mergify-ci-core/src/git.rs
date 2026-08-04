//! `git` subprocess helper and the git-based attribute fallback layer.

use std::path::Path;
use std::process::{Command, Stdio};

use crate::context::CiContext;
use crate::repo;

/// Port of `git()`: run git in `cwd`, returning trimmed stdout, or `None` if
/// git is missing, exits non-zero, or prints nothing.
pub(crate) fn run(cwd: &Path, args: &[&str]) -> Option<String> {
    run_program("git", cwd, args)
}

/// `run` with an explicit program name, so tests can exercise the
/// missing-binary path (a bogus program) without mutating the process `PATH`.
fn run_program(program: &str, cwd: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new(program)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_binary_degrades_to_none() {
        // The no-`git`-on-PATH case (distroless/slim images): a missing binary
        // degrades to `None` rather than panicking.
        assert!(run_program("mergify-not-a-real-binary", Path::new("."), &["--version"]).is_none());
    }

    #[test]
    fn nonzero_exit_is_none() {
        // git present but the invocation fails (here, an unknown subcommand):
        // `None`, same as an absent binary, so callers degrade uniformly.
        assert!(run(Path::new("."), &["not-a-real-subcommand"]).is_none());
    }
}
