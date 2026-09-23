"""Test selection under `pytest -n` (MRGFY-8632), run for real.

Every run here is a subprocess with real pytest-xdist workers, talking to a
real HTTP stub: the properties under test -- one request per run, one verdict
per run, workers that skip rather than deselect -- are about how processes
cooperate, and none of them survives being simulated in one process.
"""

import json
import os
import typing

import _pytest.pytester
import pytest

from pytest_mergify import ci_insights, test_selection
from tests import conftest

pytest_plugins = ["pytester"]

# Six tests of every kind the verdict tells apart: passing, failing, and a
# skip of the user's own, which DID run -- unlike a test the answer left out.
_SUITE = """
import time

import pytest

def test_a():
    time.sleep(0.05)

def test_b(): pass
def test_c(): pass
def test_d(): pass
def test_fails(): assert False

@pytest.mark.skip(reason="the user's own")
def test_user_skip(): pass
"""

_ALL = [
    f"test_suite.py::{name}"
    for name in ("test_a", "test_b", "test_c", "test_d", "test_fails", "test_user_skip")
]

# What a worker that cannot read the answer is made to do: look for it where
# it is not. Its wait is shortened so the run does not sit out the real bound.
_BLIND_SECOND_WORKER = f"""
import pytest

from pytest_mergify import test_selection

test_selection.XDIST_ANSWER_WAIT_SECONDS = 0.2

@pytest.hookimpl(trylast=True)
def pytest_configure_node(node):
    if node.gateway.id == "gw1":
        node.workerinput["{test_selection.XDIST_ANSWER_PATH_KEY}"] += ".missing"
"""


def _run(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    collector: conftest.OTLPCollector,
    *args: str,
    served: typing.Optional[typing.Dict[str, typing.Any]] = None,
    conftest_code: typing.Optional[str] = None,
    extra_code: str = "",
) -> _pytest.pytester.RunResult:
    conftest.configure_upload(monkeypatch, collector)
    # The coordinates the answer is keyed on.
    monkeypatch.setenv("GITHUB_HEAD_REF", "queue/main/42")
    monkeypatch.setenv("GITHUB_SHA", "cafecafe")
    monkeypatch.setenv("GITHUB_WORKFLOW", "CI")
    monkeypatch.setenv("GITHUB_JOB", "unit")
    monkeypatch.setenv(ci_insights.TEST_SELECTION_ENABLE_ENV, "true")
    if served is not None:
        collector.serve_test_selection(served)
    pytester.makepyfile(test_suite=_SUITE + extra_code)
    if conftest_code is not None:
        pytester.makeconftest(conftest_code)
    return pytester.runpytest_subprocess("-n", "2", "-rs", *args)


def _verdict(collector: conftest.OTLPCollector) -> typing.Dict[str, typing.Any]:
    # Exactly one, whatever happened: the controller sends the run's verdict
    # and no worker sends one of its own. Several would be several sessions
    # under one job, which the engine refuses to choose between.
    (verdict,) = collector.session_verdicts
    return verdict


def _controller_resource(
    collector: conftest.OTLPCollector,
) -> typing.Dict[str, typing.Any]:
    # The one batch that claims the run's collection: the controller's.
    (controller,) = [
        batch
        for batch in collector.batches
        if "test.collection.fingerprint" in batch.resource_attributes
    ]
    return controller.resource_attributes


def _executed_ids(collector: conftest.OTLPCollector) -> typing.Set[str]:
    return {
        span.name
        for batch in collector.batches
        for span in batch.spans
        if span.attributes.get("test.scope") == "case"
    }


