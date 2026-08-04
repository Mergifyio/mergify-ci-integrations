//! Typed wire models for the Mergify backend API responses.
//!
//! Unknown fields are ignored (serde default), so the server may add fields
//! without breaking older clients.

use serde::Deserialize;

/// One page of the quarantine-list response (`GET …/quarantines`). The full
/// list is assembled across pages by the fetch layer, following the
/// `Link: rel="next"` header.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct QuarantinePage {
    /// Quarantined tests on this page.
    pub quarantined_tests: Vec<QuarantinedTest>,
}

/// A single quarantined test. Only `test_name` is consumed today.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct QuarantinedTest {
    /// Fully-qualified test name.
    pub test_name: String,
}

/// The flaky-detection context (`GET …/flaky-detection-context`): the server's
/// baseline and budget parameters for a repository.
///
/// Ports pytest-mergify's `_FlakyDetectionContext`; the field names are the
/// wire contract shared across clients.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct FlakyDetectionContext {
    /// Fraction of the existing-suite runtime budgeted for new tests.
    pub budget_ratio_for_new_tests: f64,
    /// Fraction of the existing-suite runtime budgeted for unhealthy tests.
    pub budget_ratio_for_unhealthy_tests: f64,
    /// Names of tests already known to the server — the baseline.
    pub existing_test_names: Vec<String>,
    /// Mean duration of an existing test, in milliseconds.
    pub existing_tests_mean_duration_ms: i64,
    /// Names of tests currently considered unhealthy.
    pub unhealthy_test_names: Vec<String>,
    /// Maximum number of times a single test may be executed.
    pub max_test_execution_count: i64,
    /// Maximum test-name length the server tracks.
    pub max_test_name_length: i64,
    /// Minimum budget duration, in milliseconds, even for tiny suites.
    pub min_budget_duration_ms: i64,
    /// Minimum executions required to consider a test measured.
    pub min_test_execution_count: i64,
}

/// The test-selection response (`GET …/test-selection`): whether this run may
/// execute only a subset of tests, as a merge-queue rerun replaying the tests
/// that failed on a previous attempt.
///
/// Polymorphic on `selection`: `tests` is part of a `subset` answer and absent
/// from a `full` one, so it is `None` when the field is missing — letting the
/// fetch layer tell a `subset` with no `tests` (a protocol break, surfaced)
/// apart from a `subset` with an empty `tests` (normalised to full client-side).
/// The `subset`-matched-nothing normalisation likewise stays client-side, next
/// to the collected items it compares against.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct TestSelection {
    /// `"full"` (run everything) or `"subset"` (run only `tests`).
    pub selection: String,
    /// Why the server chose this selection — surfaced in the plugin report.
    pub reason: String,
    /// The node ids to run when `selection` is `"subset"`; `None` when the field
    /// is absent (always for `"full"`; a protocol break for `"subset"`). An
    /// `Option<T>` field is optional to serde, so a missing key is `None`.
    pub tests: Option<Vec<String>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserializes_quarantine_page_ignoring_extra_fields() {
        let json =
            r#"{"quarantined_tests":[{"test_name":"tests/test_a.py::test_x","reason":"flaky"}]}"#;
        let page: QuarantinePage = serde_json::from_str(json).unwrap();
        assert_eq!(page.quarantined_tests.len(), 1);
        assert_eq!(page.quarantined_tests[0].test_name, "tests/test_a.py::test_x");
    }

    #[test]
    fn deserializes_flaky_context() {
        let json = r#"{
            "budget_ratio_for_new_tests": 0.1,
            "budget_ratio_for_unhealthy_tests": 0.2,
            "existing_test_names": ["a", "b"],
            "existing_tests_mean_duration_ms": 120,
            "unhealthy_test_names": ["b"],
            "max_test_execution_count": 10,
            "max_test_name_length": 256,
            "min_budget_duration_ms": 5000,
            "min_test_execution_count": 3,
            "server_added_field": true
        }"#;
        let ctx: FlakyDetectionContext = serde_json::from_str(json).unwrap();
        assert_eq!(ctx.existing_test_names, ["a", "b"]);
        assert_eq!(ctx.unhealthy_test_names, ["b"]);
        assert_eq!(ctx.max_test_execution_count, 10);
        assert_eq!(ctx.min_budget_duration_ms, 5000);
        assert!((ctx.budget_ratio_for_new_tests - 0.1).abs() < f64::EPSILON);
    }

    #[test]
    fn deserializes_subset_test_selection() {
        let json = r#"{"selection":"subset","reason":"queue_rerun","tests":["t::a","t::b"]}"#;
        let selection: TestSelection = serde_json::from_str(json).unwrap();
        assert_eq!(selection.selection, "subset");
        assert_eq!(selection.reason, "queue_rerun");
        assert_eq!(selection.tests.unwrap(), ["t::a", "t::b"]);
    }

    #[test]
    fn deserializes_full_test_selection_without_tests_field() {
        let json = r#"{"selection":"full","reason":"not_requested"}"#;
        let selection: TestSelection = serde_json::from_str(json).unwrap();
        assert_eq!(selection.selection, "full");
        // A missing `tests` is `None`, distinct from a present empty list.
        assert!(selection.tests.is_none());
    }
}
