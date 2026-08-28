import re
import typing
import xml.etree.ElementTree

import _pytest.pytester
import pytest

import pytest_mergify

from pytest_mergify import test_retry
from tests import conftest


_FLAKY_SOURCE = """
import pytest

execution_count = 0

def test_flaky():
    # Fails once, then passes: exactly what retry exists to absorb.
    global execution_count
    execution_count += 1

    if execution_count == 1:
        pytest.fail("I'm flaky!")
"""


def _retry_context(
    flaky_test_names: typing.Optional[typing.List[str]] = None,
    **kwargs: typing.Any,
) -> typing.Dict[str, typing.Any]:
    """A context for a repository that opted into test retry and nothing else.

    `existing_test_names` stays empty, as the server leaves it for a repository
    that never opted into flaky detection -- which is what makes this the
    retry-only case rather than a repository running both.
    """
    return conftest.make_flaky_context(
        flaky_test_names=flaky_test_names,
        max_test_execution_count=kwargs.pop("max_test_execution_count", 5),
        min_test_execution_count=kwargs.pop("min_test_execution_count", 1),
        **kwargs,
    )


def test_a_rescued_test_keeps_the_run_green(
    monkeypatch: pytest.MonkeyPatch,
    pytester_with_spans: conftest.PytesterWithSpanT,
) -> None:
    """The whole point: a flaky failure is answered, and Mergify still learns
    the test failed."""
    conftest.set_test_environment(monkeypatch)

    result, spans = pytester_with_spans(
        flaky_context=_retry_context(
            flaky_test_names=["test_a_rescued_test_keeps_the_run_green.py::test_flaky"],
        ),
        code=_FLAKY_SOURCE,
    )

    assert result.ret == 0

    outcomes = result.parseoutcomes()
    assert outcomes["rescued"] == 1
    assert "failed" not in outcomes

    assert re.search(
        r"""🔁 Test retry
- Used [0-9.]+ % of the budget \([0-9.]+ s/[0-9.]+ s\)
- Rescued 1 test, so they did not fail this run:
    • 'test_a_rescued_test_keeps_the_run_green\.py::test_flaky' passed on attempt 2""",
        result.stdout.str(),
        re.MULTILINE,
    )

    assert spans is not None
    span = spans["test_a_rescued_test_keeps_the_run_green.py::test_flaky"]
    # The invariant the engine's classification rests on: the wire carries the
    # initial attempt, so a rescued test stays in the flaky set that made it
    # eligible. Reporting the rescue would switch retry off on what it rescues.
    assert span["attributes"]["test.case.result.status"] == "failed"
    assert span["attributes"]["cicd.test.auto_retry"] is True
    assert span["attributes"]["cicd.test.flaky"] is True
    assert span["attributes"]["cicd.test.rerun_count"] == 1
    # Nobody asked this repository's tests to be learned from.
    assert "cicd.test.flaky_detection" not in span["attributes"]


def test_a_test_that_never_passes_still_fails_the_run(
    monkeypatch: pytest.MonkeyPatch,
    pytester_with_spans: conftest.PytesterWithSpanT,
) -> None:
    "Retry absorbs a flaky failure, never a real one."
    conftest.set_test_environment(monkeypatch)
    test_name = (
        "test_a_test_that_never_passes_still_fails_the_run.py::test_always_fails"
    )

    result, spans = pytester_with_spans(
        flaky_context=_retry_context(
            flaky_test_names=[test_name],
            max_test_execution_count=3,
        ),
        code="""
        def test_always_fails():
            assert False
        """,
    )

    assert result.ret != 0
    assert result.parseoutcomes()["failed"] == 1

    assert "- Still failing, so this run fails on it:" in result.stdout.str()
    assert f"    • '{test_name}' failed 3 times" in result.stdout.str()

    assert spans is not None
    span = spans[test_name]
    assert span["attributes"]["test.case.result.status"] == "failed"
    assert span["attributes"]["cicd.test.auto_retry"] is True
    # It never passed once, so it is broken rather than flaky.
    assert "cicd.test.flaky" not in span["attributes"]


