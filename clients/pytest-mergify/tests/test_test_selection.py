import dataclasses
import typing

import pytest

from pytest_mergify import test_selection


# The fetch itself (query, 402/404 -> dormant, polymorphic decode) is unit-tested
# in Rust (mergify-ci-api). Here we cover the client-side lifecycle: the
# subset/full normalisation and the in-place collection filtering.


@dataclasses.dataclass
class FakeItem:
    nodeid: str


class FakeHook:
    def __init__(self) -> None:
        self.deselected: typing.List[FakeItem] = []

    def pytest_deselected(self, items: typing.List[FakeItem]) -> None:
        self.deselected.extend(items)


@dataclasses.dataclass
class FakeConfig:
    hook: FakeHook = dataclasses.field(default_factory=FakeHook)


def test_subset_is_applied_to_the_collection() -> None:
    selection = test_selection.TestSelection(
        selection="subset",
        reason="reduced_rerun",
        tests=["tests/a.py::test_broken", "tests/b.py::test_gone"],
    )
    assert selection.selection == "subset"

    items = [
        FakeItem("tests/a.py::test_broken"),
        FakeItem("tests/a.py::test_fine"),
        FakeItem("tests/c.py::test_other"),
    ]
    config = FakeConfig()
    selection.filter_items(config, items)  # type: ignore[arg-type]

    assert [item.nodeid for item in items] == ["tests/a.py::test_broken"]
    assert [item.nodeid for item in config.hook.deselected] == [
        "tests/a.py::test_fine",
        "tests/c.py::test_other",
    ]
    assert selection.kept_count == 1
    assert selection.deselected_count == 2


def test_subset_matching_nothing_falls_back_to_full() -> None:
    selection = test_selection.TestSelection(
        selection="subset",
        reason="reduced_rerun",
        tests=["tests/renamed.py::test_gone"],
    )

    items = [FakeItem("tests/a.py::test_fine")]
    config = FakeConfig()
    selection.filter_items(config, items)  # type: ignore[arg-type]

    assert selection.selection == "full"
    assert selection.reason == "subset_matched_no_collected_test"
    assert [item.nodeid for item in items] == ["tests/a.py::test_fine"]
    assert config.hook.deselected == []


def test_full_response_leaves_the_collection_untouched() -> None:
    selection = test_selection.TestSelection(selection="full", reason="no_predecessor")

    items = [FakeItem("tests/a.py::test_fine")]
    config = FakeConfig()
    selection.filter_items(config, items)  # type: ignore[arg-type]

    assert selection.selection == "full"
    assert selection.reason == "no_predecessor"
    assert len(items) == 1
    assert config.hook.deselected == []


def test_subset_without_tests_normalises_to_full() -> None:
    # A `subset` answer is only honoured with a non-empty list. An engine
    # predating the polymorphic response still sends `tests: []`; that stays a
    # plain `full` answer rather than a subset that would deselect everything.
    selection = test_selection.TestSelection(
        selection="subset", reason="reduced_rerun", tests=[]
    )

    assert selection.selection == "full"
    assert selection.tests == []


@pytest.mark.parametrize("served", ["empty", "a-variant-this-client-predates"])
def test_an_unrecognised_selection_runs_everything(served: str) -> None:
    # The server may answer with a `selection` this client predates -- `empty`
    # ("run no test, the predecessor already ran them and they passed") is the
    # first one. Anything the client cannot reason about must become "run the
    # full suite", never "run nothing": skipping tests on a value we do not
    # understand is the one outcome that loses coverage, and it would do so
    # silently, on a run that reports green.
    #
    # The annotation is a `Literal`, but the value crosses the wire as a plain
    # string (the binding hands over a `Dict[str, Any]`), so this is the shape
    # an out-of-date client actually receives.
    selection = test_selection.TestSelection(selection=served, reason="whatever")  # type: ignore[arg-type]
    assert selection.selection == "full"
