import dataclasses
import json
import os
import typing

import _pytest
import _pytest.main
import _pytest.nodes
import _pytest.reports

from pytest_mergify import rerun, utils


@dataclasses.dataclass
class FlakyDetector(rerun.RerunLoop):
    """Reruns a targeted set of tests to learn how reliably they pass.

    Observational by design: it spends its budget on tests it wants to know
    more about, whatever they did on their first attempt, and never changes
    what the session reports.
    """

    mode: typing.Literal["new", "unhealthy"]

    @classmethod
    def from_context_dict(
        cls,
        context_dict: typing.Dict[str, typing.Any],
        mode: typing.Literal["new", "unhealthy"],
        is_xdist: bool,
    ) -> "FlakyDetector":
        """Construct from the serialized context dict fetched by the binding.

        Used both on the controller (the freshly fetched context, dynamic
        budget) and on an xdist worker (the context forwarded through
        `workerinput`, static budget).
        """
        return cls(
            mode=mode,
            _context=rerun.RunContext(**context_dict),
            _is_xdist=is_xdist,
        )

    def prepare_for_session(self, session: _pytest.main.Session) -> None:
        tests_in_session = {item.nodeid for item in session.items}
        existing_tests_in_session = [
            test
            for test in self._context.existing_test_names
            if test in tests_in_session
        ]

        excluded_tests = {
            item.nodeid
            for item in session.items
            if rerun.mergify_marker_disables(item, "flaky_detection")
        }

        if self.mode == "new":
            self._tests_to_process = [
                test
                for test in tests_in_session
                if test not in existing_tests_in_session and test not in excluded_tests
            ]
        elif self.mode == "unhealthy":
            self._tests_to_process = [
                test
                for test in tests_in_session
                if test in self._context.unhealthy_test_names
                and test not in excluded_tests
            ]

        if self.mode == "new":
            budget_ratio = self._context.budget_ratio_for_new_tests
        elif self.mode == "unhealthy":
            budget_ratio = self._context.budget_ratio_for_unhealthy_tests

        total_duration = self._context.existing_tests_mean_duration * len(
            existing_tests_in_session
        )

        # We want to ensure a minimum duration even for very short test suites.
        self._available_budget_duration = max(
            budget_ratio * total_duration,
            self._context.min_budget_duration,
        )

    def make_report(self) -> str:
        """Generate terminal report by delegating to the shared report function."""
        serialized = self.to_serializable_metrics()
        return make_report_from_aggregated(
            context_dict=dataclasses.asdict(self._context),
            mode=self.mode,
            available_budget_duration_ms=self._available_budget_duration.total_seconds()
            * 1000,
            aggregated_metrics=serialized,
        )


@dataclasses.dataclass
class XdistFlakyDetectionController:
    """Manages flaky detection state on the xdist controller side."""

    _context_dict: typing.Optional[typing.Dict[str, typing.Any]] = dataclasses.field(
        default=None
    )
    _mode: typing.Optional[str] = dataclasses.field(default=None)
    _aggregated_metrics: typing.Dict[str, typing.Any] = dataclasses.field(
        default_factory=lambda: {
            "test_metrics": {},
            "over_length_tests": [],
            "debug_logs": [],
        }
    )
    _available_budget_duration_ms: float = dataclasses.field(default=0.0)

    def set_context(
        self,
        context_dict: typing.Dict[str, typing.Any],
        mode: typing.Optional[str],
    ) -> None:
        """Hold the run context for distribution to the workers.

        The context travels even when `mode` is `None` -- a repository that
        opted into test retry alone has no flaky detection to run, but its
        workers still need the context retry is built from.
        """
        self._context_dict = context_dict
        self._mode = mode

    @property
    def has_context(self) -> bool:
        return self._context_dict is not None

    @property
    def has_mode(self) -> bool:
        "Whether flaky detection itself ran, so there is a report to write."
        return self._mode is not None

    def populate_workerinput(self, workerinput: typing.Dict[str, typing.Any]) -> None:
        """Add flaky detection context to a worker's input dict."""
        if self._context_dict is not None:
            workerinput["flaky_detection_context"] = self._context_dict
            workerinput["flaky_detection_mode"] = self._mode

    def collect_worker_metrics(
        self, worker_metrics: typing.Dict[str, typing.Any]
    ) -> None:
        """Merge metrics received from a completed worker."""
        self._aggregated_metrics["test_metrics"].update(worker_metrics["test_metrics"])
        self._aggregated_metrics["over_length_tests"].extend(
            worker_metrics["over_length_tests"]
        )
        self._aggregated_metrics["debug_logs"].extend(worker_metrics["debug_logs"])

        # Budget is the same across all workers (deterministic). Use first received.
        if (
            self._available_budget_duration_ms == 0.0
            and "available_budget_duration_ms" in worker_metrics
        ):
            self._available_budget_duration_ms = worker_metrics[
                "available_budget_duration_ms"
            ]

    def make_report(self) -> str:
        """Generate terminal report from aggregated worker data."""
        assert self._context_dict is not None
        mode: typing.Literal["new", "unhealthy"] = (
            self._mode  # type: ignore[assignment]
            if self._mode in ("new", "unhealthy")
            else "new"
        )
        return make_report_from_aggregated(
            context_dict=self._context_dict,
            mode=mode,
            available_budget_duration_ms=self._available_budget_duration_ms,
            aggregated_metrics=self._aggregated_metrics,
        )


