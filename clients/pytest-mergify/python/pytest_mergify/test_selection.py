import dataclasses
import typing

import _pytest.config
import _pytest.nodes


@dataclasses.dataclass
class TestSelection:
    """Whether this run should execute only a subset of tests.

    A merge-queue rerun (a `max_checks_retries` attempt or a bisection step)
    only needs to replay the tests that failed on the previous attempt.
    Mergify resolves that server-side from the run's own identity (queue
    branch + head SHA + job); the bundled binding
    (`CiApiClient.fetch_test_selection`) fetches the answer and it is injected
    here. Every error, timeout, or unknown situation degrades to running the
    full suite — this feature can only remove work, never correctness.
    """

    selection: typing.Literal["full", "subset"] = "full"
    reason: str = "not_requested"
    tests: typing.List[str] = dataclasses.field(default_factory=list)
    init_error_msg: typing.Optional[str] = None
    kept_count: typing.Optional[int] = dataclasses.field(init=False, default=None)
    deselected_count: int = dataclasses.field(init=False, default=0)

    def __post_init__(self) -> None:
        # A subset is only honoured with a non-empty list; anything else (a
        # `full` answer, or a `subset` the server sent empty) runs everything.
        if not (self.selection == "subset" and self.tests):
            self.selection = "full"
            self.tests = []

    def filter_items(
        self,
        config: _pytest.config.Config,
        items: typing.List[_pytest.nodes.Item],
    ) -> None:
        """Reduce the collected items to the served subset, in place.

        Matching is by exact nodeid — the identifiers Mergify serves are the
        ones this plugin previously uploaded. Served names absent from the
        collection are ignored; if NOTHING matches (e.g. the tests were
        renamed since the previous attempt), the full suite runs — an empty
        reduced run would turn green without testing anything.
        """
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

    def report(self) -> str:
        report_str = f"""✂️ Test selection
- Selection: {self.selection} (reason: {self.reason})
"""
        if self.selection == "subset" and self.kept_count is not None:
            report_str += f"- Reduced rerun: executing {self.kept_count} previously-failing test(s), {self.deselected_count} deselected\n"
        return report_str