def test_a_subset_runs_the_served_tests_and_skips_the_rest(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    otlp_collector: conftest.OTLPCollector,
) -> None:
    served = [
        "test_suite.py::test_a",
        "test_suite.py::test_fails",
        "test_suite.py::test_user_skip",
    ]
    result = _run(
        pytester,
        monkeypatch,
        otlp_collector,
        served={"selection": "subset", "reason": "queue_rerun", "tests": served},
    )

    # The served three ran (one passes, one fails, one is the user's skip),
    # and the three others were skipped by the answer: the run stays red on
    # the failure it re-executed.
    assert result.ret == pytest.ExitCode.TESTS_FAILED
    result.assert_outcomes(passed=1, failed=1, skipped=4)
    result.stdout.fnmatch_lines(
        ["*Not selected by Mergify Test Selection*"], consecutive=False
    )
    assert "Different tests were collected" not in result.stdout.str()
    assert otlp_collector.test_selection_requests == 1

    # Only what ran has a span, as on a run without `-n` that deselected the
    # rest.
    assert _executed_ids(otlp_collector) == set(served)

    verdict = _verdict(otlp_collector)
    # The point of the whole change: a test skipped by the answer is not a
    # test that ran. Counted as one, `executed_count` would read 6 for a run
    # that executed 3, and a next attempt judged against it would take this
    # run for more complete than it was.
    assert verdict["executed_count"] == 3
    assert verdict["passed_count"] == 1
    assert verdict["failed_count"] == 1
    # The user's own skip ran, and counts; the answer's three do not.
    assert verdict["skipped_count"] == 1
    assert verdict["failing_tests"] == ["test_suite.py::test_fails"]
    assert verdict["collection_count"] == 6
    assert verdict["collection_fingerprint"] == conftest.collection_fingerprint(_ALL)
    assert verdict["selection"] == {
        "answer": "subset",
        "reason": "queue_rerun",
        "kept_count": 3,
    }
    # The worker's time, which the controller cannot measure itself.
    assert verdict["total_test_runtime_ms"] >= 50

    # The verdict is the controller's session, the same one its trace upload
    # claims.
    (controller,) = [
        batch
        for batch in otlp_collector.batches
        if "test.collection.fingerprint" in batch.resource_attributes
    ]
    assert verdict["test_run_id"] == controller.resource_attributes["test.run.id"]
    assert controller.resource_attributes["test.selection.answer"] == "subset"
    assert controller.resource_attributes["test.selection.kept_count"] == 3

    # The block describes the reduction that was made.
    assert "Mergify re-executed only those 3" in " ".join(result.stdout.lines)


def test_an_empty_answer_skips_everything_and_exits_green(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    otlp_collector: conftest.OTLPCollector,
) -> None:
    # The suite holds a failing test: green here can only mean it never ran.
    result = _run(
        pytester,
        monkeypatch,
        otlp_collector,
        served={"selection": "empty", "reason": "predecessor_job_succeeded"},
    )

    assert result.ret == pytest.ExitCode.OK
    result.assert_outcomes(skipped=6)
    assert otlp_collector.test_selection_requests == 1
    assert _executed_ids(otlp_collector) == set()

    verdict = _verdict(otlp_collector)
    assert verdict["executed_count"] == 0
    assert verdict["skipped_count"] == 0
    assert verdict["collection_count"] == 6
    assert verdict["selection"]["answer"] == "empty"
    assert verdict["selection"]["kept_count"] == 0
    assert "no test was executed" in " ".join(result.stdout.lines)


@pytest.mark.parametrize(
    "served",
    [
        {"selection": "full", "reason": "no_predecessor"},
        # A subset naming a test this run does not hold is declined whole, as
        # without `-n`.
        {
            "selection": "subset",
            "reason": "queue_rerun",
            "tests": ["test_suite.py::test_a", "gone.py::test_elsewhere"],
        },
    ],
    ids=["full", "declined-subset"],
)
def test_an_answer_that_reduces_nothing_runs_everything(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    otlp_collector: conftest.OTLPCollector,
    served: typing.Dict[str, typing.Any],
) -> None:
    result = _run(pytester, monkeypatch, otlp_collector, served=served)

    result.assert_outcomes(passed=4, failed=1, skipped=1)
    assert otlp_collector.test_selection_requests == 1
    assert _executed_ids(otlp_collector) == set(_ALL)
    verdict = _verdict(otlp_collector)
    assert verdict["executed_count"] == 6
    assert verdict["selection"]["kept_count"] == 6


