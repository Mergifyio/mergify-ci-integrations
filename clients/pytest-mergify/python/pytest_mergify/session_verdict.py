"""What the session concluded about each test, folded as pytest reports it.

Test Selection answers a merge-queue rerun from its predecessor's verdict: which
tests failed, whether anything ran at all. That used to be read off the
uploaded spans once the trace ingestion queue got to them -- hours later, twice
a day (INC-2434), during which every rerun asking was served the full suite.
The verdict is the same facts, written by the plugin itself in one request
before the trace upload, so the answer is there seconds after the session ends.

The fold here is the one thing the engine no longer does: a test may execute
several times in one session (flaky detection reruns, test retry), and the
verdict carries ONE status per test, its final one. "Final" is not the last
execution -- it is what pytest itself concluded, read off the reports the
plugin let it log:

* a test retry rescued is logged as passed (`_report_held_back_attempt`), and
  is passed here;
* an `unhealthy`-mode rerun is logged as `rerun`, which is not a verdict on
  the test, and is ignored here;
* a `new`-mode rerun that failed is logged as failed -- it is what turned the
  job red -- and the test is failed here even when its last attempt passed.

Deriving from the logged reports rather than from the spans' first-attempt
status is what keeps the verdict and the exit code in agreement: a rerun
served from a verdict that disagrees with the exit code either replays tests
that did not gate, or -- the loss this module exists to prevent -- turns green
having skipped the one that did.
"""

import dataclasses
import typing

import _pytest.reports

# A test's status once the session is over. `quarantined_failed` is a failure
# pytest reported as an expected one (the quarantine marks the item xfail), kept
# apart from `failed` because it did not gate the job, and apart from `skipped`
# because the test did run and did fail: the engine counts it as failed and
# lists it separately, so a rerun neither replays it nor reads it as green.
FinalStatus = typing.Literal["passed", "failed", "skipped", "quarantined_failed"]

# A later report never downgrades an earlier verdict: a test whose setup
# failed and whose teardown passed is failed, one whose call was skipped and
# whose teardown passed is skipped.
_PRECEDENCE: typing.Dict[FinalStatus, int] = {
    "passed": 0,
    "skipped": 1,
    "quarantined_failed": 2,
    "failed": 3,
}


@dataclasses.dataclass
class SessionVerdict:
    """The per-test fold, fed one logged report at a time."""

    _final: typing.Dict[str, FinalStatus] = dataclasses.field(default_factory=dict)
    # Every phase of every attempt, logged or not: the time the job spent on
    # its tests, which is what a reduction saves.
    _runtime_seconds: float = 0.0

    def record_logged_report(
        self, report: _pytest.reports.TestReport, quarantined: bool
    ) -> None:
        """Fold one report pytest was allowed to log into the test's status.

        `quarantined` says whether this plugin marked the item xfail for the
        quarantine, which is the only way an expected failure here is a
        quarantined one -- a user's own `xfail` is an ordinary skip.
        """
        outcome: str = report.outcome
        status: FinalStatus
        if outcome == "failed":
            status = "failed"
        elif outcome == "skipped":
            status = (
                "quarantined_failed"
                if quarantined and hasattr(report, "wasxfail")
                else "skipped"
            )
        elif outcome == "passed" and report.when == "call":
            status = "passed"
        else:
            # A passing setup or teardown says nothing about the test: only
            # its call does, and a session that never reaches one
            # (`--setup-only`) executed nothing a rerun could be answered
            # from. `rerun` is an attempt logged for the terminal's sake, not
            # a verdict.
            return

        previous = self._final.get(report.nodeid)
        if previous is None or _PRECEDENCE[status] > _PRECEDENCE[previous]:
            self._final[report.nodeid] = status

    def record_duration(self, report: _pytest.reports.TestReport) -> None:
        self._runtime_seconds += report.duration

    def add_runtime(self, seconds: float) -> None:
        """Count time measured elsewhere -- a pytest-xdist worker's."""
        self._runtime_seconds += seconds

    @property
    def runtime_seconds(self) -> float:
        return self._runtime_seconds

    @property
    def total_test_runtime_ms(self) -> int:
        return int(self._runtime_seconds * 1000)

    def counts(self) -> typing.Dict[str, int]:
        """The five counts the engine reads, under its own definitions.

        `executed` is every test whose protocol ran -- a marked skip runs its
        setup and logs a skipped report, so it counts -- and `failed` includes
        the quarantined failures, so that `failed == len(failing_tests) +
        len(quarantined_failing_tests)` holds by construction.
        """
        passed = failed = skipped = 0
        for status in self._final.values():
            if status == "passed":
                passed += 1
            elif status == "skipped":
                skipped += 1
            else:
                failed += 1
        return {
            "executed_count": len(self._final),
            "passed_count": passed,
            "failed_count": failed,
            "skipped_count": skipped,
        }

    def failing_tests(self) -> typing.List[str]:
        return [nodeid for nodeid, status in self._final.items() if status == "failed"]

    def quarantined_failing_tests(self) -> typing.List[str]:
        return [
            nodeid
            for nodeid, status in self._final.items()
            if status == "quarantined_failed"
        ]


@dataclasses.dataclass(frozen=True)
class SessionVerdictResult:
    """How sending the verdict went, for the terminal summary.

    `sent` is false both when nothing was sent because nothing had to be (the
    job never asked for a selection, the feature is not enabled for the
    repository) and when the request failed -- `error` tells the two apart.
    """

    sent: bool = False
    # The ids did not fit the request bound, so the counts went out alone and
    # the next rerun of this job is served the full suite.
    truncated: bool = False
    error: typing.Optional[str] = None
