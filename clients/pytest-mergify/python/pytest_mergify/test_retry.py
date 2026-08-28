"""Retrying a failed attempt at a test Mergify already knows to be flaky.

Where flaky detection is observational -- it reruns to learn, whatever the
first attempt did, and never changes what the session reports -- retry is
reactive: it acts only on a failure, stops at the first pass, and owns the
verdict. The two share the run context and the rerun machinery and nothing
else, so that one running out of budget can never switch off the other.
"""

import dataclasses
import os
import typing

import _pytest
import _pytest.main
import _pytest.nodes
import _pytest.reports

from pytest_mergify import rerun


@dataclasses.dataclass
class TestRetrier(rerun.RerunLoop):
    # Every test in the session that Mergify classifies as flaky and that did
    # not opt out. Retry owns the verdict for all of them, including the ones
    # whose reruns it does not pay for.
    _eligible_tests: typing.Set[str] = dataclasses.field(
        init=False, default_factory=set
    )
    # How many times each eligible test has reached its call phase, so the
    # first attempt can be told from the ones answering for it.
    _attempt_counts: typing.Dict[str, int] = dataclasses.field(
        init=False, default_factory=dict
    )
    _failed_initially: typing.Set[str] = dataclasses.field(
        init=False, default_factory=set
    )
    # Which attempt answered the failure, not merely that one did: flaky
    # detection keeps rerunning past the pass, so the last attempt a test made
    # is often not the one that rescued it.
    _rescued_on_attempt: typing.Dict[str, int] = dataclasses.field(
        init=False, default_factory=dict
    )
    # Tests whose loop stopped because the budget ran out rather than because
    # the answer was in. The one state that shows retry doing less than a
    # reader would assume, so it is tracked rather than inferred.
    _budget_exhausted_tests: typing.Set[str] = dataclasses.field(
        init=False, default_factory=set
    )

    @classmethod
    def from_context_dict(
        cls,
        context_dict: typing.Dict[str, typing.Any],
        is_xdist: bool,
    ) -> "TestRetrier":
        return cls(_context=rerun.RunContext(**context_dict), _is_xdist=is_xdist)

    def prepare_for_session(
        self,
        session: _pytest.main.Session,
        tests_being_detected: typing.AbstractSet[str] = frozenset(),
        detection_gates_failures: bool = False,
    ) -> None:
        tests_in_session = {item.nodeid for item in session.items}
        opted_out = {
            item.nodeid
            for item in session.items
            if rerun.mergify_marker_disables(item, "auto_retry")
        }

        self._eligible_tests = {
            test
            for test in self._context.flaky_test_names
            if test in tests_in_session and test not in opted_out
        }
        # `broken_test_names` is deliberately not read: a test that fails every
        # time is not something a rerun can rescue, and spending the budget
        # discovering that again on every run buys nothing.

        if detection_gates_failures:
            # In `new` mode a rerun failure is itself the merge gate -- the one
            # stopping a newly flaky test from being merged. The server can
            # call a test both new and flaky at once, when its baseline lags a
            # rename or a re-parametrization, and absorbing the failure would
            # silence that gate. The stricter of the two answers wins.
            self._eligible_tests -= tests_being_detected

        # Flaky detection is already rerunning what is left of the overlap, on
        # its own budget. Its attempts answer retry's question, so retry reads
        # their outcomes rather than buying a second set of its own.
        self._tests_to_process = sorted(self._eligible_tests - tests_being_detected)

        # The whole collected session, not the intersection with the server's
        # baseline that flaky detection uses: a repository that opted into
        # retry alone is served no baseline at all, and scaling by it would
        # collapse every such repository onto the minimum-budget floor.
        total_duration = self._context.existing_tests_mean_duration * len(
            tests_in_session
        )

        self._available_budget_duration = max(
            self._context.budget_ratio_for_test_retries * total_duration,
            self._context.min_budget_duration,
        )

    def try_fill_metrics_from_report(self, report: _pytest.reports.TestReport) -> None:
        # Recorded for every eligible test, including those flaky detection
        # reruns: retry owns their verdict too, so it must see how they went
        # even where it never spends a second of its own budget on them.
        if report.when == "call" and report.nodeid in self._eligible_tests:
            self._record_attempt(report.nodeid, report.outcome)

        super().try_fill_metrics_from_report(report)

    def _record_attempt(self, test: str, outcome: str) -> None:
        attempt = self._attempt_counts.get(test, 0) + 1
        self._attempt_counts[test] = attempt

        if attempt == 1:
            if outcome == "failed":
                self._failed_initially.add(test)
            return

        if (
            outcome == "passed"
            and test in self._failed_initially
            and test not in self._rescued_on_attempt
        ):
            self._rescued_on_attempt[test] = attempt

    def is_eligible(self, test: str) -> bool:
        """Whether a failure of this test is Mergify's to answer for.

        Asked before the first attempt runs, because the answer decides whether
        that attempt is allowed to be the session's final word on the test.
        """
        return test in self._eligible_tests

    def wants_rerun(self, test: str) -> bool:
        """Whether retry has both a reason and a mandate to run this again.

        A reason: the test failed. A mandate: nobody else is already rerunning
        it, and the test is one metrics were kept for -- an over-length name is
        dropped before any metric exists, and everything a rerun needs is read
        off those metrics. Asked before any finalizer is moved, so a test retry
        will never touch does not have its fixture teardown deferred.
        """
        return (
            # Ordered cheapest first: `_failed_initially` is empty for almost
            # every test, and `_tests_to_process` is a list scan.
            test in self._failed_initially
            and self.has_test_executed(test)
            and test in self._tests_to_process
        )

    def has_rescued(self, test: str) -> bool:
        "Whether a later attempt passed, so the failure has been answered."
        return test in self._rescued_on_attempt

    def has_retried(self, test: str) -> bool:
        "Whether the test failed and was run again because of it."
        return test in self._failed_initially and self._attempt_counts.get(test, 0) > 1

    @property
    def executions_needed_to_answer(self) -> int:
        # One pass is the whole answer, where detection needs a sample it can
        # learn from. Reading detection's minimum here would refuse a retry
        # that fits several times over.
        return 1

    @property
    def tests_sharing_budget(self) -> int:
        # Only a test that failed is ever rerun, so only those spend the
        # budget. Dividing by every eligible test instead would hand a failure
        # a fraction of what is actually free, and a repository with more than
        # a handful of known-flaky tests would never afford a single retry.
        return max(len(self._failed_initially), 1)

    def decide_test_is_too_slow(self, test: str) -> bool:
        too_slow = super().decide_test_is_too_slow(test)
        if too_slow:
            # Not one attempt fits in what is left of the budget. That is the
            # same shortfall as running out mid-loop, and reads just as wrongly
            # as a verdict on the test, so it is surfaced the same way.
            self._budget_exhausted_tests.add(test)

        return too_slow

    def _reached_rerun_limit(self, test: str) -> bool:
        # A pass is the whole answer retry was after; anything further would
        # spend budget another test may still need.
        if self.has_rescued(test):
            return True

        metrics = self._test_metrics[test]
        # Read before super() rather than after: the clock moves between the
        # two, so asking again can report a budget shortfall for a test that
        # actually stopped on the execution cap.
        out_of_budget = metrics.will_exceed_deadline()

        reached = super()._reached_rerun_limit(test)
        if reached and out_of_budget:
            self._budget_exhausted_tests.add(test)

        return reached

    def to_serializable_metrics(self) -> typing.Dict[str, typing.Any]:
        return {
            **super().to_serializable_metrics(),
            "attempt_counts": dict(self._attempt_counts),
            "rescued_on_attempt": dict(self._rescued_on_attempt),
            "unrescued_tests": sorted(
                self._failed_initially - set(self._rescued_on_attempt)
            ),
            "budget_exhausted_tests": sorted(self._budget_exhausted_tests),
        }

    def make_report(self) -> str:
        return make_report_from_aggregated(
            available_budget_duration_ms=self._available_budget_duration.total_seconds()
            * 1000,
            aggregated_metrics=self.to_serializable_metrics(),
        )


