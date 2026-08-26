"""The rerun machinery flaky detection and test retry share.

Both mechanisms answer a question by running a test again, and they differ only
in which tests they target, which budget they spend and when they stop. The
work in between -- per-test deadlines carved out of a budget, the execution
cap, and the fixture bookkeeping a rerun needs -- is the same, and lives here
so that neither mechanism's accounting can reach into the other's.
"""

import dataclasses
import datetime
import typing

import _pytest
import _pytest.main
import _pytest.nodes
import _pytest.reports

from pytest_mergify import utils


@dataclasses.dataclass
class RunContext:
    """The server's view of the repository, as one payload for both mechanisms.

    Named for the run rather than for flaky detection: the endpoint serving it
    answers for a repository that opted into either mechanism, so a field being
    empty says that mechanism is not configured, not that the payload is
    partial.
    """

    budget_ratio_for_new_tests: float
    budget_ratio_for_unhealthy_tests: float
    existing_test_names: typing.List[str]
    existing_tests_mean_duration_ms: int
    unhealthy_test_names: typing.List[str]
    max_test_execution_count: int
    max_test_name_length: int
    min_budget_duration_ms: int
    min_test_execution_count: int
    # Defaulted so a client running against an engine that predates test retry
    # still builds a context: the mechanism then reads as one with no budget
    # and nothing to retry, which is what an engine unable to serve it means.
    budget_ratio_for_test_retries: float = 0.0
    flaky_test_names: typing.List[str] = dataclasses.field(default_factory=list)
    broken_test_names: typing.List[str] = dataclasses.field(default_factory=list)

    @property
    def existing_tests_mean_duration(self) -> datetime.timedelta:
        return datetime.timedelta(milliseconds=self.existing_tests_mean_duration_ms)

    @property
    def min_budget_duration(self) -> datetime.timedelta:
        return datetime.timedelta(milliseconds=self.min_budget_duration_ms)


@dataclasses.dataclass
class TestMetrics:
    "Represents metrics collected for a test."

    initial_setup_duration: datetime.timedelta = dataclasses.field(
        default_factory=datetime.timedelta
    )
    initial_call_duration: datetime.timedelta = dataclasses.field(
        default_factory=datetime.timedelta
    )
    initial_teardown_duration: datetime.timedelta = dataclasses.field(
        default_factory=datetime.timedelta
    )

    @property
    def initial_duration(self) -> datetime.timedelta:
        """
        Represents the duration of the initial run of the test including the 3
        phases of the protocol (setup, call, teardown).
        """
        return (
            self.initial_setup_duration
            + self.initial_call_duration
            + self.initial_teardown_duration
        )

    rerun_count: int = dataclasses.field(default=0)
    "Represents the number of times the test has been rerun so far."

    deadline: typing.Optional[datetime.datetime] = dataclasses.field(default=None)

    prevented_timeout: bool = dataclasses.field(default=False)

    too_slow: bool = dataclasses.field(default=False)
    "Whether the test is too slow to be rerun, as decided at its first teardown."

    is_last_rerun: bool = dataclasses.field(default=False)
    "Whether the rerun in progress is the last one, so teardown restores finalizers."

    total_duration: datetime.timedelta = dataclasses.field(
        default_factory=datetime.timedelta
    )
    "Represents the total duration spent executing this test, including reruns."

    @property
    def rerun_duration(self) -> datetime.timedelta:
        """
        Represents the duration of the reruns alone.

        The initial execution runs whether or not the mechanism is enabled, so
        it is not work this feature added and is not charged to its budget.
        """
        return self.total_duration - self.initial_duration

    def fill_from_report(self, report: _pytest.reports.TestReport) -> None:
        duration = datetime.timedelta(seconds=report.duration)

        if report.when == "setup" and not self.initial_setup_duration:
            self.initial_setup_duration = duration
        elif report.when == "call" and not self.initial_call_duration:
            self.initial_call_duration = duration
        elif report.when == "teardown" and not self.initial_teardown_duration:
            self.initial_teardown_duration = duration

        if report.when == "call":
            self.rerun_count += 1

        self.total_duration += duration

    def remaining_time(self) -> datetime.timedelta:
        if not self.deadline:
            return datetime.timedelta()

        return max(
            self.deadline - datetime.datetime.now(datetime.timezone.utc),
            datetime.timedelta(),
        )

    def will_exceed_deadline(self) -> bool:
        if not self.deadline:
            return True

        return (
            datetime.datetime.now(datetime.timezone.utc) + self.initial_duration
            >= self.deadline
        )