@pytest.mark.parametrize(
    argnames=("context_kwargs", "code"),
    argvalues=[
        pytest.param(
            {"flaky_test_names": []},
            _FLAKY_SOURCE,
            id="Mergify does not classify the test as flaky",
        ),
        pytest.param(
            {
                "flaky_test_names": [],
                "broken_test_names": ["test_nothing_else_is_retried.py::test_flaky"],
            },
            _FLAKY_SOURCE,
            id="a broken test is served but never retried",
        ),
        pytest.param(
            {"flaky_test_names": ["test_nothing_else_is_retried.py::test_flaky"]},
            """
            import pytest

            @pytest.mark.mergify(auto_retry=False)
            def test_flaky():
                pytest.fail("I'm flaky, and I want to stay that way!")
            """,
            id="the test opted out of retry",
        ),
    ],
)
def test_nothing_else_is_retried(
    monkeypatch: pytest.MonkeyPatch,
    pytester_with_spans: conftest.PytesterWithSpanT,
    context_kwargs: typing.Dict[str, typing.Any],
    code: str,
) -> None:
    "Every path that leaves a failure standing as the session's own verdict."
    conftest.set_test_environment(monkeypatch)

    result, spans = pytester_with_spans(
        flaky_context=_retry_context(**context_kwargs),
        code=code,
    )

    assert result.ret != 0
    assert result.parseoutcomes()["failed"] == 1
    assert "rescued" not in result.parseoutcomes()

    assert spans is not None
    span = spans["test_nothing_else_is_retried.py::test_flaky"]
    assert span["attributes"]["test.case.result.status"] == "failed"
    assert "cicd.test.auto_retry" not in span["attributes"]


def test_a_skipped_test_is_never_retried(
    monkeypatch: pytest.MonkeyPatch,
    pytester_with_spans: conftest.PytesterWithSpanT,
) -> None:
    "A skipped test never ran, so there is no failure to answer for."
    conftest.set_test_environment(monkeypatch)

    result, spans = pytester_with_spans(
        flaky_context=_retry_context(
            flaky_test_names=["test_a_skipped_test_is_never_retried.py::test_skipped"],
        ),
        code="""
        import pytest

        def test_skipped():
            pytest.skip("I'm skipped!")
        """,
    )

    assert result.ret == 0
    assert result.parseoutcomes()["skipped"] == 1

    assert spans is not None
    span = spans["test_a_skipped_test_is_never_retried.py::test_skipped"]
    assert "cicd.test.auto_retry" not in span["attributes"]


def test_flaky_detection_reruns_answer_for_retry(
    monkeypatch: pytest.MonkeyPatch,
    pytester_with_spans: conftest.PytesterWithSpanT,
) -> None:
    """A test both mechanisms care about is rerun once, by detection.

    Retry still owns the verdict -- the run is green and the rescue is
    reported -- but it buys none of the attempts, because the ones flaky
    detection already paid for answer the same question.
    """
    conftest.set_test_environment(monkeypatch, mode="unhealthy")
    test_name = "test_flaky_detection_reruns_answer_for_retry.py::test_flaky"

    result, spans = pytester_with_spans(
        flaky_context=conftest.make_flaky_context(
            existing_test_names=[test_name],
            unhealthy_test_names=[test_name],
            flaky_test_names=[test_name],
            max_test_execution_count=3,
            min_test_execution_count=1,
        ),
        code=_FLAKY_SOURCE,
    )

    assert result.ret == 0

    outcomes = result.parseoutcomes()
    assert outcomes["rescued"] == 1
    # Two reruns, both flaky detection's: it reruns to the cap whatever the
    # outcome, where retry would have stopped at the pass.
    assert outcomes["rerun"] == 2

    # Retry spent none of its own budget, which is what "separate accounting"
    # has to mean when the two mechanisms overlap.
    assert re.search(
        r"🔁 Test retry\n- Used 0\.00 % of the budget",
        result.stdout.str(),
        re.MULTILINE,
    )
    assert f"    • '{test_name}' passed on attempt 2" in result.stdout.str()

    assert spans is not None
    span = spans[test_name]
    assert span["attributes"]["test.case.result.status"] == "failed"
    # Both mechanisms genuinely acted on this test, and the span says so.
    assert span["attributes"]["cicd.test.auto_retry"] is True
    assert span["attributes"]["cicd.test.flaky_detection"] is True