def test_a_failed_request_runs_everything_and_still_sends_the_verdict(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    otlp_collector: conftest.OTLPCollector,
) -> None:
    otlp_collector.fail_test_selection(500)

    result = _run(pytester, monkeypatch, otlp_collector)

    result.assert_outcomes(passed=4, failed=1, skipped=1)
    assert otlp_collector.test_selection_requests == 1
    # The next attempt of this job is answered from it, whatever this one was
    # told -- the same rule as without `-n`.
    verdict = _verdict(otlp_collector)
    assert verdict["executed_count"] == 6
    assert "selection" not in verdict
    assert "Mergify couldn't be asked whether this run could be reduced" in (
        " ".join(result.stdout.lines)
    )


def test_a_request_that_times_out_runs_everything(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    otlp_collector: conftest.OTLPCollector,
) -> None:
    # Past the binding's 10-second bound. The controller blocks xdist's
    # scheduling while it asks, so this is also the proof that no worker
    # started on a guess in the meantime.
    otlp_collector.delay_test_selection(11)
    otlp_collector.serve_test_selection(
        {"selection": "empty", "reason": "predecessor_job_succeeded"}
    )

    result = _run(pytester, monkeypatch, otlp_collector)

    result.assert_outcomes(passed=4, failed=1, skipped=1)
    assert otlp_collector.test_selection_requests == 1
    assert _verdict(otlp_collector)["executed_count"] == 6


def test_a_worker_that_cannot_read_the_answer_runs_everything_it_is_given(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    otlp_collector: conftest.OTLPCollector,
) -> None:
    # `--dist each` hands both workers every test, so what each one did is
    # deterministic: gw0 read the answer, gw1 could not.
    served = [
        "test_suite.py::test_a",
        "test_suite.py::test_fails",
        "test_suite.py::test_user_skip",
    ]
    result = _run(
        pytester,
        monkeypatch,
        otlp_collector,
        "--dist",
        "each",
        served={"selection": "subset", "reason": "queue_rerun", "tests": served},
        conftest_code=_BLIND_SECOND_WORKER,
    )

    # The run completes: the blind worker ran its share whole instead of
    # failing xdist on a collection different from its sibling's.
    assert "Different tests were collected" not in result.stdout.str()
    # gw0: 1 passed, 1 failed, 1 user skip + 3 answer skips.
    # gw1: 4 passed, 1 failed, 1 user skip.
    result.assert_outcomes(passed=5, failed=2, skipped=5)
    assert otlp_collector.test_selection_requests == 1

    # No verdict: the session holds part of a reduction, which the engine
    # cannot read, so the next rerun of this job finds nothing to continue
    # and runs the full suite.
    assert otlp_collector.session_verdicts == []
    # And no announcement of a reduction the run did not make: the answer is
    # reported as not applied, over the whole collection.
    controller = _controller_resource(otlp_collector)
    assert controller["test.selection.answer"] == "subset"
    assert controller["test.selection.not_applied_reason"] == (
        "xdist_worker_could_not_read_answer"
    )
    assert controller["test.selection.kept_count"] == 6
    output = " ".join(result.stdout.lines)
    assert "Some pytest-xdist workers couldn't read Mergify's answer" in output
    assert "re-executed only" not in output


def test_an_empty_answer_never_greens_a_failure_a_worker_ran(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    otlp_collector: conftest.OTLPCollector,
) -> None:
    # MRGFY-8614's invariant under `-n`: green is never decided from the
    # answer alone. A worker that could not read `empty` runs its tests, one
    # of them fails, and the job is red.
    result = _run(
        pytester,
        monkeypatch,
        otlp_collector,
        "--dist",
        "each",
        served={"selection": "empty", "reason": "predecessor_job_succeeded"},
        conftest_code=_BLIND_SECOND_WORKER,
    )

    assert result.ret == pytest.ExitCode.TESTS_FAILED
    # Nor is the next rerun told `empty` again off this session: the engine
    # reads an `empty` session as complete whatever ran, and most of this
    # one's tests never did.
    assert otlp_collector.session_verdicts == []
    assert _controller_resource(otlp_collector)[
        "test.selection.not_applied_reason"
    ] == ("xdist_worker_could_not_read_answer")
    assert "no test was executed" not in " ".join(result.stdout.lines)


