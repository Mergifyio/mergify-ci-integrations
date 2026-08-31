import dataclasses
import typing

import _pytest.pytester
import pytest

import pytest_mergify
from pytest_mergify import test_selection
from tests import conftest


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


# The lifecycle above is unit-level. What follows runs the plugin over a real
# collection, because the one thing unit tests cannot show is *when* the
# selection is asked for: the request carries the fingerprint of the collected
# tests, so it can only happen once they are collected.


def _run_with_selection(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    code: str,
    *args: str,
    served: typing.Optional[typing.Dict[str, typing.Any]] = None,
    error: typing.Optional[str] = None,
    setenv: typing.Optional[typing.Dict[str, typing.Optional[str]]] = None,
) -> typing.Tuple[
    _pytest.pytester.RunResult,
    pytest_mergify.PytestMergify,
    typing.List[typing.Dict[str, str]],
]:
    """Run `code` under the plugin, in a CI whose job coordinates are complete.

    Returns the run's result, the plugin instance (for what it ended up holding)
    and the test-selection fetches it made.
    """
    conftest.set_test_environment(monkeypatch)
    # The coordinates the selection is keyed on. `set_test_environment` gives a
    # PR context but no head SHA and no job, which on its own is the "do not
    # ask" case.
    monkeypatch.setenv("GITHUB_HEAD_REF", "queue/main/42")
    monkeypatch.setenv("GITHUB_SHA", "cafecafe")
    monkeypatch.setenv("GITHUB_WORKFLOW", "CI")
    monkeypatch.setenv("GITHUB_JOB", "unit")
    for key, value in (setenv or {}).items():
        if value is None:
            monkeypatch.delenv(key, raising=False)
        else:
            monkeypatch.setenv(key, value)

    calls: typing.List[typing.Dict[str, str]] = []
    conftest.install_fake_api_client(
        monkeypatch,
        test_selection=served,
        test_selection_error=error,
        test_selection_calls=calls,
    )

    pytester.makepyfile(code)
    plugin = pytest_mergify.PytestMergify()
    result = pytester.runpytest_inprocess(*args, plugins=[plugin])
    return result, plugin, calls


_TWO_TESTS = """
    def test_kept():
        pass

    def test_filtered_out():
        pass
"""


