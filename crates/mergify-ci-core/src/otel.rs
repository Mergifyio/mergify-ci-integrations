//! Maps the typed [`CiContext`] to OpenTelemetry resource attributes.
//!
//! This is the *only* module that knows semconv attribute keys — the typed
//! core and the JSON sidecar stay OTel-agnostic.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::context::{AttrValue, CiContext};

/// The OTel resource-attribute projection of [`CiContext`]: one optional,
/// individually-typed field per semconv key, serializing to exactly the
/// dotted-key attribute object. This struct is the contract each binding
/// projects into its language's typed artifact (TS interface, Python
/// `TypedDict`, Ruby RBS) instead of transcribing key lists by hand — keep it
/// the single place semconv strings live.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CiResourceAttributes {
    /// From `MERGIFY_TEST_JOB_NAME`; the only attribute emitted outside CI.
    #[serde(rename = "mergify.test.job.name", skip_serializing_if = "Option::is_none", default)]
    pub test_job_name: Option<String>,
    #[serde(rename = "cicd.provider.name", skip_serializing_if = "Option::is_none", default)]
    pub provider_name: Option<String>,
    #[serde(rename = "vcs.repository.name", skip_serializing_if = "Option::is_none", default)]
    pub repository_name: Option<String>,
    #[serde(rename = "vcs.repository.url.full", skip_serializing_if = "Option::is_none", default)]
    pub repository_url: Option<String>,
    #[serde(rename = "vcs.repository.id", skip_serializing_if = "Option::is_none", default)]
    pub repository_id: Option<i64>,
    #[serde(rename = "vcs.ref.head.name", skip_serializing_if = "Option::is_none", default)]
    pub head_branch: Option<String>,
    #[serde(rename = "vcs.ref.head.revision", skip_serializing_if = "Option::is_none", default)]
    pub head_sha: Option<String>,
    #[serde(rename = "vcs.ref.head.type", skip_serializing_if = "Option::is_none", default)]
    pub head_type: Option<String>,
    #[serde(rename = "vcs.ref.base.name", skip_serializing_if = "Option::is_none", default)]
    pub base_branch: Option<String>,
    #[serde(rename = "cicd.pipeline.name", skip_serializing_if = "Option::is_none", default)]
    pub pipeline_name: Option<String>,
    #[serde(rename = "cicd.pipeline.task.name", skip_serializing_if = "Option::is_none", default)]
    pub task_name: Option<String>,
    /// Int on GitHub Actions, string on Jenkins/CircleCI/Buildkite.
    #[serde(rename = "cicd.pipeline.run.id", skip_serializing_if = "Option::is_none", default)]
    pub run_id: Option<AttrValue>,
    #[serde(rename = "cicd.pipeline.run.attempt", skip_serializing_if = "Option::is_none", default)]
    pub run_attempt: Option<i64>,
    #[serde(rename = "cicd.pipeline.runner.name", skip_serializing_if = "Option::is_none", default)]
    pub runner_name: Option<String>,
    #[serde(rename = "cicd.pipeline.run.url", skip_serializing_if = "Option::is_none", default)]
    pub run_url: Option<String>,
    /// Provider-specific attributes with no typed field.
    #[serde(flatten)]
    pub extra: BTreeMap<String, AttrValue>,
}

impl CiResourceAttributes {
    /// The dotted-key map form, for consumers that iterate attributes (dict
    /// building in bindings, tests). Serialization-based so the map and the
    /// struct can never disagree.
    #[must_use]
    pub fn into_map(self) -> BTreeMap<String, AttrValue> {
        let value = serde_json::to_value(&self).expect("attribute struct serializes to an object");
        serde_json::from_value(value).expect("attribute object deserializes to a map")
    }
}

/// Build the OTel resource attributes for `ctx`.
///
/// The CI/git/provider attributes are suppressed when not in CI (mirroring
/// pytest-mergify's provider-guarded detectors), but always-on attributes such
/// as `mergify.test.job.name` are still emitted.
#[must_use]
pub fn attributes(ctx: &CiContext) -> CiResourceAttributes {
    if ctx.provider.is_none() {
        return CiResourceAttributes {
            test_job_name: ctx.test_job_name.clone(),
            ..CiResourceAttributes::default()
        };
    }

    CiResourceAttributes {
        test_job_name: ctx.test_job_name.clone(),
        provider_name: ctx.provider.map(|p| p.as_str().to_owned()),
        repository_name: ctx.repository.name.clone(),
        repository_url: ctx.repository.url.clone(),
        repository_id: ctx.repository.id,
        head_branch: ctx.refs.head_branch.clone(),
        head_sha: ctx.refs.head_sha.clone(),
        head_type: ctx.refs.head_type.clone(),
        base_branch: ctx.refs.base_branch.clone(),
        pipeline_name: ctx.pipeline.name.clone(),
        task_name: ctx.pipeline.task.clone(),
        run_id: ctx.pipeline.run_id.clone(),
        run_attempt: ctx.pipeline.attempt,
        runner_name: ctx.pipeline.runner.clone(),
        run_url: ctx.pipeline.run_url.clone(),
        extra: ctx.extra.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_to_dotted_keys_without_nulls() {
        let attrs = CiResourceAttributes {
            provider_name: Some("github_actions".to_owned()),
            run_id: Some(AttrValue::Int(42)),
            ..CiResourceAttributes::default()
        };
        let value = serde_json::to_value(&attrs).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "cicd.provider.name": "github_actions",
                "cicd.pipeline.run.id": 42,
            }),
        );
    }

    #[test]
    fn map_form_matches_serialization_and_flattens_extra() {
        let mut attrs = CiResourceAttributes {
            provider_name: Some("jenkins".to_owned()),
            run_id: Some(AttrValue::Str("57".to_owned())),
            ..CiResourceAttributes::default()
        };
        attrs.extra.insert("custom.key".to_owned(), "v".into());

        let map = attrs.clone().into_map();
        assert_eq!(map["cicd.provider.name"], "jenkins".into());
        // Jenkins run id stays a string; extra keys land beside typed ones.
        assert_eq!(map["cicd.pipeline.run.id"], "57".into());
        assert_eq!(map["custom.key"], "v".into());
        assert_eq!(serde_json::to_value(&map).unwrap(), serde_json::to_value(&attrs).unwrap());
    }
}