@dataclasses.dataclass
class RerunLoop:
    """One mechanism's rerun lifecycle: its own targets, budget and metrics.

    Subclasses decide which tests they act on and how much time they may spend
    on them, by filling `_tests_to_process` and `_available_budget_duration` in
    `prepare_for_session`. Everything a rerun needs from there on is here, and
    is per-instance, so two mechanisms running in one session cannot spend each
    other's budget or count each other's executions.
    """

    # The baseline/budget context, fetched by the bundled binding
    # (`CiApiClient.fetch_flaky_context`) and injected -- this type owns only
    # the rerun lifecycle, not the API call.
    _context: RunContext

    # Static budget allocation (equal share per test) on xdist workers, which
    # cannot coordinate a running budget across processes; dynamic allocation
    # otherwise.
    _is_xdist: bool

    _test_metrics: typing.Dict[str, TestMetrics] = dataclasses.field(
        init=False, default_factory=dict
    )
    _over_length_tests: typing.Set[str] = dataclasses.field(
        init=False, default_factory=set
    )

    _available_budget_duration: datetime.timedelta = dataclasses.field(
        init=False, default_factory=datetime.timedelta
    )
    _tests_to_process: typing.List[str] = dataclasses.field(
        init=False, default_factory=list
    )

    _suspended_item_finalizers: typing.Dict[_pytest.nodes.Node, typing.Any] = (
        dataclasses.field(
            init=False,
            default_factory=dict,
        )
    )
    """
    Storage for temporarily suspended fixture finalizers during a rerun.

    Pytest maintains a `session._setupstate.stack` dictionary that tracks which
    fixture teardown functions (finalizers) need to run when a scope ends:

        {
            <test_item>: [(finalizer_fn, ...), exception_info],     # Function scope.
            <class_node>: [(finalizer_fn, ...), exception_info],    # Class scope.
            <module_node>: [(finalizer_fn, ...), exception_info],   # Module scope.
            <session>: [(finalizer_fn, ...), exception_info]        # Session scope.
        }

    When rerunning a test, we want to:

    - Tear down and re-setup function-scoped fixtures for each rerun.
    - Keep higher-scoped fixtures alive across all reruns.

    This approach is inspired by pytest-rerunfailures:
    https://github.com/pytest-dev/pytest-rerunfailures/blob/master/src/pytest_rerunfailures.py#L503-L542
    """

    _debug_logs: typing.List[utils.StructuredLog] = dataclasses.field(
        init=False, default_factory=list
    )

    def prepare_for_session(self, session: _pytest.main.Session) -> None:
        """Choose this mechanism's targets and budget for the session."""
        raise NotImplementedError

    @property
    def targeted_tests(self) -> typing.Set[str]:
        """The tests this mechanism will rerun this session.

        Public because the mechanisms have to agree on who reruns what: two of
        them driving one test would double-spend and hand a single finalizer
        stack to two owners.
        """
        return set(self._tests_to_process)

    def try_fill_metrics_from_report(self, report: _pytest.reports.TestReport) -> None:
        test = report.nodeid

        if report.outcome == "skipped" and not self.has_test_executed(test):
            # Remove metrics for skipped tests. Setup phase may have passed and
            # initialized metrics before call phase was skipped.
            #
            # Only before the test starts being rerun: from then on the metrics
            # drive the rerun loop and the finalizer bookkeeping, so dropping
            # them mid-loop crashes the session and strands the finalizers
            # suspended for this test. A skip during a rerun is instead recorded
            # like any other outcome, so it counts towards the execution limit.
            self._test_metrics.pop(test, None)
            return

        if test not in self._tests_to_process:
            return

        if len(test) > self._context.max_test_name_length:
            self._over_length_tests.add(test)
            return

        if test not in self._test_metrics:
            if report.when != "setup":
                # Metrics have been removed (e.g. for a skipped test), do nothing.
                return

            # Initialize metrics after setup phase.
            self._test_metrics[test] = TestMetrics()

        self._test_metrics[test].fill_from_report(report)

    def has_test_deadline(self, test: str) -> bool:
        """Whether a deadline was already computed for this test."""
        metrics = self._test_metrics.get(test)

        return metrics is not None and metrics.deadline is not None

    @property
    def executions_needed_to_answer(self) -> int:
        """How many executions this mechanism must fit before it is worth starting.

        A mechanism that learns from a test needs a sample; one that only has
        to see the test pass once needs a single attempt.
        """
        return self._context.min_test_execution_count

    def decide_test_is_too_slow(self, test: str) -> bool:
        """
        Decide whether the test can still be rerun enough times before its
        deadline, and remember the answer.

        The answer is only ever taken once. The estimate grows as the test runs
        while the time left shrinks, so deciding again later can flip to `True`
        after finalizers were already suspended for a rerun that then never
        happens, leaving them stranded.
        """
        metrics = self._test_metrics[test]
        metrics.too_slow = (
            metrics.initial_duration * self.executions_needed_to_answer
            > metrics.remaining_time()
        )

        return metrics.too_slow

    def is_test_too_slow(self, test: str) -> bool:
        """The decision taken at the test's first teardown."""
        return self._test_metrics[test].too_slow

    def has_test_executed(self, test: str) -> bool:
        """Whether this mechanism tracks the test and it has completed at
        least one execution — the point from which it may be rerun."""
        return (
            metrics := self._test_metrics.get(test)
        ) is not None and metrics.rerun_count >= 1

    def flag_last_rerun(self, test: str) -> None:
        """Record whether the rerun about to start is the last one for this test."""
        self._test_metrics[test].is_last_rerun = self._reached_rerun_limit(test)

    def is_on_last_rerun(self, test: str) -> bool:
        """Whether the rerun in progress was flagged as the last one."""
        metrics = self._test_metrics.get(test)

        return metrics is not None and metrics.is_last_rerun

    def _reached_rerun_limit(self, test: str) -> bool:
        metrics = self._test_metrics[test]

        will_exceed_deadline = metrics.will_exceed_deadline()
        # `rerun_count` counts executions, initial run included, and this is
        # checked before the rerun it guards. The rerun about to happen is
        # therefore the last permitted one when it is the one reaching the cap.
        will_exceed_rerun_count = (
            metrics.rerun_count + 1 >= self._context.max_test_execution_count
        )

        self._debug_logs.append(
            utils.StructuredLog.make(
                message="Check for last rerun",
                test=test,
                deadline=metrics.deadline.isoformat() if metrics.deadline else None,
                rerun_count=metrics.rerun_count,
                will_exceed_deadline=will_exceed_deadline,
                will_exceed_rerun_count=will_exceed_rerun_count,
            )
        )

        return will_exceed_deadline or will_exceed_rerun_count

    def set_test_deadline(
        self, test: str, timeout: typing.Optional[datetime.timedelta] = None
    ) -> None:
        metrics = self._test_metrics[test]

        if self._is_xdist:
            # Static allocation: equal share of total budget per test.
            per_test_budget = (
                self._available_budget_duration / self.tests_sharing_budget
            )
            metrics.deadline = (
                datetime.datetime.now(datetime.timezone.utc) + per_test_budget
            )
            self._debug_logs.append(
                utils.StructuredLog.make(
                    message="Deadline set",
                    test=test,
                    available_budget=str(self._available_budget_duration),
                    is_xdist=True,
                    all_tests=self.tests_sharing_budget,
                )
            )
        else:
            remaining_budget = self._get_remaining_budget_duration()
            remaining_tests = self._count_remaining_tests()

            # Distribute remaining budget equally across remaining tests.
            metrics.deadline = datetime.datetime.now(datetime.timezone.utc) + (
                remaining_budget / remaining_tests
            )
            self._debug_logs.append(
                utils.StructuredLog.make(
                    message="Deadline set",
                    test=test,
                    available_budget=str(self._available_budget_duration),
                    remaining_budget=str(remaining_budget),
                    all_tests=len(self._tests_to_process),
                    remaining_tests=remaining_tests,
                )
            )

        if not timeout:
            return

        # Leave a margin of 10 %. Better safe than sorry. We don't want to crash
        # the CI.
        safe_timeout = timeout * 0.9
        timeout_deadline = datetime.datetime.now(datetime.timezone.utc) + safe_timeout
        if not metrics.deadline or timeout_deadline < metrics.deadline:
            metrics.deadline = timeout_deadline
            metrics.prevented_timeout = True
            self._debug_logs.append(
                utils.StructuredLog.make(
                    message="Deadline updated to prevent timeout",
                    test=test,
                    timeout=str(timeout),
                    safe_timeout=str(safe_timeout),
                    deadline=metrics.deadline.isoformat() if metrics.deadline else None,
                )
            )

    def suspend_item_finalizers(self, item: _pytest.nodes.Item) -> None:
        """
        Suspend all finalizers except the ones at the function-level.

        See: https://github.com/pytest-dev/pytest-rerunfailures/blob/master/src/pytest_rerunfailures.py#L532-L538
        """

        if item not in item.session._setupstate.stack:
            return

        for stacked_item in list(item.session._setupstate.stack.keys()):
            if stacked_item == item:
                continue

            if stacked_item not in self._suspended_item_finalizers:
                self._suspended_item_finalizers[stacked_item] = (
                    item.session._setupstate.stack[stacked_item]
                )
            del item.session._setupstate.stack[stacked_item]

    def restore_item_finalizers(self, item: _pytest.nodes.Item) -> None:
        """
        Restore previously suspended finalizers.

        See: https://github.com/pytest-dev/pytest-rerunfailures/blob/master/src/pytest_rerunfailures.py#L540-L542
        """

        item.session._setupstate.stack.update(self._suspended_item_finalizers)
        self._suspended_item_finalizers.clear()

    def to_serializable_metrics(self) -> typing.Dict[str, typing.Any]:
        """Serialize metrics for transport via xdist workeroutput."""
        return {
            "available_budget_duration_ms": self._available_budget_duration.total_seconds()
            * 1000,
            "test_metrics": {
                test: {
                    "rerun_count": metrics.rerun_count,
                    "total_duration_ms": metrics.total_duration.total_seconds() * 1000,
                    "rerun_duration_ms": metrics.rerun_duration.total_seconds() * 1000,
                    "initial_setup_duration_ms": metrics.initial_setup_duration.total_seconds()
                    * 1000,
                    "initial_call_duration_ms": metrics.initial_call_duration.total_seconds()
                    * 1000,
                    "initial_teardown_duration_ms": metrics.initial_teardown_duration.total_seconds()
                    * 1000,
                    "prevented_timeout": metrics.prevented_timeout,
                }
                for test, metrics in self._test_metrics.items()
            },
            "over_length_tests": list(self._over_length_tests),
            "debug_logs": [
                {
                    "timestamp": log.timestamp.isoformat(),
                    "message": log.message,
                    **log.attributes,
                }
                for log in self._debug_logs
            ],
        }

    @property
    def tests_sharing_budget(self) -> int:
        """How many tests the budget has to stretch over.

        The targeted set for a mechanism that reruns every test it targets. One
        that only reruns the tests that fail has to answer differently, or it
        divides the budget by a population it will never spend it on.
        """
        return max(len(self._tests_to_process), 1)

    def _count_remaining_tests(self) -> int:
        already_processed_tests = {
            test for test, metrics in self._test_metrics.items() if metrics.deadline
        }

        return max(self.tests_sharing_budget - len(already_processed_tests), 1)

    def _get_used_budget_duration(self) -> datetime.timedelta:
        return sum(
            (metrics.rerun_duration for metrics in self._test_metrics.values()),
            datetime.timedelta(),
        )

    def _get_remaining_budget_duration(self) -> datetime.timedelta:
        return max(
            self._available_budget_duration - self._get_used_budget_duration(),
            datetime.timedelta(),
        )


def mergify_marker_disables(item: _pytest.nodes.Item, option: str) -> bool:
    """Whether a test opted out of one mechanism via `@pytest.mark.mergify`.

    Each mechanism reads its own keyword: opting out of learning from a test is
    not the same statement as refusing to have its failure retried.
    """
    marker = item.get_closest_marker("mergify")
    return marker is not None and marker.kwargs.get(option, True) is False
