import dataclasses
import os
import typing

import _pytest.nodes
import pytest


@dataclasses.dataclass
class Quarantine:
    """The quarantined tests for a run, and the pytest integration around them.

    The list is fetched by the bundled binding (`CiApiClient.fetch_quarantine`)
    and injected here; this type only holds it, decides membership, and marks
    the matching items xfail. `init_error_msg` carries a fetch failure through
    to the terminal report.
    """

    repo_name: str
    branch_name: str
    quarantined_tests: typing.List[str] = dataclasses.field(default_factory=list)
    init_error_msg: typing.Optional[str] = None
    quarantine_used_by_tests: typing.Set[str] = dataclasses.field(
        init=False, default_factory=set
    )

    def __contains__(self, item: _pytest.nodes.Item) -> bool:
        return item.nodeid in self.quarantined_tests

    def quarantined_tests_report(self) -> str:
        report_str = f"""🛡️ Quarantine
- Repository: {self.repo_name}
- Branch: {self.branch_name}
- Quarantined tests fetched from API: {len(self.quarantined_tests)}
"""

        if self.quarantine_used_by_tests:
            report_str += f"""
- 🔒 Quarantined:
    · {f"{os.linesep}    · ".join(sorted(self.quarantine_used_by_tests))}
"""

        unused_quarantined_tests = (
            set(self.quarantined_tests) - self.quarantine_used_by_tests
        )
        if unused_quarantined_tests:
            report_str += f"""
- Unused quarantined tests:
    · {f"{os.linesep}    · ".join(sorted(unused_quarantined_tests))}
"""

        return report_str

    def mark_test_as_quarantined(self, test_item: _pytest.nodes.Item) -> None:
        test_item.add_marker(
            pytest.mark.xfail(
                reason="Test is quarantined from Mergify Test Insights",
                raises=None,
                run=True,
                strict=False,
            ),
            append=True,
        )
        self.quarantine_used_by_tests.add(test_item.nodeid)
