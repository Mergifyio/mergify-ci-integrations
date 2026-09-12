import dataclasses
import textwrap
import typing

import _pytest.pytester
import pytest

import pytest_mergify
from pytest_mergify import ci_insights, test_selection
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


# Stands in for the engine's own copy, which is required on a refusal
# (`web/api/ci_insights/test_selection/types.py`, `AMBIGUOUS_TEST_SESSIONS_MESSAGE`).
# Deliberately not a copy of that text: the plugin shows whatever arrives,
# verbatim, and never reads it -- so a fixture quoting the real wording would
# only give this diff a second wording to keep in step with the server's.
_SERVED_REFUSAL_MESSAGE = "<the explanation the engine wrote, whatever it says>"


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
        FakeItem("tests/b.py::test_gone"),
        FakeItem("tests/a.py::test_fine"),
        FakeItem("tests/c.py::test_other"),
    ]
    config = FakeConfig()
    selection.filter_items(config, items)  # type: ignore[arg-type]

    assert [item.nodeid for item in items] == [
        "tests/a.py::test_broken",
        "tests/b.py::test_gone",
    ]
    assert [item.nodeid for item in config.hook.deselected] == [
        "tests/a.py::test_fine",
        "tests/c.py::test_other",
    ]
    assert selection.kept_count == 2
    assert selection.deselected_count == 2
    # The answer was honoured, so there is nothing for this run to declare
    # about it.
    assert selection.not_applied_reason is None


def test_a_subset_matching_nothing_runs_everything() -> None:
    selection = test_selection.TestSelection(
        selection="subset",
        reason="reduced_rerun",
        tests=["tests/renamed.py::test_gone"],
    )

    items = [FakeItem("tests/a.py::test_fine")]
    config = FakeConfig()
    selection.filter_items(config, items)  # type: ignore[arg-type]

    # What Mergify said survives the run's inability to act on it. The
    # alternative -- rewriting these two with the client's own verdict, which
    # is what this used to do -- destroys the record of what was offered in the
    # single case that would prove the offer was wrong.
    assert selection.selection == "subset"
    assert selection.reason == "reduced_rerun"
    assert selection.not_applied_reason == "subset_matched_no_collected_test"
    assert [item.nodeid for item in items] == ["tests/a.py::test_fine"]
    assert config.hook.deselected == []


def test_a_partly_matched_subset_runs_everything_too() -> None:
    # The shape that used to pass silently: two of the three served tests exist
    # here, so the run would have executed those two, deselected the rest and
    # reported an ordinary reduction. Mergify asked for three tests it believed
    # had failed; a green build over two of them is a verdict nobody gave.
    selection = test_selection.TestSelection(
        selection="subset",
        reason="reduced_rerun",
        tests=[
            "tests/a.py::test_broken",
            "tests/a.py::test_also_broken",
            "tests/renamed.py::test_gone",
        ],
    )

    items = [
        FakeItem("tests/a.py::test_broken"),
        FakeItem("tests/a.py::test_also_broken"),
        FakeItem("tests/a.py::test_fine"),
    ]
    config = FakeConfig()
    selection.filter_items(config, items)  # type: ignore[arg-type]

    assert selection.selection == "subset"
    assert selection.not_applied_reason == "subset_partly_absent_from_collection"
    assert len(items) == 3
    assert config.hook.deselected == []
    # Left unset rather than set to what a reduction would have kept: nothing
    # was reduced, and a count here would size a run that did not happen.
    assert selection.kept_count is None
    assert selection.deselected_count == 0


def test_full_response_leaves_the_collection_untouched() -> None:
    selection = test_selection.TestSelection(selection="full", reason="no_predecessor")

    items = [FakeItem("tests/a.py::test_fine")]
    config = FakeConfig()
    selection.filter_items(config, items)  # type: ignore[arg-type]

    assert selection.selection == "full"
    assert selection.reason == "no_predecessor"
    assert len(items) == 1
    assert config.hook.deselected == []


def test_a_subset_without_tests_runs_everything() -> None:
    # A `subset` answer is only honoured with a non-empty list. Nothing runs
    # everything by saying `subset` with no test in it: verified against the
    # engine, which answers `full` / `job_previously_green` when it has nothing
    # to replay. So this shape runs everything AND is recorded, rather than
    # being read as the `full` answer it resembles.
    selection = test_selection.TestSelection(
        selection="subset", reason="reduced_rerun", tests=[]
    )

    assert selection.selection == "subset"
    assert selection.not_applied_reason == "subset_served_without_tests"
    assert selection.tests == []

    items = [FakeItem("tests/a.py::test_fine")]
    config = FakeConfig()
    selection.filter_items(config, items)  # type: ignore[arg-type]

    assert [item.nodeid for item in items] == ["tests/a.py::test_fine"]
    assert config.hook.deselected == []


@pytest.mark.parametrize(
    "served", ["a-variant-this-client-predates", "partial", "none", ""]
)
def test_an_unrecognised_selection_runs_everything(served: str) -> None:
    # The server may answer with a `selection` this client predates. Anything
    # the client cannot reason about must become "run the full suite", never
    # "run nothing" and never a failure: acting on a value we do not understand
    # is what loses coverage, and it would do so silently, on a run that reports
    # green. This is the property that lets the engine grow new answers without
    # breaking the clients already published -- `empty` and `refused` below were
    # both served through it before this client knew them.
    #
    # The annotation is a `Literal`, but the value crosses the wire as a plain
    # string (the binding hands over a `Dict[str, Any]`), so this is the shape
    # an out-of-date client actually receives.
    selection = test_selection.TestSelection(selection=served, reason="whatever")  # type: ignore[arg-type]

    items = [FakeItem("tests/a.py::test_fine")]
    config = FakeConfig()
    selection.filter_items(config, items)  # type: ignore[arg-type]

    assert [item.nodeid for item in items] == ["tests/a.py::test_fine"]
    assert config.hook.deselected == []
    # Kept verbatim, unrecognised as it is: it is the only evidence of which
    # answer this client was too old for, and rewriting it to `full` would make
    # a plugin left behind by a release indistinguishable from one Mergify told
    # to run everything.
    assert selection.selection == served
    assert selection.not_applied_reason == "unrecognised_selection"