def test_the_request_carries_the_fingerprint_of_what_was_collected(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # `-k` deselects one of the two tests before this plugin sees the
    # collection. The fingerprint therefore has to be the surviving test's
    # alone: it describes the set this run intends to execute, which is also
    # the set it will upload.
    result, _, calls = _run_with_selection(
        pytester,
        monkeypatch,
        _TWO_TESTS,
        "-k",
        "kept",
        served={"selection": "full", "reason": "no_predecessor", "tests": []},
    )

    result.assert_outcomes(passed=1, deselected=1)
    (call,) = calls
    assert call["collection_fingerprint"] == conftest.collection_fingerprint(
        ["test_the_request_carries_the_fingerprint_of_what_was_collected.py::test_kept"]
    )
    # And it is the run's own identity that keys it, unchanged by the move.
    assert call["branch"] == "queue/main/42"
    assert call["head_sha"] == "cafecafe"
    assert call["pipeline_name"] == "CI"
    assert call["job_name"] == "unit"


def test_the_fingerprint_is_reported_with_the_run(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Reported as a resource attribute even on a run that never gets a subset,
    # since the engine needs it to answer the *next* run's request.
    result, plugin, _ = _run_with_selection(
        pytester,
        monkeypatch,
        _TWO_TESTS,
        served={"selection": "full", "reason": "no_predecessor", "tests": []},
    )

    result.assert_outcomes(passed=2)
    resource = plugin.mergify_ci.resource_attributes
    assert resource is not None
    assert resource["test.collection.fingerprint"] == conftest.collection_fingerprint(
        [
            "test_the_fingerprint_is_reported_with_the_run.py::test_kept",
            "test_the_fingerprint_is_reported_with_the_run.py::test_filtered_out",
        ]
    )


def test_the_fingerprint_is_reported_even_when_nothing_is_asked(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The kill switch stops the request, not the reporting: the two are
    # independent, and a run whose selection was disabled still has to leave the
    # engine able to answer for the run after it.
    result, plugin, calls = _run_with_selection(
        pytester,
        monkeypatch,
        _TWO_TESTS,
        setenv={"MERGIFY_TEST_SELECTION_DISABLE": "true"},
    )

    result.assert_outcomes(passed=2)
    assert calls == []
    assert plugin.mergify_ci.test_selection is None
    resource = plugin.mergify_ci.resource_attributes
    assert resource is not None
    assert "test.collection.fingerprint" in resource


def test_incomplete_job_coordinates_ask_for_nothing(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Unchanged by the move: without the coordinates the answer is keyed on,
    # there is no question to ask, and no test-selection block to report.
    result, plugin, calls = _run_with_selection(
        pytester,
        monkeypatch,
        _TWO_TESTS,
        setenv={"GITHUB_JOB": None, "MERGIFY_TEST_JOB_NAME": None},
    )

    result.assert_outcomes(passed=2)
    assert calls == []
    assert plugin.mergify_ci.test_selection is None


def test_a_served_subset_reduces_the_run(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    result, plugin, calls = _run_with_selection(
        pytester,
        monkeypatch,
        _TWO_TESTS,
        served={
            "selection": "subset",
            "reason": "queue_rerun",
            "tests": ["test_a_served_subset_reduces_the_run.py::test_kept"],
        },
    )

    result.assert_outcomes(passed=1, deselected=1)
    assert len(calls) == 1
    assert plugin.mergify_ci.test_selection is not None
    assert plugin.mergify_ci.test_selection.selection == "subset"
    # The fingerprint describes the collection as it was *before* the subset
    # narrowed it -- the question, not the answer. It has to be the same value
    # on the request and on the run's own results: it is what Mergify stores to
    # answer the NEXT attempt, which will collect the whole suite again, not the
    # subset this one ran. Reporting the reduced set instead would make every
    # successor miss.
    whole_collection = conftest.collection_fingerprint(
        [
            "test_a_served_subset_reduces_the_run.py::test_kept",
            "test_a_served_subset_reduces_the_run.py::test_filtered_out",
        ]
    )
    assert calls[0]["collection_fingerprint"] == whole_collection
    resource = plugin.mergify_ci.resource_attributes
    assert resource is not None
    assert resource["test.collection.fingerprint"] == whole_collection


def test_a_failed_request_runs_the_full_suite(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Unchanged by the move: the request now happens mid-collection, where an
    # unhandled error would be an INTERNALERROR rather than a degraded run.
    result, plugin, _ = _run_with_selection(
        pytester,
        monkeypatch,
        _TWO_TESTS,
        error="Mergify API returned HTTP 500",
    )

    result.assert_outcomes(passed=2)
    assert plugin.mergify_ci.test_selection is not None
    assert plugin.mergify_ci.test_selection.selection == "full"
    result.stdout.fnmatch_lines(["*the full test suite will run*HTTP 500*"])


def test_an_xdist_worker_reports_no_fingerprint(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A worker collects the whole suite and executes a share of it, so its
    # collection is not the set it ran. Claiming the fingerprint would give
    # every worker of one run the same identity over partial results -- and a
    # worker that never uploaded would leave its siblings looking complete and
    # green. Nothing is lost by staying silent: selection is off under `-n`
    # anyway (MRGFY-8632).
    result, plugin, calls = _run_with_selection(
        pytester,
        monkeypatch,
        _TWO_TESTS,
        setenv={"PYTEST_XDIST_WORKER": "gw0"},
    )

    result.assert_outcomes(passed=2)
    assert calls == []
    resource = plugin.mergify_ci.resource_attributes
    assert resource is not None
    assert "test.collection.fingerprint" not in resource