def test_nothing_to_retry_is_said_out_loud(
    monkeypatch: pytest.MonkeyPatch,
    pytester_with_spans: conftest.PytesterWithSpanT,
) -> None:
    """A repository with retry on and nothing failing still gets a line.

    Silence would be indistinguishable from retry not running at all, which is
    the one thing a reader must never have to guess about a merge gate.
    """
    conftest.set_test_environment(monkeypatch)

    result, _ = pytester_with_spans(
        flaky_context=_retry_context(
            flaky_test_names=["test_nothing_to_retry_is_said_out_loud.py::test_pass"],
        ),
        code="def test_pass(): pass",
    )

    assert result.ret == 0
    assert (
        "🔁 Test retry\n- No eligible test failed, so nothing needed retrying 👌"
        in result.stdout.str()
    )


def test_no_retry_block_without_an_eligible_set(
    monkeypatch: pytest.MonkeyPatch,
    pytester_with_spans: conftest.PytesterWithSpanT,
) -> None:
    "A repository that only opted into flaky detection hears nothing about retry."
    conftest.set_test_environment(monkeypatch)

    result, _ = pytester_with_spans(
        flaky_context=conftest.make_flaky_context(
            existing_test_names=[
                "test_no_retry_block_without_an_eligible_set.py::test_pass"
            ],
        ),
        code="def test_pass(): pass",
    )

    assert "🔁 Test retry" not in result.stdout.str()


def test_budget_exhaustion_is_said_out_loud(
    monkeypatch: pytest.MonkeyPatch,
    pytester_with_spans: conftest.PytesterWithSpanT,
) -> None:
    """A failure retry could not afford to answer is not a verdict on the test.

    The one surface anywhere that shows retry doing less than a reader would
    assume, so it has to say so rather than let the plain failure imply the
    test was given its chances.
    """
    conftest.set_test_environment(monkeypatch)
    test_name = "test_budget_exhaustion_is_said_out_loud.py::test_flaky"

    result, _ = pytester_with_spans(
        flaky_context=_retry_context(
            flaky_test_names=[test_name],
            # No budget at all: not even a first retry fits.
            existing_tests_mean_duration_ms=0,
            min_budget_duration_ms=0,
        ),
        code=_FLAKY_SOURCE,
    )

    assert result.ret != 0
    assert result.parseoutcomes()["failed"] == 1

    assert f"""⚠️ Retry could not afford another attempt, so this failure is not a verdict on the test:
    • '{test_name}'""" in result.stdout.str()


def test_xdist_workers_retry_and_the_controller_reports_it() -> None:
    """The worker lifecycle: context in, verdicts on the worker, one report out.

    Workers cannot see each other's budgets, so each decides its own verdicts
    and only the summary is assembled on the controller, which is the only
    process with a terminal.
    """
    context = conftest.make_flaky_context(
        flaky_test_names=["a.py::test_flaky"],
        min_test_execution_count=1,
    )

    retrier = test_retry.TestRetrier.from_context_dict(context, is_xdist=True)
    retrier._eligible_tests = {"a.py::test_flaky"}
    retrier._tests_to_process = ["a.py::test_flaky"]
    retrier._record_attempt("a.py::test_flaky", "failed")
    retrier._record_attempt("a.py::test_flaky", "passed")

    assert retrier._is_xdist is True
    assert retrier.has_rescued("a.py::test_flaky")

    # A controller that heard from nobody has nothing to say, so the block is
    # not written at all.
    assert not test_retry.XdistTestRetryController().has_metrics

    controller = test_retry.XdistTestRetryController()
    controller.collect_worker_metrics(retrier.to_serializable_metrics())

    assert controller.has_metrics
    assert "    • 'a.py::test_flaky' passed on attempt 2" in controller.make_report()