def test_a_honoured_reduction_reports_the_reduction_and_nothing_else() -> None:
    # The feature's happy path, and the block the customer actually reads when
    # it works. The "could not apply" sentence is chosen by a field that is
    # None here; a condition widened by one word would replace this block with
    # that sentence on a run that went perfectly.
    selection = test_selection.TestSelection(
        selection="subset",
        reason="reduced_rerun",
        tests=["tests/a.py::test_broken"],
    )
    items = [FakeItem("tests/a.py::test_broken"), FakeItem("tests/a.py::test_fine")]
    selection.filter_items(FakeConfig(), items)  # type: ignore[arg-type]

    report = selection.report()
    assert "Mergify re-executed only that one and skipped the 1" in report
    assert "  tests/a.py::test_broken\n" in report
    assert "didn't match" not in report


def test_a_duplicated_node_id_cannot_hide_a_missing_served_test() -> None:
    # `pytest --keep-duplicates` collects the same nodeid more than once, on
    # purpose. Counting matched ITEMS against distinct SERVED ids then lets one
    # duplicate cancel one absent test: the run reduces to an arbitrary part of
    # what Mergify asked for and reports an ordinary reduction -- the exact
    # outcome the all-or-nothing rule exists to prevent, reached through the
    # rule's own guard.
    selection = test_selection.TestSelection(
        selection="subset",
        reason="reduced_rerun",
        tests=["tests/a.py::test_broken", "tests/gone.py::test_renamed"],
    )

    items = [
        FakeItem("tests/a.py::test_broken"),
        FakeItem("tests/a.py::test_broken"),
        FakeItem("tests/a.py::test_fine"),
    ]
    config = FakeConfig()
    selection.filter_items(config, items)  # type: ignore[arg-type]

    assert selection.not_applied_reason == "subset_partly_absent_from_collection"
    assert len(items) == 3
    assert config.hook.deselected == []
    assert "didn't match the tests this run collected" in selection.report()


def test_an_empty_selection_deselects_the_whole_collection() -> None:
    selection = test_selection.TestSelection(
        selection="empty", reason="predecessor_job_succeeded"
    )
    # Not normalised away: "run nothing" is an answer, unlike a `subset` that
    # arrived without its tests.
    assert selection.selection == "empty"

    items = [FakeItem("tests/a.py::test_one"), FakeItem("tests/b.py::test_two")]
    config = FakeConfig()
    selection.filter_items(config, items)  # type: ignore[arg-type]

    assert items == []
    # Through pytest's own deselection hook, so the run reports two deselected
    # tests rather than a collection that mysteriously came up empty.
    assert [item.nodeid for item in config.hook.deselected] == [
        "tests/a.py::test_one",
        "tests/b.py::test_two",
    ]
    assert selection.deselected_count == 2
    assert "all 2 tests passed back then. Mergify skipped them" in selection.report()


def test_a_refusal_raises_rather_than_degrading() -> None:
    # The one answer that is not allowed to fall back to a full run: Mergify is
    # saying one job name stands for several runs, which stays wrong for every
    # future attempt until someone changes the configuration.
    selection = test_selection.TestSelection(
        selection="refused",
        reason="ambiguous_test_sessions",
        message=_SERVED_REFUSAL_MESSAGE,
    )
    assert selection.selection == "refused"

    items = [FakeItem("tests/a.py::test_one")]
    config = FakeConfig()
    with pytest.raises(pytest.UsageError) as raised:
        selection.filter_items(config, items)  # type: ignore[arg-type]

    # The server's wording, verbatim. Not a paraphrase and not a client-side
    # string: the server names the job and can be corrected without publishing
    # a plugin, so a client that rewords it goes stale the day it is improved.
    assert str(raised.value) == _SERVED_REFUSAL_MESSAGE
    # And the collection is untouched, so nothing half-applied the answer.
    assert [item.nodeid for item in items] == ["tests/a.py::test_one"]


def test_a_refusal_without_a_message_still_explains_itself() -> None:
    # Not an engine we can point at: `refused` was born carrying a required
    # `message`, so no deployed version serves one without. The branch guards a
    # regression on THIS side -- a `set_item` dropped from the marshalling,
    # exactly the failure the binding's own docstring warns about, which does
    # not break a build and does not fail a test. The run must still fail with
    # something a reader can act on rather than a bare exit code.
    selection = test_selection.TestSelection(
        selection="refused", reason="ambiguous_test_sessions"
    )

    items = [FakeItem("tests/a.py::test_one")]
    config = FakeConfig()
    with pytest.raises(pytest.UsageError) as raised:
        selection.filter_items(config, items)  # type: ignore[arg-type]

    message = str(raised.value)
    assert message == test_selection.FALLBACK_REFUSAL_MESSAGE
    # Says up front that the run was stopped -- the reader's own situation, not
    # a justification of ours -- then the remedy with the page documenting it,
    # then a way out for the cases a rename does not fix, because several runs
    # under one job name is an observation and not a diagnosis of a matrix.
    assert message.startswith("Mergify Test Selection stopped this run.")
    assert "MERGIFY_TEST_JOB_NAME" in message
    # A link that rots or was invented is worse than none: this is the page the
    # repository points at everywhere else, and it documents the variable.
    assert "https://docs.mergify.com/ci-insights/test-frameworks/pytest/" in message
    assert "support" in message


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
    # The opt-in this job would have written in its workflow. Set here rather
    # than per test so what each test below reads is the behaviour it is about;
    # `setenv={...: None}` takes it back for the tests that are about the gate
    # itself.
    monkeypatch.setenv(ci_insights.TEST_SELECTION_ENABLE_ENV, "true")
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
    # The opt-in gates the request, not the reporting: the two are independent,
    # and a run whose job never asked for a selection still has to leave the
    # engine able to answer for the run after it -- including the run where the
    # customer finally opts in.
    result, plugin, calls = _run_with_selection(
        pytester,
        monkeypatch,
        _TWO_TESTS,
        setenv={ci_insights.TEST_SELECTION_ENABLE_ENV: None},
    )

    result.assert_outcomes(passed=2)
    assert calls == []
    assert plugin.mergify_ci.test_selection is None
    resource = plugin.mergify_ci.resource_attributes
    assert resource is not None
    assert "test.collection.fingerprint" in resource