def test_a_failure_reported_on_a_skipped_test_withholds_the_verdict(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    otlp_collector: conftest.OTLPCollector,
) -> None:
    # A skipped test's teardown is where the module fixture of the test
    # before it is torn down, so the fixture's failure is reported on the
    # skipped test. Folded under that id, the next rerun would replay a test
    # that cannot reproduce it and go green; dropped, the verdict would read
    # green over a red job. Neither: no verdict, and the next rerun is full.
    # One worker, so the order is the file's.
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
            "tests": ["test_teardown.py::test_uses_it"],
        }
    )
    pytester.makepyfile(
        test_teardown="""
import pytest

@pytest.fixture(scope="module")
def resource():
    yield
    raise RuntimeError("the module fixture failed to tear down")

def test_uses_it(resource): pass
def test_left_out(): pass
"""
    )

    result = pytester.runpytest_subprocess("-n", "1")

    assert result.ret == pytest.ExitCode.TESTS_FAILED
    result.stdout.fnmatch_lines(["*ERROR*test_left_out*RuntimeError*"])
    assert otlp_collector.session_verdicts == []


def test_workers_that_collect_different_tests_announce_no_reduction(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    otlp_collector: conftest.OTLPCollector,
) -> None:
    # xdist stops such a run before any test, on its own. What is left to
    # this plugin is not to describe, in the block or to Mergify, the
    # reduction it never got to make.
    result = _run(
        pytester,
        monkeypatch,
        otlp_collector,
        served={
            "selection": "subset",
            "reason": "queue_rerun",
            "tests": ["test_suite.py::test_a"],
        },
        conftest_code="""
import os

def pytest_collection_modifyitems(items):
    if os.environ.get("PYTEST_XDIST_WORKER") == "gw1":
        items[:] = items[:3]
""",
    )

    assert "Different tests were collected" in result.stdout.str()
    assert _executed_ids(otlp_collector) == set()
    assert otlp_collector.session_verdicts == []
    assert _controller_resource(otlp_collector)[
        "test.selection.not_applied_reason"
    ] == ("xdist_collections_differ")
    output = " ".join(result.stdout.lines)
    assert "re-executed only" not in output
    assert "collected different tests, so no test ran" in output


def test_a_crashed_worker_withholds_the_verdict(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    otlp_collector: conftest.OTLPCollector,
) -> None:
    # The worker that died never says whether it read the answer, nor what it
    # spent: a verdict folded from the survivors would describe a run nobody
    # fully accounted for. The next rerun is full instead.
    result = _run(
        pytester,
        monkeypatch,
        otlp_collector,
        "--max-worker-restart",
        "0",
        served={
            "selection": "subset",
            "reason": "queue_rerun",
            "tests": ["test_suite.py::test_a", "test_suite.py::test_crash"],
        },
        conftest_code="""
import os

import pytest

@pytest.fixture
def crash():
    os._exit(1)
""",
        extra_code="def test_crash(crash): pass\n",
    )

    assert "crashed" in result.stdout.str()
    assert otlp_collector.session_verdicts == []


def test_a_remote_worker_turns_selection_off_for_the_run(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    otlp_collector: conftest.OTLPCollector,
) -> None:
    # A worker on another host (`--tx ssh=...`) cannot read a file on this
    # one. The gateway is local here -- nothing in a test can open an ssh
    # connection -- but it is DESCRIBED as remote before the plugin looks,
    # which is all the plugin reads.
    result = _run(
        pytester,
        monkeypatch,
        otlp_collector,
        served={"selection": "empty", "reason": "predecessor_job_succeeded"},
        conftest_code="""
import pytest

@pytest.hookimpl(tryfirst=True)
def pytest_configure_node(node):
    if node.gateway.id == "gw1":
        node.gateway.spec.popen = None
        node.gateway.spec.ssh = "elsewhere"
""",
    )

    result.assert_outcomes(passed=4, failed=1, skipped=1)
    # Not asked at all, so nothing is reduced and no verdict claims a session
    # that could be.
    assert otlp_collector.test_selection_requests == 0
    assert otlp_collector.session_verdicts == []