def test_a_rescue_reads_as_a_pass_to_every_other_consumer(
    monkeypatch: pytest.MonkeyPatch,
    pytester: _pytest.pytester.Pytester,
) -> None:
    """The rescued outcome has to be one pytest core knows.

    An invented one leaves `report.passed`, `.failed` and `.skipped` all
    false, and every stock consumer then drops the test without a word --
    junitxml counted a rescued run as `tests="0"` while emitting the testcase
    anyway, which is a report no CI system can read correctly.
    """
    conftest.set_test_environment(monkeypatch)
    conftest.install_fake_api_client(
        monkeypatch,
        flaky_context=_retry_context(
            flaky_test_names=[
                "test_a_rescue_reads_as_a_pass_to_every_other_consumer.py::test_flaky",
            ],
        ),
    )

    pytester.makepyfile(_FLAKY_SOURCE)
    junit_report = pytester.path / "junit.xml"
    result = pytester.runpytest_inprocess(
        f"--junitxml={junit_report}",
        plugins=[pytest_mergify.PytestMergify()],
    )

    assert result.ret == 0
    # Still its own category in the terminal, which is the whole reason for
    # carrying a mark rather than reporting a bare pass.
    assert result.parseoutcomes()["rescued"] == 1

    suite = xml.etree.ElementTree.parse(junit_report).getroot().find("testsuite")
    assert suite is not None
    assert suite.get("tests") == "1"
    assert suite.get("failures") == "0"
    testcase = suite.find("testcase")
    assert testcase is not None
    assert testcase.find("failure") is None


def test_retry_does_not_silence_the_new_flaky_test_gate(
    monkeypatch: pytest.MonkeyPatch,
    pytester_with_spans: conftest.PytesterWithSpanT,
) -> None:
    """A test the server calls both new and flaky stays gated.

    In `new` mode a rerun failure is the merge protection that stops a newly
    flaky test from landing. The two server sets can disagree -- a baseline
    lags a rename or a re-parametrization -- and absorbing the failure there
    would turn that gate off without anyone asking.
    """
    conftest.set_test_environment(monkeypatch)
    module = "test_retry_does_not_silence_the_new_flaky_test_gate.py"

    result, spans = pytester_with_spans(
        flaky_context=conftest.make_flaky_context(
            # The baseline knows only the other test, so `test_flaky` is new...
            existing_test_names=[f"{module}::test_existing"],
            # ...while the eligible set already calls it flaky.
            flaky_test_names=[f"{module}::test_flaky"],
            max_test_execution_count=3,
            min_test_execution_count=1,
        ),
        code="""
        import pytest

        execution_count = 0

        def test_existing():
            assert True

        def test_flaky():
            global execution_count
            execution_count += 1

            if execution_count == 1:
                pytest.fail("I'm flaky!")
        """,
    )

    assert result.ret != 0
    assert "rescued" not in result.parseoutcomes()

    assert spans is not None
    assert "cicd.test.auto_retry" not in spans[f"{module}::test_flaky"]["attributes"]


def test_a_retry_only_repository_hears_nothing_about_flaky_detection(
    monkeypatch: pytest.MonkeyPatch,
    pytester_with_spans: conftest.PytesterWithSpanT,
) -> None:
    """Push runs pick `unhealthy` mode, which has no empty-baseline guard.

    A repository that opted into retry alone is served both detection lists
    empty, and would otherwise be told on every push that a mechanism it never
    enabled is watching its tests.
    """
    conftest.set_test_environment(monkeypatch, mode="unhealthy")
    module = "test_a_retry_only_repository_hears_nothing_about_flaky_detection.py"

    result, _ = pytester_with_spans(
        flaky_context=_retry_context(flaky_test_names=[f"{module}::test_flaky"]),
        code=_FLAKY_SOURCE,
    )

    assert result.ret == 0
    assert result.parseoutcomes()["rescued"] == 1
    assert "🐛 Flaky detection" not in result.stdout.str()
    assert "🔁 Test retry" in result.stdout.str()
