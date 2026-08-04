//! Node binding over `mergify-ci-core`, packaged as `@mergifyio/ci-native`.
//!
//! One `.node` per platform, published as `@mergifyio/ci-native-<target>`
//! optional dependencies of the loader package. `@mergifyio/ci-core` loads it
//! fail-open: when no prebuilt exists for the platform, detection reports
//! nothing rather than breaking the test run.

use std::collections::BTreeMap;

use mergify_ci_core::{AttrValue, CiContext};
use napi_derive::napi;

/// Detect from the current process environment and working directory.
fn context() -> CiContext {
    let env: BTreeMap<String, String> = std::env::vars().collect();
    let cwd = std::env::current_dir().unwrap_or_else(|_| ".".into());
    mergify_ci_core::detect(&env, &cwd)
}

/// The detected CI context as JSON: `provider` and `repositoryName` (both
/// nullable) plus the OTel resource `attributes` map (string or integer
/// values). JSON keeps the binding surface to a single string-returning
/// function — the TS side owns the typing.
#[napi]
pub fn detect_json() -> String {
    let ctx = context();
    let attributes: serde_json::Map<String, serde_json::Value> =
        mergify_ci_core::otel_attributes(&ctx)
            .into_iter()
            .map(|(key, value)| {
                let value = match value {
                    AttrValue::Int(i) => serde_json::Value::from(i),
                    AttrValue::Str(s) => serde_json::Value::from(s),
                };
                (key, value)
            })
            .collect();

    serde_json::json!({
        "provider": ctx.provider.map(mergify_ci_core::Provider::as_str),
        "repositoryName": ctx.repository_name,
        "attributes": attributes,
    })
    .to_string()
}