@pytest.mark.parametrize("value", ["false", "0", "off", "", "probably"])
def test_only_an_explicit_yes_asks_for_a_selection(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    value: str,
) -> None:
    # Everything that is not a yes leaves the run alone, including the two
    # shapes a workflow produces by accident: the empty string, which is what
    # `${{ cond && 'true' || '' }}` and an unset `vars.X` come to, and a value
    # nobody can parse. Both mean the customer did not say yes, and this
    # feature does not skip tests on a maybe.
    result, plugin, calls = _run_with_selection(
        pytester,
        monkeypatch,
        _TWO_TESTS,
        setenv={ci_insights.TEST_SELECTION_ENABLE_ENV: value},
        served={
            "selection": "subset",
            "reason": "queue_rerun",
            "tests": ["test_only_an_explicit_yes_asks_for_a_selection.py::test_kept"],
        },
    )

    result.assert_outcomes(passed=2)
    assert calls == []
    assert plugin.mergify_ci.test_selection is None


@pytest.mark.parametrize("value", ["true", " true ", "TRUE", "1", "yes", "on"])
def test_a_yes_asks_for_a_selection_whatever_its_spelling(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    value: str,
) -> None:
    # Surrounding whitespace included: a workflow-level `env:` block feeds jobs
    # of every framework, and a YAML block scalar or a stray trailing space
    # must not opt this job in while leaving the JavaScript ones out. The
    # TypeScript clients trim for the same reason.
    _, _, calls = _run_with_selection(
        pytester,
        monkeypatch,
        _TWO_TESTS,
        setenv={ci_insights.TEST_SELECTION_ENABLE_ENV: value},
        served={"selection": "full", "reason": "no_predecessor", "tests": []},
    )

    assert len(calls) == 1


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
    # The block names the consequence first and keeps the error for support.
    result.stdout.fnmatch_lines(
        [
            "*Mergify couldn't be asked whether this run could be reduced, so the full suite*",
            "ran.",
            "Error: Mergify API returned HTTP 500",
        ]
    )


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
    # And no count: every worker collects the whole suite while executing a
    # fraction of it, so a denominator here would describe a set this session
    # never ran -- the same miscount the fingerprint is withheld to prevent.
    assert "test.collection.count" not in resource