@dataclasses.dataclass
class XdistTestRetryController:
    """Aggregates what each xdist worker's retrier did, for one terminal block.

    Workers each hold their own retrier and decide their own verdicts; only the
    report is assembled here, because only the controller has a terminal.
    """

    _aggregated_metrics: typing.Dict[str, typing.Any] = dataclasses.field(
        default_factory=lambda: {
            "test_metrics": {},
            "attempt_counts": {},
            "rescued_on_attempt": {},
            "unrescued_tests": [],
            "budget_exhausted_tests": [],
        }
    )
    _available_budget_duration_ms: float = dataclasses.field(default=0.0)
    _saw_worker_metrics: bool = dataclasses.field(default=False)

    @property
    def has_metrics(self) -> bool:
        return self._saw_worker_metrics

    def collect_worker_metrics(
        self, worker_metrics: typing.Dict[str, typing.Any]
    ) -> None:
        self._saw_worker_metrics = True
        self._aggregated_metrics["test_metrics"].update(worker_metrics["test_metrics"])
        self._aggregated_metrics["attempt_counts"].update(
            worker_metrics["attempt_counts"]
        )
        self._aggregated_metrics["rescued_on_attempt"].update(
            worker_metrics["rescued_on_attempt"]
        )
        for key in ("unrescued_tests", "budget_exhausted_tests"):
            self._aggregated_metrics[key].extend(worker_metrics[key])

        # Every worker computes the same budget from the same context, so the
        # first one to answer is as good as any.
        if self._available_budget_duration_ms == 0.0:
            self._available_budget_duration_ms = worker_metrics[
                "available_budget_duration_ms"
            ]

    def make_report(self) -> str:
        return make_report_from_aggregated(
            available_budget_duration_ms=self._available_budget_duration_ms,
            aggregated_metrics=self._aggregated_metrics,
        )


