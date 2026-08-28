//! The flaky-detection budget engine — the pure, deterministic arithmetic
//! shared across clients.
//!
//! What lives here: choosing which tests to rerun, computing the total rerun
//! budget, and dividing it into per-test time shares. What does *not*: filling
//! metrics from a framework's test reports, wall-clock deadlines
//! (`now + share`), and finalizer/rerun mechanics — those are per-client.

// Budget math is float arithmetic over integer-millisecond context values;
// int -> float precision loss is inherent and acceptable here.
#![allow(clippy::cast_precision_loss)]

use std::collections::HashSet;

use crate::models::FlakyDetectionContext;

/// Which population of tests to rerun.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Rerun tests not in the server's baseline — a PR context.
    New,
    /// Rerun tests the server flags as unhealthy — push/scheduled runs.
    Unhealthy,
}

/// The selected tests and the total rerun budget for a session.
#[derive(Debug, Clone, PartialEq)]
pub struct BudgetPlan {
    /// Total rerun budget for the session, in milliseconds.
    pub available_budget_ms: f64,
    /// Tests selected for reruns, in the order they were given.
    pub tests_to_process: Vec<String>,
}

/// Whether flaky detection should run at all.
///
/// `false` in [`Mode::New`] with an empty baseline: every test would look new
/// and the whole suite would rerun. pytest raises `FlakyDetectionDisabledError`
/// here; the other clients skip the same way.
#[must_use]
pub fn should_run(context: &FlakyDetectionContext, mode: Mode) -> bool {
    !(matches!(mode, Mode::New) && context.existing_test_names.is_empty())
}

/// Select the tests to rerun and compute the session's rerun budget.
///
/// The budget is `ratio × mean_duration × (# baseline tests present this
/// session)`, floored at `min_budget_duration_ms`. `excluded` holds tests that
/// opted out of flaky detection.
#[must_use]
pub fn plan(
    context: &FlakyDetectionContext,
    mode: Mode,
    session_tests: &[String],
    excluded: &[String],
) -> BudgetPlan {
    let existing: HashSet<&str> = context.existing_test_names.iter().map(String::as_str).collect();
    let unhealthy: HashSet<&str> =
        context.unhealthy_test_names.iter().map(String::as_str).collect();
    let opted_out: HashSet<&str> = excluded.iter().map(String::as_str).collect();

    // The budget scales with how many baseline tests are actually in this
    // session — the same count in both modes.
    let existing_in_session = session_tests
        .iter()
        .filter(|test| existing.contains(test.as_str()))
        .count();

    let budget_ratio = match mode {
        Mode::New => context.budget_ratio_for_new_tests,
        Mode::Unhealthy => context.budget_ratio_for_unhealthy_tests,
    };
    let total_duration_ms =
        context.existing_tests_mean_duration_ms as f64 * existing_in_session as f64;
    let available_budget_ms =
        (budget_ratio * total_duration_ms).max(context.min_budget_duration_ms as f64);

    let tests_to_process = session_tests
        .iter()
        .filter(|test| {
            let test = test.as_str();
            if opted_out.contains(test) {
                return false;
            }
            match mode {
                Mode::New => !existing.contains(test),
                Mode::Unhealthy => unhealthy.contains(test),
            }
        })
        .cloned()
        .collect();

    BudgetPlan { available_budget_ms, tests_to_process }
}

/// Per-test time share (ms) for a static, equal split of the whole budget —
/// used on xdist workers, where the split is decided up front.
#[must_use]
pub fn static_share_ms(available_budget_ms: f64, num_tests: usize) -> f64 {
    available_budget_ms / num_tests.max(1) as f64
}

/// Per-test time share (ms) for a dynamic split: the budget still unspent,
/// divided over the tests not yet given a deadline.
#[must_use]
pub fn dynamic_share_ms(
    available_budget_ms: f64,
    used_budget_ms: f64,
    num_tests: usize,
    processed: usize,
) -> f64 {
    let remaining_budget = (available_budget_ms - used_budget_ms).max(0.0);
    let remaining_tests = num_tests.saturating_sub(processed).max(1);
    remaining_budget / remaining_tests as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context() -> FlakyDetectionContext {
        FlakyDetectionContext {
            budget_ratio_for_new_tests: 0.1,
            budget_ratio_for_unhealthy_tests: 0.5,
            existing_test_names: names(&["a", "b", "c"]),
            existing_tests_mean_duration_ms: 100,
            unhealthy_test_names: names(&["b", "c"]),
            budget_ratio_for_test_retries: 0.05,
            flaky_test_names: names(&["c"]),
            broken_test_names: vec![],
            max_test_execution_count: 10,
            max_test_name_length: 256,
            min_budget_duration_ms: 5000,
            min_test_execution_count: 3,
        }
    }

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn budget_floored_at_minimum() {
        // 0.1 * 100 * 3 = 30 < 5000 -> floor at min_budget_duration_ms.
        let result = plan(&context(), Mode::New, &names(&["a", "b", "c", "new1"]), &[]);
        assert!((result.available_budget_ms - 5000.0).abs() < f64::EPSILON);
    }

    #[test]
    fn budget_scales_above_minimum() {
        let mut ctx = context();
        ctx.existing_tests_mean_duration_ms = 4000;
        // unhealthy ratio 0.5 * 4000 * 3 = 6000 > 5000.
        let result = plan(&ctx, Mode::Unhealthy, &names(&["a", "b", "c"]), &[]);
        assert!((result.available_budget_ms - 6000.0).abs() < f64::EPSILON);
    }

    #[test]
    fn selects_new_tests_excluding_baseline_and_optouts() {
        let result = plan(
            &context(),
            Mode::New,
            &names(&["a", "b", "new1", "new2"]),
            &names(&["new2"]),
        );
        assert_eq!(result.tests_to_process, names(&["new1"]));
    }

    #[test]
    fn selects_unhealthy_tests_excluding_optouts() {
        let result = plan(&context(), Mode::Unhealthy, &names(&["a", "b", "c"]), &names(&["c"]));
        assert_eq!(result.tests_to_process, names(&["b"]));
    }

    #[test]
    fn should_run_skips_new_without_baseline() {
        let mut ctx = context();
        ctx.existing_test_names.clear();
        assert!(!should_run(&ctx, Mode::New));
        assert!(should_run(&ctx, Mode::Unhealthy));
        assert!(should_run(&context(), Mode::New));
    }

    #[test]
    fn static_share_splits_evenly_and_guards_zero() {
        assert!((static_share_ms(1000.0, 4) - 250.0).abs() < f64::EPSILON);
        assert!((static_share_ms(1000.0, 0) - 1000.0).abs() < f64::EPSILON);
    }

    #[test]
    fn dynamic_share_uses_remaining_budget_and_tests() {
        // remaining budget 800 over remaining tests 3.
        assert!((dynamic_share_ms(1000.0, 200.0, 5, 2) - 800.0 / 3.0).abs() < 1e-9);
        // used exceeds budget -> 0.
        assert!((dynamic_share_ms(1000.0, 1200.0, 5, 2)).abs() < f64::EPSILON);
        // processed >= tests -> divide by 1.
        assert!((dynamic_share_ms(1000.0, 200.0, 3, 5) - 800.0).abs() < f64::EPSILON);
    }
}
