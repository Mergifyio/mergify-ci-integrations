//! Ruby binding over `mergify-ci-core`, the Ruby counterpart of the `PyO3` and
//! napi bindings.
//!
//! The surface is deliberately the same three functions those expose, with the
//! same semantics: the environment and working directory are read at call time,
//! so Ruby code that mutates `ENV` before calling sees its own changes.
//!
//! Everything lands under `Mergify::RSpec::Native`, a namespace the gem owns —
//! the extension is an implementation detail behind `Utils`, not public API.

use std::collections::BTreeMap;

use magnus::{Error, RHash, Ruby, function, prelude::*};
use mergify_ci_core::{AttrValue, CiContext};

/// Detect from the current process environment and working directory.
fn context() -> CiContext {
    let env: BTreeMap<String, String> = std::env::vars().collect();
    let cwd = std::env::current_dir().unwrap_or_else(|_| ".".into());
    mergify_ci_core::detect(&env, &cwd)
}

/// The detected CI provider as its stable name, or `nil` when not in CI.
fn detect_provider() -> Option<String> {
    context().provider.map(|p| p.as_str().to_owned())
}

/// The API-endpoint `owner/repo`, or `nil` when undeterminable.
fn detect_repository_name() -> Option<String> {
    context().repository_name
}

/// The OTel resource attributes for this run, as a `Hash[String, String | Integer]`.
fn detect_attributes(ruby: &Ruby) -> Result<RHash, Error> {
    let hash = ruby.hash_new();
    for (key, value) in mergify_ci_core::otel_attributes(&context()).into_map() {
        match value {
            AttrValue::Int(i) => hash.aset(key, i)?,
            AttrValue::Str(s) => hash.aset(key, s)?,
        }
    }
    Ok(hash)
}

#[magnus::init]
fn init(ruby: &Ruby) -> Result<(), Error> {
    let mergify = ruby.define_module("Mergify")?;
    let rspec = mergify.define_module("RSpec")?;
    let native = rspec.define_module("Native")?;

    native.define_singleton_method("detect_provider", function!(detect_provider, 0))?;
    native.define_singleton_method(
        "detect_repository_name",
        function!(detect_repository_name, 0),
    )?;
    native.define_singleton_method("detect_attributes", function!(detect_attributes, 0))?;

    Ok(())
}