def test_a_refusal_stops_the_run_before_any_test(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    otlp_collector: conftest.OTLPCollector,
) -> None:
    message = "Mergify Test Selection stopped this run: several runs of this job."
    result = _run(
        pytester,
        monkeypatch,
        otlp_collector,
        served={
            "selection": "refused",
            "reason": "ambiguous_test_sessions",
            "message": message,
        },
    )

    assert result.ret == pytest.ExitCode.USAGE_ERROR
    result.assert_outcomes()
    assert (result.stdout.str() + result.stderr.str()).count(message) == 1
    assert _executed_ids(otlp_collector) == set()
    verdict = _verdict(otlp_collector)
    assert verdict["executed_count"] == 0
    assert verdict["selection"]["answer"] == "refused"


def test_a_quarantined_failure_is_reported_as_quarantined(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    otlp_collector: conftest.OTLPCollector,
) -> None:
    # The worker marks the item; the controller folds the report. The
    # controller must still tell a quarantined failure from a user's xfail,
    # or a next attempt would be served a failure that never gated the job.
    otlp_collector.serve_quarantine(["test_suite.py::test_fails"])

    result = _run(
        pytester,
        monkeypatch,
        otlp_collector,
        served={"selection": "full", "reason": "no_predecessor"},
    )

    assert result.ret == pytest.ExitCode.OK
    verdict = _verdict(otlp_collector)
    assert verdict["failing_tests"] == []
    assert verdict["quarantined_failing_tests"] == ["test_suite.py::test_fails"]
    assert verdict["failed_count"] == 1


def test_two_runs_on_one_machine_never_share_an_answer() -> None:
    first = test_selection.XdistSelectionController()
    second = test_selection.XdistSelectionController()
    first_input: typing.Dict[str, typing.Any] = {}
    second_input: typing.Dict[str, typing.Any] = {}

    first.hand_out(first_input)
    second.hand_out(second_input)

    first_path = first_input[test_selection.XDIST_ANSWER_PATH_KEY]
    assert first_path != second_input[test_selection.XDIST_ANSWER_PATH_KEY]

    first.publish("fingerprint", frozenset({"test_suite.py::test_a"}))
    with open(first_path, encoding="utf-8") as file:
        assert json.load(file) == {
            "fingerprint": "fingerprint",
            "keep": ["test_suite.py::test_a"],
        }
    first.clean_up()
    second.clean_up()
    assert not os.path.exists(os.path.dirname(first_path))


def _worker_reading(
    tmp_path: typing.Any, answer: typing.Any, fingerprint: str = "fp"
) -> test_selection.XdistSelectionWorker:
    path = tmp_path / "answer.json"
    path.write_text(answer if isinstance(answer, str) else json.dumps(answer))
    return test_selection.XdistSelectionWorker(str(path), fingerprint=fingerprint)


@pytest.mark.parametrize(
    "answer",
    [
        # About another collection: never skip on an answer about other tests.
        {"fingerprint": "someone-else", "keep": ["t::a"]},
        "not json",
        {"fingerprint": "fp", "keep": "t::a"},
        {"fingerprint": "fp"},
    ],
    ids=["other-collection", "unreadable", "keep-not-a-list", "keep-missing"],
)
def test_a_worker_runs_everything_on_an_answer_it_cannot_trust(
    tmp_path: typing.Any, answer: typing.Any
) -> None:
    worker = _worker_reading(tmp_path, answer)

    assert not worker.skips("t::b")
    assert worker.could_not_read


def test_a_worker_skips_only_what_the_answer_leaves_out(tmp_path: typing.Any) -> None:
    worker = _worker_reading(tmp_path, {"fingerprint": "fp", "keep": ["t::a"]})

    assert not worker.skips("t::a")
    assert worker.skips("t::b")
    assert not worker.could_not_read


def test_a_worker_told_to_run_everything_does_not_compare_collections(
    tmp_path: typing.Any,
) -> None:
    # "Run everything" is written without a fingerprint when the controller
    # took none (a run outside CI); that is not an answer a worker failed to
    # read.
    worker = _worker_reading(tmp_path, {"fingerprint": None, "keep": None})

    assert not worker.skips("t::a")
    assert not worker.could_not_read


def test_a_worker_whose_answer_never_arrives_runs_everything(
    tmp_path: typing.Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(test_selection, "XDIST_ANSWER_WAIT_SECONDS", 0.1)
    worker = test_selection.XdistSelectionWorker(
        str(tmp_path / "never-written.json"), fingerprint="fp"
    )

    assert not worker.skips("t::a")
    assert worker.could_not_read
