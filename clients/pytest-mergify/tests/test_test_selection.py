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
    assert selection.selection == "full"


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
    assert "executing no test" in selection.report()
    assert "all 2 selected test(s)" in selection.report()


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
    result.stdout.fnmatch_lines(["*executing no test*all 2 selected test(s)*"])


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
    assert _SERVED_REFUSAL_MESSAGE in result.stderr.str() + result.stdout.str()


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
    assert "Skipped rerun" not in result.stdout.str()
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


def test_a_subset_matching_nothing_reports_the_full_run_it_degraded_to(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The served answer and the run that happened part ways here: a subset
    # naming tests this collection does not hold degrades to running everything.
    # What is reported is the run, not the offer -- counting this as a served
    # subset would credit the feature with a reduction that never occurred, and
    # hide the mismatch that caused it behind a `subset` nobody would question.
    _, plugin, _ = _run_with_selection(
        pytester,
        monkeypatch,
        _TWO_TESTS,
        served={
            "selection": "subset",
            "reason": "queue_rerun",
            "tests": ["some_other_file.py::test_renamed_since"],
        },
    )

    reported = _reported(plugin)
    assert reported["test.selection.answer"] == "full"
    assert reported["test.selection.reason"] == "subset_matched_no_collected_test"
    assert reported["test.selection.kept_count"] == 2
    assert reported["test.collection.count"] == 2


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
    # The kill switch: the run never asks, so it has nothing to say about an
    # answer. The two runs that ask and are answered with nothing -- no
    # subscription, a failed request -- reach the same silence by a different
    # route and are pinned separately below; all three would otherwise fill the
    # reporting with runs the feature never touched. The collection they hold is
    # still theirs to report.
    _, plugin, calls = _run_with_selection(
        pytester,
        monkeypatch,
        _TWO_TESTS,
        setenv={"MERGIFY_TEST_SELECTION_DISABLE": "true"},
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
