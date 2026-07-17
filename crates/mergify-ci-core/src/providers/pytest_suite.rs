//! Pytest-mergify's own test suite — a fixed identity its tests rely on.
//!
//! Detected via `_PYTEST_MERGIFY_TEST`; contributes no CI attributes (the git
//! layer covers those), only the hard-coded endpoint repository name.

use std::collections::BTreeMap;

use super::CiProvider;
use crate::context::Provider;

pub(super) struct PytestSuite;

impl CiProvider for PytestSuite {
    fn provider(&self) -> Provider {
        Provider::PytestSuite
    }

    fn detect_var(&self) -> &'static str {
        "_PYTEST_MERGIFY_TEST"
    }

    fn endpoint_name(&self, _env: &BTreeMap<String, String>) -> Option<String> {
        Some("Mergifyio/pytest-mergify".to_owned())
    }
}