def test_an_empty_selection_runs_nothing_and_exits_green(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The whole point of the answer: the job is red-or-green like any other, and
    # a run that legitimately executed nothing has to be green. pytest's own
    # verdict on an empty collection is exit code 5, so this is the assertion
    # that matters -- `assert_outcomes` alone would pass on a red run.
    result, plugin, calls = _run_with_selection(
        pytester,
        monkeypatch,
        _TWO_TESTS,
        served={
            "selection": "empty",
            "reason": "predecessor_job_succeeded",
            "tests": [],
        },
    )

    assert result.ret == pytest.ExitCode.OK
    result.assert_outcomes(passed=0, failed=0, deselected=2)
    assert len(calls) == 1
    assert plugin.mergify_ci.test_selection is not None
    assert plugin.mergify_ci.test_selection.selection == "empty"
    result.stdout.fnmatch_lines(
        ["*all 2 tests passed back then. Mergify skipped them*"]
    )


def test_an_empty_selection_still_uploads_its_session(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    otlp_collector: conftest.OTLPCollector,
) -> None:
    # The half that disappears in silence if it is forgotten. Running no test is
    # the most visible thing this feature does, so a job that legitimately ran
    # nothing must still show up in Mergify -- otherwise it is the only one
    # missing from the reporting, and it is the one a developer comes asking
    # about. Asserted on the decoded payload rather than on the plugin's own
    # state, because a run can hold a finished session span and have uploaded
    # nothing.
    conftest.configure_upload(monkeypatch, otlp_collector)
    # The coordinates the answer is keyed on, as `_run_with_selection` sets them
    # for the in-process runs above.
    monkeypatch.setenv("GITHUB_HEAD_REF", "queue/main/42")
    monkeypatch.setenv("GITHUB_SHA", "cafecafe")
    monkeypatch.setenv("GITHUB_WORKFLOW", "CI")
    monkeypatch.setenv("GITHUB_JOB", "unit")
    monkeypatch.setenv(ci_insights.TEST_SELECTION_ENABLE_ENV, "true")
    otlp_collector.serve_test_selection(
        {"selection": "empty", "reason": "predecessor_job_succeeded"}
    )
    pytester.makepyfile(_TWO_TESTS)

    result = pytester.runpytest_subprocess()

    assert result.ret == pytest.ExitCode.OK
    result.assert_outcomes(passed=0, deselected=2)
    (batch,) = otlp_collector.batches
    # The session, and only the session: zero test executed is zero test span.
    assert [span.name for span in batch.spans] == ["pytest session start"]
    # And it carries the collection it was answered on, which is what lets
    # Mergify answer the attempt after this one.
    assert batch.resource_attributes[
        "test.collection.fingerprint"
    ] == conftest.collection_fingerprint(
        [
            "test_an_empty_selection_still_uploads_its_session.py::test_kept",
            "test_an_empty_selection_still_uploads_its_session.py::test_filtered_out",
        ]
    )


def test_a_refusal_fails_the_run(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The other answer that must not degrade. A full run here would be the
    # comfortable outcome and the wrong one: nobody would ever learn that this
    # job's name covers several runs, and the reduced reruns would stay off
    # forever with no symptom.
    result, _, calls = _run_with_selection(
        pytester,
        monkeypatch,
        _TWO_TESTS,
        served={
            "selection": "refused",
            "reason": "ambiguous_test_sessions",
            "tests": [],
            "message": _SERVED_REFUSAL_MESSAGE,
        },
    )

    # `USAGE_ERROR`, specifically: the run stops on something the user has to
    # change, which is what pytest's own exit codes call this, and it tells a
    # deliberate refusal apart from the plugin having crashed (`INTERNAL_ERROR`).
    assert result.ret == pytest.ExitCode.USAGE_ERROR
    result.assert_outcomes(passed=0, failed=0)
    assert len(calls) == 1
    # Exactly once: it is the error that stopped the run, and the terminal
    # block printed afterwards points at it rather than repeating it.
    assert (result.stderr.str() + result.stdout.str()).count(
        _SERVED_REFUSAL_MESSAGE
    ) == 1
    assert "Mergify stopped this run before any test ran" in result.stdout.str()


def test_an_empty_selection_over_an_empty_collection_stays_an_error(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # `-k` leaves nothing to run, so pytest's exit code 5 is the honest answer
    # and not something this plugin emptied. Greening it would hide a mistyped
    # filter behind a Mergify answer -- exactly the "green run that tested
    # nothing" the whole feature is built to avoid.
    result, plugin, _ = _run_with_selection(
        pytester,
        monkeypatch,
        _TWO_TESTS,
        "-k",
        "matches-no-test",
        served={
            "selection": "empty",
            "reason": "predecessor_job_succeeded",
            "tests": [],
        },
    )

    assert result.ret == pytest.ExitCode.NO_TESTS_COLLECTED
    assert plugin.mergify_ci.test_selection is not None
    assert plugin.mergify_ci.test_selection.deselected_count == 0
    # And the Mergify section says nothing about a skip: announcing that a
    # previous attempt ran and passed "all 0 selected test(s)" would send whoever
    # is debugging that red job to look at Mergify instead of at their filter.
    assert "Mergify skipped" not in result.stdout.str()
    # Reported all the same, and readable for what it is: the answer arrived,
    # and the counts say no reduction came of it. Zero executed out of zero
    # collected is a run with nothing to run; it is the collected count that
    # keeps it from being read as the reduction the feature just made.
    resource = plugin.mergify_ci.resource_attributes
    assert resource is not None
    assert resource["test.selection.answer"] == "empty"
    assert resource["test.selection.kept_count"] == 0
    assert resource["test.collection.count"] == 0


def test_a_refused_run_uploads_a_session_marked_failed(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    otlp_collector: conftest.OTLPCollector,
) -> None:
    # A refusal produces the same payload shape as an `empty` answer -- one
    # session span, no test span -- and the exit code that tells them apart
    # never leaves the machine. Without a status on the session, Mergify is
    # handed a clean, complete-looking run of a job that in fact refused to run,
    # for a job name it has just said is ambiguous.
    conftest.configure_upload(monkeypatch, otlp_collector)
    monkeypatch.setenv("GITHUB_HEAD_REF", "queue/main/42")
    monkeypatch.setenv("GITHUB_SHA", "cafecafe")
    monkeypatch.setenv("GITHUB_WORKFLOW", "CI")
    monkeypatch.setenv("GITHUB_JOB", "unit")
    monkeypatch.setenv(ci_insights.TEST_SELECTION_ENABLE_ENV, "true")
    otlp_collector.serve_test_selection(
        {
            "selection": "refused",
            "reason": "ambiguous_test_sessions",
            "message": _SERVED_REFUSAL_MESSAGE,
        }
    )
    pytester.makepyfile(_TWO_TESTS)

    result = pytester.runpytest_subprocess()

    assert result.ret == pytest.ExitCode.USAGE_ERROR
    (batch,) = otlp_collector.batches
    (span,) = batch.spans
    assert span.name == "pytest session start"
    assert span.status == "error"
    # And on the wire, not just in the plugin: a refusal raises out of the
    # middle of a collection hook, so it is the path where "the attributes were
    # set" and "the attributes were uploaded" are least obviously the same
    # thing.
    assert batch.resource_attributes["test.selection.answer"] == "refused"
    assert batch.resource_attributes["test.selection.kept_count"] == 0
    assert batch.resource_attributes["test.collection.count"] == 2


# What the run reports about its own reduction. Mergify computes a selection,
# serves it, and keeps nothing: the session is the only place the decision and
# its effect can be read back from, so these assertions are what every reporting
# surface downstream stands on.


def _reported(plugin: pytest_mergify.PytestMergify) -> typing.Dict[str, typing.Any]:
    resource = plugin.mergify_ci.resource_attributes
    assert resource is not None
    return dict(resource)


def test_a_served_subset_reports_what_it_ran_out_of_what_it_collected(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The reduction itself: one of the two collected tests ran. Both counts are
    # reported, rather than the executed one alone, because the engine cannot
    # recover the other -- an ordinary passing test leaves no row behind, so
    # what the run collected is only knowable from the run.
    _, plugin, _ = _run_with_selection(
        pytester,
        monkeypatch,
        _TWO_TESTS,
        served={
            "selection": "subset",
            "reason": "queue_rerun",
            "tests": [
                "test_a_served_subset_reports_what_it_ran_out_of_what_it_collected.py::test_kept"
            ],
        },
    )

    reported = _reported(plugin)
    assert reported["test.selection.answer"] == "subset"
    assert reported["test.selection.reason"] == "queue_rerun"
    assert reported["test.selection.kept_count"] == 1
    assert reported["test.collection.count"] == 2
    # Absent, not "none": counting the runs that could not honour their answer
    # is counting this key, so an honoured run must not carry it at all.
    assert "test.selection.not_applied_reason" not in reported


def test_a_full_answer_reports_the_whole_collection_as_kept(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The unreduced run still describes itself. It is the comparison point every
    # reduction is read against, and the only evidence that a job Mergify was
    # asked about was answered at all -- a run that reports nothing and a run
    # answered `full` are the same silence otherwise.
    _, plugin, _ = _run_with_selection(
        pytester,
        monkeypatch,
        _TWO_TESTS,
        served={"selection": "full", "reason": "no_predecessor", "tests": []},
    )

    reported = _reported(plugin)
    assert reported["test.selection.answer"] == "full"
    assert reported["test.selection.reason"] == "no_predecessor"
    assert reported["test.selection.kept_count"] == 2
    assert reported["test.collection.count"] == 2
    assert "test.selection.not_applied_reason" not in reported


def test_a_refusal_reports_that_it_executed_nothing(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A refusal raises before the collection is touched, so the tests are all
    # still there to be counted while none of them will run. Reporting the
    # collection as executed here would show the ambiguous job as a full run
    # that went fine, which is the reading the refusal exists to prevent.
    _, plugin, _ = _run_with_selection(
        pytester,
        monkeypatch,
        _TWO_TESTS,
        served={
            "selection": "refused",
            "reason": "ambiguous_test_sessions",
            "tests": [],
            "message": _SERVED_REFUSAL_MESSAGE,
        },
    )

    reported = _reported(plugin)
    assert reported["test.selection.answer"] == "refused"
    assert reported["test.selection.reason"] == "ambiguous_test_sessions"
    assert reported["test.selection.kept_count"] == 0
    assert reported["test.collection.count"] == 2


@pytest.mark.parametrize(
    ("served_tests", "expected_degradation"),
    [
        (
            ["some_other_file.py::test_renamed_since"],
            "subset_matched_no_collected_test",
        ),
        (
            [
                "test_a_subset_this_run_cannot_honour_reports_both_halves.py::test_kept",
                "some_other_file.py::test_renamed_since",
            ],
            "subset_partly_absent_from_collection",
        ),
        # Not an id mismatch at all, but it reaches the wire through the same
        # one place, and asserting the three causes together is what keeps that
        # true.
        ([], "subset_served_without_tests"),
    ],
)
def test_a_subset_this_run_cannot_honour_reports_both_halves(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    served_tests: typing.List[str],
    expected_degradation: str,
) -> None:
    # The served answer and the run that happened part ways here, and BOTH are
    # reported: Mergify's word untouched, and beside it the run's own account
    # of why it did something else. Answering `full` here instead -- which is
    # what this used to do -- erases the only evidence that Mergify named tests
    # a run could not find, in the one case that evidence matters.
    #
    # `kept_count` is what makes the pair readable without a third key: two out
    # of two collected is the full suite, whatever the answer above it says.
    result, plugin, _ = _run_with_selection(
        pytester,
        monkeypatch,
        _TWO_TESTS,
        served={
            "selection": "subset",
            "reason": "queue_rerun",
            "tests": served_tests,
        },
    )

    # Both tests ran: the answer was declined, not partly applied.
    result.assert_outcomes(passed=2)
    # And the one person who can see it is told, in the run's own summary, in
    # a sentence rather than an identifier. The attributes below reach us only
    # if the session uploads; this line reaches the developer watching the
    # build either way.
    result.stdout.fnmatch_lines(
        ["*Mergify's answer didn't match the tests this run collected*"]
    )

    reported = _reported(plugin)
    assert reported["test.selection.answer"] == "subset"
    assert reported["test.selection.reason"] == "queue_rerun"
    assert reported["test.selection.not_applied_reason"] == expected_degradation
    assert reported["test.selection.kept_count"] == 2
    assert reported["test.collection.count"] == 2


def test_an_answer_this_client_predates_is_reported_as_served(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The degradation that is expected to happen, and the reason this key is a
    # word rather than a flag: the day the engine ships a fifth answer, every
    # published client lands here. A counter that cannot tell this apart from
    # the three that signal a defect on our side alerts on every release.
    _, plugin, _ = _run_with_selection(
        pytester,
        monkeypatch,
        _TWO_TESTS,
        served={
            "selection": "an-answer-from-a-newer-mergify",
            "reason": "whatever_the_engine_called_it",
            "tests": [],
        },
    )

    reported = _reported(plugin)
    assert reported["test.selection.answer"] == "an-answer-from-a-newer-mergify"
    assert reported["test.selection.reason"] == "whatever_the_engine_called_it"
    assert reported["test.selection.not_applied_reason"] == "unrecognised_selection"
    assert reported["test.selection.kept_count"] == 2


def test_what_was_collected_is_what_this_plugin_collected(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # `-k` narrows the collection before this plugin ever sees it, so one of the
    # two tests is not part of what Mergify was asked about. The count is the
    # same set the fingerprint identifies -- announcing the whole suite would
    # make every run under a user filter look like a reduction it never was.
    _, plugin, _ = _run_with_selection(
        pytester,
        monkeypatch,
        _TWO_TESTS,
        "-k",
        "kept",
        served={"selection": "full", "reason": "no_predecessor", "tests": []},
    )

    reported = _reported(plugin)
    assert reported["test.collection.count"] == 1
    assert reported["test.selection.kept_count"] == 1
    assert reported["test.collection.fingerprint"] == conftest.collection_fingerprint(
        ["test_what_was_collected_is_what_this_plugin_collected.py::test_kept"]
    )


def test_a_run_that_asks_for_nothing_reports_no_selection(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A job that never opted in: the run never asks, so it has nothing to say
    # about an answer. The two runs that ask and are answered with nothing -- no
    # subscription, a failed request -- reach the same silence by a different
    # route and are pinned separately below; all three would otherwise fill the
    # reporting with runs the feature never touched. The collection they hold is
    # still theirs to report.
    #
    # The server is standing by with an answer here on purpose: what makes this
    # run silent is the missing opt-in, not a server with nothing to say.
    _, plugin, calls = _run_with_selection(
        pytester,
        monkeypatch,
        _TWO_TESTS,
        setenv={ci_insights.TEST_SELECTION_ENABLE_ENV: None},
        served={"selection": "full", "reason": "no_predecessor", "tests": []},
    )

    assert calls == []
    reported = _reported(plugin)
    assert "test.selection.answer" not in reported
    assert "test.selection.reason" not in reported
    assert "test.selection.kept_count" not in reported
    assert reported["test.collection.count"] == 2


def test_an_empty_selection_uploads_a_session_saying_it_ran_none_of_them(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    otlp_collector: conftest.OTLPCollector,
) -> None:
    # The half that disappears in silence if it is forgotten. A job told to run
    # nothing executes nothing, so it has no test result to be counted through
    # and would be the one run the reporting cannot see -- while being the most
    # spectacular thing the feature does, and the one a developer comes asking
    # about. Asserted on the decoded payload rather than on the plugin's own
    # state: a run can hold the right attributes and have uploaded nothing.
    conftest.configure_upload(monkeypatch, otlp_collector)
    monkeypatch.setenv("GITHUB_HEAD_REF", "queue/main/42")
    monkeypatch.setenv("GITHUB_SHA", "cafecafe")
    monkeypatch.setenv("GITHUB_WORKFLOW", "CI")
    monkeypatch.setenv("GITHUB_JOB", "unit")
    monkeypatch.setenv(ci_insights.TEST_SELECTION_ENABLE_ENV, "true")
    otlp_collector.serve_test_selection(
        {"selection": "empty", "reason": "predecessor_job_succeeded"}
    )
    pytester.makepyfile(_TWO_TESTS)

    result = pytester.runpytest_subprocess()

    assert result.ret == pytest.ExitCode.OK
    (batch,) = otlp_collector.batches
    assert batch.resource_attributes["test.selection.answer"] == "empty"
    assert (
        batch.resource_attributes["test.selection.reason"]
        == "predecessor_job_succeeded"
    )
    assert batch.resource_attributes["test.selection.kept_count"] == 0
    # The count is the point: zero executed out of nothing is a job with no
    # tests, zero executed out of two is the reduction this feature just made.
    assert batch.resource_attributes["test.collection.count"] == 2


def test_a_run_that_could_not_apply_its_answer_uploads_both_halves(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    otlp_collector: conftest.OTLPCollector,
) -> None:
    # The one assertion that says the alert can exist. Everything else here
    # reads the plugin's own attribute dict; this reads what actually left the
    # process, because a run can hold the right attributes and upload none of
    # them -- and a degradation nobody receives is exactly the CI log this
    # ticket exists to stop dying in.
    conftest.configure_upload(monkeypatch, otlp_collector)
    monkeypatch.setenv("GITHUB_HEAD_REF", "queue/main/42")
    monkeypatch.setenv("GITHUB_SHA", "cafecafe")
    monkeypatch.setenv("GITHUB_WORKFLOW", "CI")
    monkeypatch.setenv("GITHUB_JOB", "unit")
    monkeypatch.setenv(ci_insights.TEST_SELECTION_ENABLE_ENV, "true")
    otlp_collector.serve_test_selection(
        {
            "selection": "subset",
            "reason": "queue_rerun",
            "tests": ["nothing_this_run_collected.py::test_gone"],
        }
    )
    pytester.makepyfile(_TWO_TESTS)

    result = pytester.runpytest_subprocess()

    # The customer's run is unharmed: both tests ran and the job is green.
    assert result.ret == pytest.ExitCode.OK
    result.assert_outcomes(passed=2)
    (batch,) = otlp_collector.batches
    assert batch.resource_attributes["test.selection.answer"] == "subset"
    assert batch.resource_attributes["test.selection.reason"] == "queue_rerun"
    assert (
        batch.resource_attributes["test.selection.not_applied_reason"]
        == "subset_matched_no_collected_test"
    )
    assert batch.resource_attributes["test.selection.kept_count"] == 2
    assert batch.resource_attributes["test.collection.count"] == 2


def test_a_dormant_repository_reports_no_selection(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The endpoint had nothing to answer with -- no subscription, or the
    # feature not served for this repository. The plugin still builds a
    # selection object, and it reads as a plain full run, so reporting it would
    # record an answer that was never given. During a pilot these runs are the
    # majority of installs: counting them as served `full` answers would bury
    # the runs Mergify actually looked at.
    _, plugin, calls = _run_with_selection(
        pytester,
        monkeypatch,
        _TWO_TESTS,
        served=None,
    )

    # Asked, unlike the kill-switch case -- and answered with nothing.
    assert len(calls) == 1
    reported = _reported(plugin)
    assert "test.selection.answer" not in reported
    assert "test.selection.reason" not in reported
    assert "test.selection.kept_count" not in reported
    assert reported["test.collection.count"] == 2


def test_a_failed_request_reports_no_selection(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The request errored and the run degraded to the full suite. That local
    # degradation is not an answer: reporting it as one would make a Mergify
    # outage look like a stretch of runs Mergify examined and declined to
    # reduce -- which is precisely the signal a non-delivery alert reads.
    _, plugin, _ = _run_with_selection(
        pytester,
        monkeypatch,
        _TWO_TESTS,
        error="Mergify API returned HTTP 500",
    )

    reported = _reported(plugin)
    assert "test.selection.answer" not in reported
    assert "test.selection.reason" not in reported
    assert "test.selection.kept_count" not in reported
    assert reported["test.collection.count"] == 2


# --- The terminal block (MRGFY-8978) ---
#
# The CI job log is where a developer already is when a reduced run surprises
# them, and the question in their head is "is this broken, and can I trust
# this green?". The block has to answer it in prose a reader who has never
# heard of the feature can follow, and no internal identifier may ever reach
# it. The wording below was validated by Alexandre on 2026-09-11 and is pinned
# verbatim on purpose: a change to it is a product decision, not a refactor.

# Every identifier the engine or this client can put in `reason`. The last
# test of this block renders every block and greps for each of these; adding a
# reason without a sentence is what makes that test fail.
_ENGINE_FULL_REASONS = [
    "feature_disabled",
    "not_a_merge_queue_run",
    "stale_run",
    "no_predecessor",
    "predecessor_unknown",
    "no_collection_fingerprint",
    "no_matching_test_session",
    "indeterminate_test_session",
    "matched_test_session_partially_processed",
    "matched_test_session_dropped_cases",
    "matched_test_session_declaration_unreadable",
    "matched_test_session_ran_no_test",
]
_CLIENT_FULL_REASONS = [
    "not_requested",
    "unrecognised_selection",
    "subset_served_without_tests",
    "subset_matched_no_collected_test",
    "subset_partly_absent_from_collection",
]
_OTHER_REASONS = [
    "reduced_rerun",
    "matched_test_session_had_no_gating_failure",
    "ambiguous_test_sessions",
]
_EVERY_REASON = _ENGINE_FULL_REASONS + _CLIENT_FULL_REASONS + _OTHER_REASONS


def _served_subset(
    served: typing.List[str], collected: typing.List[str]
) -> test_selection.TestSelection:
    selection = test_selection.TestSelection(
        selection="subset", reason="reduced_rerun", tests=served
    )
    items = [FakeItem(name) for name in collected]
    selection.filter_items(FakeConfig(), items)  # type: ignore[arg-type]
    return selection


def _served_empty(collected: int) -> test_selection.TestSelection:
    selection = test_selection.TestSelection(
        selection="empty", reason="matched_test_session_had_no_gating_failure"
    )
    items = [FakeItem(f"tests/test_x.py::test_{i}") for i in range(collected)]
    selection.filter_items(FakeConfig(), items)  # type: ignore[arg-type]
    return selection


def test_the_empty_block_reads_as_a_deliberate_skip() -> None:
    assert _served_empty(24).report() == (
        "✂️ Test selection\n"
        "\n"
        "The code under test hasn't changed since the previous attempt of this job, and\n"
        "all 24 tests passed back then. Mergify skipped them: the job is green, and no\n"
        "test was executed.\n"
    )


def test_the_empty_block_over_one_test_does_not_say_all_1_tests() -> None:
    report = _served_empty(1).report()
    assert "its only test passed back then. Mergify skipped it:" in report
    assert "1 tests" not in report


def test_the_empty_block_over_nothing_makes_no_skip_claim() -> None:
    # `-k` left nothing to run: pytest's exit code 5 is the honest answer, and
    # a paragraph saying Mergify skipped "all 0 tests" would send whoever is
    # debugging that red job to look at Mergify instead of at their filter.
    assert _served_empty(0).report() == "✂️ Test selection\n"


def test_the_subset_block_lists_what_was_re_executed() -> None:
    failed = [
        "tests/suite/test_checkout.py::test_checkout_rejects_negative_quantity_07",
        "tests/suite/test_checkout.py::test_checkout_total_02",
        "tests/suite/test_payment.py::test_refund_partial",
    ]
    collected = failed + [f"tests/suite/test_other.py::test_{i}" for i in range(321)]
    assert _served_subset(failed, collected).report() == (
        "✂️ Test selection\n"
        "\n"
        "The code under test hasn't changed since the previous attempt of this job, where\n"
        "3 of its 324 tests failed. Mergify re-executed only those 3 and skipped the 321\n"
        "that had already passed:\n"
        "\n"
        "  tests/suite/test_checkout.py::test_checkout_rejects_negative_quantity_07\n"
        "  tests/suite/test_checkout.py::test_checkout_total_02\n"
        "  tests/suite/test_payment.py::test_refund_partial\n"
    )


def test_a_subset_naming_a_test_this_run_did_not_collect_is_not_applied() -> None:
    # A served name absent from the collection declines the whole answer: the
    # full suite runs, and the block says so rather than listing the part that
    # did match as if Mergify had re-executed it.
    served = ["tests/test_a.py::test_kept", "tests/test_gone.py::test_renamed"]
    collected = ["tests/test_a.py::test_kept", "tests/test_a.py::test_fine"]
    selection = _served_subset(served, collected)
    assert selection.not_applied_reason == "subset_partly_absent_from_collection"
    report = selection.report()
    assert "didn't match the tests this run collected" in report
    assert "re-executed" not in report
    assert "test_kept" not in report and "test_renamed" not in report


def test_the_subset_list_is_capped_at_ten() -> None:
    failed = [f"tests/test_x.py::test_{i:02d}" for i in range(12)]
    collected = failed + ["tests/test_y.py::test_fine"]
    report = _served_subset(failed, collected).report()
    listed = [line for line in report.splitlines() if line.startswith("  ")]
    assert listed == [f"  tests/test_x.py::test_{i:02d}" for i in range(10)] + [
        "  … and 2 more"
    ]


def test_the_subset_list_is_not_capped_at_exactly_ten() -> None:
    # "… and 0 more" would be a line about nothing.
    failed = [f"tests/test_x.py::test_{i:02d}" for i in range(10)]
    report = _served_subset(failed, failed + ["tests/test_y.py::test_fine"]).report()
    assert "more" not in report
    assert report.count("  tests/test_x.py::") == 10


def test_the_subset_block_when_every_collected_test_had_failed() -> None:
    # Nothing was skipped, so "skipped the 0 that had already passed" must not
    # be printed.
    failed = ["tests/test_a.py::test_one", "tests/test_a.py::test_two"]
    report = _served_subset(failed, failed).report()
    assert "all 2 of its tests failed. Mergify re-executed all of them:" in report
    assert "skipped" not in report


def test_the_subset_block_when_the_only_collected_test_had_failed() -> None:
    failed = ["tests/test_a.py::test_one"]
    report = _served_subset(failed, failed).report()
    assert "its only test failed. Mergify re-executed it:" in report
    assert "1 of its" not in report


# The table from the ticket, one row per engine reason. It is the contract,
# and the completeness test below pins that it names every reason the
# engine can serve.
_ENGINE_SENTENCES: typing.List[typing.Tuple[str, str]] = [
    ("no_predecessor", "First attempt of this batch, so the full suite ran."),
    (
        "not_a_merge_queue_run",
        "This job isn't part of a merge queue run, so the full suite ran.",
    ),
    (
        "stale_run",
        "The batch branch was updated while this job was running, so the full"
        " suite ran.",
    ),
    (
        "no_matching_test_session",
        "The previous attempt didn't run this exact set of tests, so the full"
        " suite ran.",
    ),
    (
        "matched_test_session_ran_no_test",
        "The previous attempt executed no tests, so the full suite ran.",
    ),
    (
        "predecessor_unknown",
        "Mergify couldn't tell which previous run to start from, so the full"
        " suite ran.",
    ),
    (
        "indeterminate_test_session",
        "Mergify couldn't tell which previous run to start from, so the full"
        " suite ran.",
    ),
    (
        "matched_test_session_partially_processed",
        "Mergify didn't have the complete results of the previous attempt, so"
        " the full suite ran.",
    ),
    (
        "matched_test_session_dropped_cases",
        "Mergify didn't have the complete results of the previous attempt, so"
        " the full suite ran.",
    ),
    (
        "matched_test_session_declaration_unreadable",
        "Mergify didn't have the complete results of the previous attempt, so"
        " the full suite ran.",
    ),
    (
        "no_collection_fingerprint",
        "This version of pytest-mergify doesn't report what it collected, so"
        " the full suite ran. Upgrade it to let Mergify reduce reruns.",
    ),
    (
        "feature_disabled",
        "Test selection isn't enabled for this organization yet, so the full"
        " suite ran.",
    ),
]


@pytest.mark.parametrize(("reason", "sentence"), _ENGINE_SENTENCES)
def test_every_engine_reason_has_its_sentence(reason: str, sentence: str) -> None:
    selection = test_selection.TestSelection(selection="full", reason=reason)
    # Wrapped at the width the block prints at; the sentence itself is the
    # contract, the line break is where an 80-column log viewer would put it.
    assert selection.report() == f"✂️ Test selection\n\n{textwrap.fill(sentence, 80)}\n"


def test_the_engine_reason_table_is_complete() -> None:
    # The parametrization above IS the table; this pins that it covers every
    # reason the engine can serve, so a reason added on one side without the
    # other is caught here rather than in a customer's log.
    assert {reason for reason, _ in _ENGINE_SENTENCES} == set(_ENGINE_FULL_REASONS)


def test_a_dormant_repository_gets_a_sentence() -> None:
    selection = test_selection.TestSelection()
    assert selection.reason == "not_requested"
    assert selection.report() == (
        "✂️ Test selection\n"
        "\n"
        "Test selection isn't available for this repository, so the full suite ran.\n"
    )


def test_a_subset_matching_nothing_gets_a_sentence() -> None:
    selection = _served_subset(["tests/test_gone.py::test_renamed"], ["tests/a.py::t"])
    # Mergify's word survives; the sentence is chosen by the run's own.
    assert selection.reason == "reduced_rerun"
    assert selection.not_applied_reason == "subset_matched_no_collected_test"
    assert selection.report() == (
        "✂️ Test selection\n"
        "\n"
        "Mergify's answer didn't match the tests this run collected, so the full suite\n"
        "ran.\n"
    )


@pytest.mark.parametrize(
    "reason",
    [
        "subset_served_without_tests",
        "subset_matched_no_collected_test",
        "subset_partly_absent_from_collection",
    ],
)
def test_an_answer_that_could_not_be_applied_leaves_the_reader_nothing_to_do(
    reason: str,
) -> None:
    # Unreachable against a correct engine, and visible in our own data, so the
    # three share a sentence that names the fact and asks nothing of the reader.
    # Built the way each actually arises -- Mergify's `reason` stays its own,
    # and the client's verdict lands in `not_applied_reason` -- rather than by
    # writing the client's word into Mergify's field.
    if reason == "subset_served_without_tests":
        selection = test_selection.TestSelection(
            selection="subset", reason="reduced_rerun", tests=[]
        )
    elif reason == "subset_matched_no_collected_test":
        selection = _served_subset(["tests/gone.py::t"], ["tests/a.py::t"])
    else:
        selection = _served_subset(
            ["tests/a.py::t", "tests/gone.py::t"], ["tests/a.py::t"]
        )
    assert selection.not_applied_reason == reason
    assert selection.reason == "reduced_rerun"
    report = selection.report()
    assert "Mergify's answer didn't match the tests this run collected" in report
    assert "Upgrade" not in report


def test_the_two_remedies_are_told_apart_in_the_report() -> None:
    # A `selection` this plugin predates is the normal way the engine grows new
    # answers, and it is the user's to fix: the sentence leads to the upgrade,
    # not to support.
    selection = test_selection.TestSelection(selection="a-newer-answer", reason="x")  # type: ignore[arg-type]
    assert selection.not_applied_reason == "unrecognised_selection"
    report = selection.report()
    assert "Upgrade it to let Mergify reduce reruns" in report
    assert "support" not in report
    # And never the raw value: it is Mergify's, and it is unknown here.
    assert "a-newer-answer" not in report


def test_a_failed_request_gets_a_sentence_and_keeps_the_error() -> None:
    # The error text is what support will ask for; the sentence is what the
    # developer reads first.
    selection = test_selection.TestSelection(
        init_error_msg="Mergify API request timed out"
    )
    assert selection.report() == (
        "✂️ Test selection\n"
        "\n"
        "Mergify couldn't be asked whether this run could be reduced, so the full suite\n"
        "ran.\n"
        "Error: Mergify API request timed out\n"
    )


def test_the_error_text_is_never_wrapped() -> None:
    # The client's errors carry the request URL. Wrapped at 80 columns it
    # would be split at a hyphen, and what support gets pasted is a broken
    # link.
    url = (
        "https://api.mergify.com/v1/ci/test-selection?branch=mergify%2Fmerge-"
        "queue%2Fmain%2F1234&head_sha=cafecafe&pipeline_name=CI&job_name=unit-tests"
    )
    report = test_selection.TestSelection(
        init_error_msg=f"error sending request for url ({url})"
    ).report()
    assert f"Error: error sending request for url ({url})\n" in report


def test_an_unknown_reason_still_reads_as_a_full_run() -> None:
    # A newer engine may serve a reason this client predates. It must neither
    # crash nor print the raw identifier.
    selection = test_selection.TestSelection(
        selection="full", reason="a_reason_this_client_predates"
    )
    assert selection.report() == "✂️ Test selection\n\nMergify served the full suite.\n"


def test_a_refusal_block_points_at_the_error_instead_of_repeating_it() -> None:
    # The engine's message is the `UsageError` that stopped the run, and pytest
    # prints it; the block printed after it must not show it a second time.
    selection = test_selection.TestSelection(
        selection="refused",
        reason="ambiguous_test_sessions",
        message=_SERVED_REFUSAL_MESSAGE,
    )
    assert selection.report() == (
        "✂️ Test selection\n"
        "\n"
        "Mergify stopped this run before any test ran; its explanation is in the error\n"
        "above.\n"
    )
    assert _SERVED_REFUSAL_MESSAGE not in selection.report()


def test_no_internal_identifier_ever_reaches_the_terminal() -> None:
    rendered = [
        test_selection.TestSelection(selection="full", reason=reason).report()
        for reason in _ENGINE_FULL_REASONS + _CLIENT_FULL_REASONS
    ]
    rendered.append(_served_empty(5).report())
    rendered.append(
        _served_subset(
            ["tests/a.py::t1"], ["tests/a.py::t1", "tests/a.py::t2"]
        ).report()
    )
    rendered.append(test_selection.TestSelection(init_error_msg="boom").report())
    rendered.append(
        test_selection.TestSelection(
            selection="refused", reason="ambiguous_test_sessions"
        ).report()
    )
    for text in rendered:
        for identifier in _EVERY_REASON:
            assert identifier not in text, (identifier, text)
        assert "reason:" not in text
        assert "selection:" not in text.lower()


def test_no_block_tells_the_reader_to_contact_support() -> None:
    # Alexandre, 2026-09-11: the shapes that cannot come from a correct engine
    # are ours to see in our own data; asking the customer to report them hands
    # them our work. The run id line is the one mention of support in the
    # section, and it is printed elsewhere, as information.
    rendered = [
        test_selection.TestSelection(selection="full", reason=reason).report()
        for reason in _ENGINE_FULL_REASONS + _CLIENT_FULL_REASONS + ["unknown"]
    ]
    rendered.append(_served_empty(5).report())
    rendered.append(_served_subset(["tests/a.py::t1"], ["tests/a.py::t1"]).report())
    rendered.append(test_selection.TestSelection(init_error_msg="boom").report())
    rendered.append(
        test_selection.TestSelection(
            selection="refused", reason="ambiguous_test_sessions"
        ).report()
    )
    for text in rendered:
        assert "support" not in text.lower(), text
        assert "report it" not in text.lower(), text