def make_report_from_aggregated(
    available_budget_duration_ms: float,
    aggregated_metrics: typing.Dict[str, typing.Any],
) -> str:
    attempt_counts = aggregated_metrics["attempt_counts"]
    rescued_on_attempt = aggregated_metrics["rescued_on_attempt"]
    rescued = sorted(rescued_on_attempt)
    unrescued = sorted(aggregated_metrics["unrescued_tests"])
    budget_exhausted = set(aggregated_metrics["budget_exhausted_tests"])

    result = "🔁 Test retry"

    if not rescued and not unrescued:
        result += (
            f"{os.linesep}- No eligible test failed, so nothing needed retrying 👌"
        )
        return result

    available_budget_seconds = available_budget_duration_ms / 1000
    used_budget_ms = sum(
        m["rerun_duration_ms"] for m in aggregated_metrics["test_metrics"].values()
    )
    used_budget_seconds = used_budget_ms / 1000
    if available_budget_seconds > 0:
        result += (
            f"{os.linesep}- Used {used_budget_seconds / available_budget_seconds * 100:.2f} % of the budget "
            f"({used_budget_seconds:.2f} s/{available_budget_seconds:.2f} s)"
        )
    else:
        result += f"{os.linesep}- Used {used_budget_seconds:.2f} s (budget unavailable)"

    if rescued:
        result += (
            f"{os.linesep}- Rescued {len(rescued)} "
            f"test{'s' if len(rescued) > 1 else ''}, so they did not fail this run:"
        )
        for test in rescued:
            result += (
                f"{os.linesep}    • '{test}' passed on attempt "
                f"{rescued_on_attempt[test]}"
            )

    if unrescued:
        result += (
            f"{os.linesep}- Still failing, so this run fails on "
            f"{'them' if len(unrescued) > 1 else 'it'}:"
        )
        for test in unrescued:
            attempts = attempt_counts.get(test, 0)
            result += (
                f"{os.linesep}    • '{test}' failed on its only attempt"
                if attempts <= 1
                else f"{os.linesep}    • '{test}' failed {attempts} times"
            )

    # A test that never got a second attempt belongs here too, whether retry
    # ran out mid-loop or could not afford to start: a reader cannot tell those
    # apart, and both read as a verdict the test never actually received.
    unaffordable = sorted(
        (
            budget_exhausted
            | {test for test in unrescued if attempt_counts.get(test, 0) <= 1}
        )
        & set(unrescued)
    )
    if unaffordable:
        result += (
            f"{os.linesep}⚠️ Retry could not afford another attempt, so "
            f"{'these failures are' if len(unaffordable) > 1 else 'this failure is'} "
            f"not a verdict on the "
            f"{'tests' if len(unaffordable) > 1 else 'test'}:"
        )
        for test in unaffordable:
            result += f"{os.linesep}    • '{test}'"

    return result
