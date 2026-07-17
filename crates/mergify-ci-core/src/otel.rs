//! Maps the typed [`CiContext`] to OpenTelemetry resource attributes.
//!
//! This is the *only* module that knows semconv attribute keys — the typed
//! core and the JSON sidecar stay OTel-agnostic.

use std::collections::BTreeMap;

use crate::context::{AttrValue, CiContext};

/// Build the OTel resource attributes for `ctx`.
///
/// Attributes are suppressed entirely when not in CI, mirroring
/// pytest-mergify's detectors, which return an empty `Resource` when there is
/// no provider.
#[must_use]
pub fn attributes(ctx: &CiContext) -> BTreeMap<String, AttrValue> {
    let mut attrs = BTreeMap::new();
    let Some(provider) = ctx.provider else {
        return attrs;
    };

    attrs.insert("cicd.provider.name".to_owned(), provider.as_str().into());

    put(&mut attrs, "vcs.repository.name", opt(ctx.repository.name.as_deref()));
    put(&mut attrs, "vcs.repository.url.full", opt(ctx.repository.url.as_deref()));
    put(&mut attrs, "vcs.repository.id", ctx.repository.id.map(Into::into));
    put(&mut attrs, "vcs.ref.head.name", opt(ctx.refs.head_branch.as_deref()));
    put(&mut attrs, "vcs.ref.head.revision", opt(ctx.refs.head_sha.as_deref()));
    put(&mut attrs, "vcs.ref.head.type", opt(ctx.refs.head_type.as_deref()));
    put(&mut attrs, "vcs.ref.base.name", opt(ctx.refs.base_branch.as_deref()));
    put(&mut attrs, "cicd.pipeline.name", opt(ctx.pipeline.name.as_deref()));
    put(&mut attrs, "cicd.pipeline.task.name", opt(ctx.pipeline.task.as_deref()));
    put(&mut attrs, "cicd.pipeline.run.id", ctx.pipeline.run_id.clone());
    put(&mut attrs, "cicd.pipeline.run.attempt", ctx.pipeline.attempt.map(Into::into));
    put(&mut attrs, "cicd.pipeline.runner.name", opt(ctx.pipeline.runner.as_deref()));
    put(&mut attrs, "cicd.pipeline.run.url", opt(ctx.pipeline.run_url.as_deref()));

    for (key, value) in &ctx.extra {
        attrs.insert(key.clone(), value.clone());
    }
    attrs
}

fn opt(value: Option<&str>) -> Option<AttrValue> {
    value.map(Into::into)
}

fn put(attrs: &mut BTreeMap<String, AttrValue>, key: &str, value: Option<AttrValue>) {
    if let Some(value) = value {
        attrs.insert(key.to_owned(), value);
    }
}
