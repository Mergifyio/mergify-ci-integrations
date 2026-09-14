//! The rerun budget engine — the pure, deterministic arithmetic shared across
//! clients, for both flaky detection and test retry.
//!
//! What lives here: choosing which tests to rerun, computing the total rerun
//! budget, and dividing it into per-test time shares. What does *not*: filling
//! metrics from a framework's test reports, wall-clock deadlines
//! (`now + share`), and finalizer/rerun mechanics — those are per-client.
//!
//! The two mechanisms keep separate budgets on purpose, so that one running out
//! can never switch the other off.

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

/// The tests test retry answers for, and the budget it may spend on them.
#[derive(Debug, Clone, PartialEq)]
pub struct RetryPlan {
    /// Total retry budget for the session, in milliseconds.
    pub available_budget_ms: f64,
    /// Every test whose failure retry owns the verdict for, in the order given
    /// — including the ones it will not pay to rerun.
    pub eligible_tests: Vec<String>,
    /// The eligible tests retry reruns on its own budget.
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

/// Select the tests test retry answers for and compute its session budget.
///
/// Retry owns the verdict for every eligible test, including the ones flaky
/// detection is already rerunning, but buys attempts only for the rest:
/// detection's reruns answer the same question, and paying twice for them would
/// starve the tests nobody else is rerunning.
///
/// `detection_gates_failures` says a detection rerun's failure is itself the
/// merge gate — true in [`Mode::New`]. The server can call one test both new and
/// flaky when its baseline lags a rename, and absorbing that failure would
/// silence the gate, so retry gives up the verdict there instead.
///
/// The budget scales with the whole session, not the baseline intersection
/// [`plan`] uses: a repository that opted into retry alone is served no
/// baseline, and would otherwise sit on `min_budget_duration_ms` forever.
///
/// `broken_test_names` is deliberately not read: a test that fails every time is
/// not something a rerun can rescue.
#[must_use]
pub fn retry_plan(
    context: &FlakyDetectionContext,
    session_tests: &[String],
    excluded: &[String],
    tests_being_detected: &[String],
    detection_gates_failures: bool,
) -> RetryPlan {
    let flaky: HashSet<&str> = context.flaky_test_names.iter().map(String::as_str).collect();
    let opted_out: HashSet<&str> = excluded.iter().map(String::as_str).collect();
    let being_detected: HashSet<&str> =
        tests_being_detected.iter().map(String::as_str).collect();

    let eligible_tests: Vec<String> = session_tests
        .iter()
        .filter(|test| {
            let test = test.as_str();
            flaky.contains(test)
                && !opted_out.contains(test)
                && !(detection_gates_failures && being_detected.contains(test))
        })
        .cloned()
        .collect();

    let tests_to_process = eligible_tests
        .iter()
        .filter(|test| !being_detected.contains(test.as_str()))
        .cloned()
        .collect();

    let total_duration_ms =
        context.existing_tests_mean_duration_ms as f64 * session_tests.len() as f64;
    let available_budget_ms = (context.budget_ratio_for_test_retries * total_duration_ms)
        .max(context.min_budget_duration_ms as f64);

    RetryPlan { available_budget_ms, eligible_tests, tests_to_process }
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

    #[test]
    fn retry_selects_flaky_tests_in_session_excluding_optouts() {
        let mut ctx = context();
        ctx.flaky_test_names = names(&["b", "c", "elsewhere"]);

        let result = retry_plan(&ctx, &names(&["a", "b", "c"]), &names(&["c"]), &[], false);

        assert_eq!(result.eligible_tests, names(&["b"]));
        assert_eq!(result.tests_to_process, names(&["b"]));
    }

    #[test]
    fn retry_never_acts_on_a_broken_test() {
        let mut ctx = context();
        ctx.flaky_test_names = vec![];
        ctx.broken_test_names = names(&["c"]);

        let result = retry_plan(&ctx, &names(&["a", "b", "c"]), &[], &[], false);

        assert!(result.eligible_tests.is_empty());
    }

    #[test]
    fn retry_owns_detected_tests_without_buying_their_reruns() {
        let mut ctx = context();
        ctx.flaky_test_names = names(&["b", "c"]);

        let result = retry_plan(&ctx, &names(&["a", "b", "c"]), &[], &names(&["c"]), false);

        assert_eq!(result.eligible_tests, names(&["b", "c"]));
        assert_eq!(result.tests_to_process, names(&["b"]));
    }

    #[test]
    fn retry_yields_the_verdict_where_detection_gates_the_merge() {
        let mut ctx = context();
        ctx.flaky_test_names = names(&["b", "c"]);

        let result = retry_plan(&ctx, &names(&["a", "b", "c"]), &[], &names(&["c"]), true);

        assert_eq!(result.eligible_tests, names(&["b"]));
        assert_eq!(result.tests_to_process, names(&["b"]));
    }

    #[test]
    fn retry_budget_scales_with_the_whole_session() {
        let mut ctx = context();
        ctx.existing_tests_mean_duration_ms = 4000;
        ctx.budget_ratio_for_test_retries = 0.5;

        // Four tests in session, three of them in the baseline: 0.5 * 4000 * 4.
        // Scaling by the baseline intersection instead would give 6000.
        let result = retry_plan(&ctx, &names(&["a", "b", "c", "new1"]), &[], &[], false);

        assert!((result.available_budget_ms - 8000.0).abs() < f64::EPSILON);
    }

    #[test]
    fn retry_budget_floored_at_minimum() {
        // 0.05 * 100 * 3 = 15 < 5000 -> floor at min_budget_duration_ms.
        let result = retry_plan(&context(), &names(&["a", "b", "c"]), &[], &[], false);

        assert!((result.available_budget_ms - 5000.0).abs() < f64::EPSILON);
    }
}
