//! Rspec-mergify's own test suite — a fixed identity its specs rely on.
//!
//! Detected via `_RSPEC_MERGIFY_TEST`; contributes no CI attributes (the git
//! layer covers those), only the hard-coded endpoint repository name. The name
//! stays the gem's original repository, as the pytest suite keeps its own:
//! it identifies the suite to the API, not the tree the sources now live in.

use std::collections::BTreeMap;

use super::CiProvider;
use crate::context::Provider;

pub(super) struct RspecSuite;

impl CiProvider for RspecSuite {
    fn provider(&self) -> Provider {
        Provider::RspecSuite
    }

    fn detect_var(&self) -> &'static str {
        "_RSPEC_MERGIFY_TEST"
    }

    fn endpoint_name(&self, _env: &BTreeMap<String, String>) -> Option<String> {
        Some("Mergifyio/rspec-mergify".to_owned())
    }
}