def make_report_from_aggregated(
    context_dict: typing.Dict[str, typing.Any],
    mode: typing.Literal["new", "unhealthy"],
    available_budget_duration_ms: float,
    aggregated_metrics: typing.Dict[str, typing.Any],
) -> str:
    """Generate report on the controller from aggregated worker metrics."""
    context = rerun.RunContext(**context_dict)
    test_metrics = aggregated_metrics["test_metrics"]
    over_length_tests = aggregated_metrics["over_length_tests"]
    debug_logs = aggregated_metrics["debug_logs"]

    result = "🐛 Flaky detection"

    if over_length_tests:
        result += (
            f"{os.linesep}- Skipped {len(over_length_tests)} "
            f"test{'s' if len(over_length_tests) > 1 else ''}:"
        )
        for test in sorted(over_length_tests):
            result += (
                f"{os.linesep}    • '{test}' has not been tested multiple times because the name of the test "
                f"exceeds our limit of {context.max_test_name_length} characters"
            )

    if not test_metrics:
        result += f"{os.linesep}- No {mode} tests detected, but we are watching 👀"
        return result

    available_budget_seconds = available_budget_duration_ms / 1000
    used_budget_ms = sum(m["rerun_duration_ms"] for m in test_metrics.values())
    used_budget_seconds = used_budget_ms / 1000
    if available_budget_seconds > 0:
        result += (
            f"{os.linesep}- Used {used_budget_seconds / available_budget_seconds * 100:.2f} % of the budget "
            f"({used_budget_seconds:.2f} s/{available_budget_seconds:.2f} s)"
        )
    else:
        result += f"{os.linesep}- Used {used_budget_seconds:.2f} s (budget unavailable)"

    result += (
        f"{os.linesep}- Active for {len(test_metrics)} {mode} "
        f"test{'s' if len(test_metrics) > 1 else ''}:"
    )
    for test, m in sorted(test_metrics.items()):
        if m["rerun_count"] < context.min_test_execution_count:
            result += (
                f"{os.linesep}    • '{test}' is too slow to be tested at least "
                f"{context.min_test_execution_count} times within the budget"
            )
            continue

        rerun_duration_seconds = m["rerun_duration_ms"] / 1000
        if available_budget_seconds > 0:
            result += (
                f"{os.linesep}    • '{test}' has been tested {m['rerun_count']} "
                f"time{'s' if m['rerun_count'] > 1 else ''} using approx. "
                f"{rerun_duration_seconds / available_budget_seconds * 100:.2f} % of the budget "
                f"({rerun_duration_seconds:.2f} s/{available_budget_seconds:.2f} s)"
            )
        else:
            result += (
                f"{os.linesep}    • '{test}' has been tested {m['rerun_count']} "
                f"time{'s' if m['rerun_count'] > 1 else ''} "
                f"({rerun_duration_seconds:.2f} s)"
            )

    tests_prevented_from_timeout = sorted(
        test for test, m in test_metrics.items() if m["prevented_timeout"]
    )
    if tests_prevented_from_timeout:
        result += (
            f"{os.linesep}⚠️ Reduced reruns for the following "
            f"test{'s' if len(tests_prevented_from_timeout) > 1 else ''} to respect 'pytest-timeout':"
        )
        for test in tests_prevented_from_timeout:
            result += f"{os.linesep}    • '{test}'"

        result += (
            f"{os.linesep}To improve flaky detection and prevent fixture-level timeouts from limiting reruns, enable function-only timeouts. "
            f"Reference: https://github.com/pytest-dev/pytest-timeout?tab=readme-ov-file#avoiding-timeouts-in-fixtures"
        )

    if utils.is_env_true("PYTEST_MERGIFY_DEBUG") and debug_logs:
        result += f"{os.linesep}🔎 Debug Logs"
        for log in debug_logs:
            result += f"{os.linesep}{json.dumps(log)}"

    return result
