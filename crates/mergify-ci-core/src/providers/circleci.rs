//! CircleCI provider.
//!
//! The git layer covers CircleCI's attributes, so it declares only detection
//! and its endpoint repository name (no `extract` override).

use std::collections::BTreeMap;

use super::CiProvider;
use crate::context::Provider;
use crate::repo;

pub(super) struct CircleCi;

impl CiProvider for CircleCi {
    fn provider(&self) -> Provider {
        Provider::CircleCi
    }

    fn detect_var(&self) -> &'static str {
        "CIRCLECI"
    }

    fn endpoint_name(&self, env: &BTreeMap<String, String>) -> Option<String> {
        repo::from_env_url(env, "CIRCLE_REPOSITORY_URL")
    }
}
