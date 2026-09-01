import dataclasses
import typing

import _pytest.config
import _pytest.nodes
import pytest


# What a refusal says when the server sent no wording of its own. The copy
# belongs to the server -- it can be corrected there without publishing a
# client, and it alone knows which job it is talking about -- so this is a
# fallback, not the message.
#
# Written for someone who has jobs and runs, not for someone who knows how
# Mergify stores them: "test session", "previous attempt" and "the run this one
# continues" are our vocabulary, and a reader meeting them in a red build
# learns nothing. So it opens with what happened to THEM, then why, then the
# fix with its documentation, then the way out when the fix does not apply.
#
# It still asserts no cause. A build matrix is the likely producer of several
# runs under one name, not the only one -- a job rerun on the same revision
# leaves the same signature, and renaming per matrix leg would not fix it.
# Hence the condition on the remedy, and the last line.
#
# It names no job, unlike the server's message, which formats one in: the
# plugin would have to carry the job name on every answer to enrich a string
# that renders only if the marshalling loses `message` -- a field on every
# answer to improve one that is not supposed to appear.
FALLBACK_REFUSAL_MESSAGE = (
    "Mergify Test Selection stopped this run.\n"
    "\n"
    "Several runs of this job report to Mergify under the same name, and they"
    " run the same tests — so Mergify cannot tell which one this run repeats,"
    " and it will not guess which tests to skip.\n"
    "\n"
    "If this job runs more than once (a build matrix, for example), give each"
    " run its own name with MERGIFY_TEST_JOB_NAME:\n"
    "https://docs.mergify.com/ci-insights/test-frameworks/pytest/\n"
    "\n"
    "If this job only runs once, this is unexpected — please contact Mergify"
    " support."
)


@dataclasses.dataclass
class TestSelection:
    """Whether this run should execute only a subset of tests.

    A merge-queue rerun (a `max_checks_retries` attempt or a bisection step)
    only needs to replay the tests that failed on the previous attempt.
    Mergify resolves that server-side from the run's own identity (queue
    branch + head SHA + job) AND from the fingerprint of what this run
    collected -- a subset is only safe to serve to a run that collects the same
    tests the previous attempt did, so the request cannot be made before the
    collection is known. The bundled binding
    (`CiApiClient.fetch_test_selection`) fetches the answer and it is injected
    here.

    Four answers are understood:

    * `full` -- run everything.
    * `subset` -- run only `tests`.
    * `empty` -- run nothing: the predecessor's attempt of this job already ran
      these tests and they passed. The run exits green having executed none of
      them, and still uploads its session.
    * `refused` -- Mergify holds several candidate sessions for this job and
      will not guess between them. The run FAILS, showing the server's own
      explanation (`message`), or `FALLBACK_REFUSAL_MESSAGE` if it sent none.

    Every error, timeout, and every answer outside that list degrades to
    running the full suite — the feature can remove work, never correctness,
    and a client is routinely older than the server it talks to.
    """

    selection: typing.Literal["full", "subset", "empty", "refused"] = "full"
    reason: str = "not_requested"
    tests: typing.List[str] = dataclasses.field(default_factory=list)
    # What the server wants shown to the CI user about this answer, when it has
    # something to say -- today only a refusal does. Shown verbatim: the wording
    # is the server's so it can be improved without publishing a client.
    message: typing.Optional[str] = None
    init_error_msg: typing.Optional[str] = None
    kept_count: typing.Optional[int] = dataclasses.field(init=False, default=None)
    deselected_count: int = dataclasses.field(init=False, default=0)

    def __post_init__(self) -> None:
        # `empty` and `refused` are answers in themselves and carry no tests.
        # A subset is only honoured with a non-empty list; anything else -- a
        # `full` answer, a `subset` the server sent empty, or a variant this
        # client predates -- runs everything. Acting on a value we cannot
        # reason about is the one outcome that loses coverage silently, on a
        # run that reports green.
        if self.selection in ("empty", "refused"):
            self.tests = []
        elif not (self.selection == "subset" and self.tests):
            self.selection = "full"
            self.tests = []

    def filter_items(
        self,
        config: _pytest.config.Config,
        items: typing.List[_pytest.nodes.Item],
    ) -> None:
        """Apply the served answer to the collected items, in place.

        Matching is by exact nodeid — the identifiers Mergify serves are the
        ones this plugin previously uploaded. Served names absent from the
        collection are ignored; if NOTHING matches (e.g. the tests were
        renamed since the previous attempt), the full suite runs — an empty
        reduced run would turn green without testing anything.

        Raises `pytest.UsageError` on a refusal, which is what fails the run,
        carrying the server's explanation of it.
        """
        if self.selection == "refused":
            # Deliberately not the degradation path. Everywhere else, a shape
            # Mergify cannot resolve costs time and nothing else; here it is
            # Mergify saying it holds several candidate predecessors for this
            # job, which means one job name is standing for several runs. That
            # keeps the reporting wrong for every future attempt, so it has to
            # be seen and fixed rather than absorbed into a full run nobody
            # notices.
            raise pytest.UsageError(self.message or FALLBACK_REFUSAL_MESSAGE)

        if self.selection == "empty":
            self._deselect_everything(config, items)
            return

        if self.selection != "subset":
            return

        subset = set(self.tests)
        kept = [item for item in items if item.nodeid in subset]
        if not kept:
            self.selection = "full"
            self.reason = "subset_matched_no_collected_test"
            return

        deselected = [item for item in items if item.nodeid not in subset]
        if deselected:
            items[:] = kept
            config.hook.pytest_deselected(items=deselected)

        self.kept_count = len(kept)
        self.deselected_count = len(deselected)

    def _deselect_everything(
        self,
        config: _pytest.config.Config,
        items: typing.List[_pytest.nodes.Item],
    ) -> None:
        """Empty the collection through pytest's own deselection path.

        Deselecting rather than stopping the session is what keeps the rest of
        the run intact: the session still finishes, so it still uploads. A
        `pytest.exit` here would be shorter and would make the one job that
        legitimately ran nothing the only one missing from Mergify's reporting.

        A collection that is already empty is left alone, counters included: the
        run is then red for a reason of its own (a `-k` matching nothing), and
        recording an application would have this answer both green that exit
        code and announce a skip over a suite it never emptied.
        """
        if not items:
            return

        self.deselected_count = len(items)
        deselected = list(items)
        items[:] = []
        config.hook.pytest_deselected(items=deselected)

    def report(self) -> str:
        report_str = f"""✂️ Test selection
- Selection: {self.selection} (reason: {self.reason})
"""
        if self.selection == "subset" and self.kept_count is not None:
            report_str += f"- Reduced rerun: executing {self.kept_count} previously-failing test(s), {self.deselected_count} deselected\n"
        elif self.selection == "empty" and self.deselected_count:
            # "selected", not "collected": this hook runs `trylast`, so the
            # count is what survived the user's own filters, and pytest's own
            # header two lines above already spends "collected" on the number
            # before them.
            report_str += f"- Skipped rerun: executing no test, the previous attempt of this job ran all {self.deselected_count} selected test(s) and they passed\n"
        return report_str
