"""The session verdict: what the plugin tells Mergify a session concluded.

Test Selection answers the next merge-queue rerun of a job from this document,
so every assertion here is about the body that leaves the plugin -- read off
what it built (`captured_session_verdict`, in-process) or off what actually
went over the wire (the collector, in a subprocess). A wrong body is
well-formed and the engine accepts it; nothing downstream would catch it.
"""

import typing

import _pytest.pytester
import pytest

import pytest_mergify
from pytest_mergify import ci_insights, session_verdict
from tests import conftest


def _run(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    code: str,
    *args: str,
    served: typing.Optional[typing.Dict[str, typing.Any]] = None,
    selection_error: typing.Optional[str] = None,
    quarantined_tests: typing.Optional[typing.List[str]] = None,
    flaky_context: typing.Optional[typing.Dict[str, typing.Any]] = None,
    setenv: typing.Optional[typing.Dict[str, typing.Optional[str]]] = None,
) -> typing.Tuple[
    _pytest.pytester.RunResult,
    pytest_mergify.PytestMergify,
    typing.Optional[typing.Dict[str, typing.Any]],
]:
    """Run `code` under the plugin in a job that opted into test selection.

    Returns the run, the plugin, and the verdict it built -- `None` when it
    built none. The same coordinates as `test_test_selection._run_with_selection`,
    so the verdict is keyed on what the selection was asked with.
    """
    conftest.set_test_environment(monkeypatch)
    monkeypatch.setenv("GITHUB_HEAD_REF", "queue/main/42")
    monkeypatch.setenv("GITHUB_SHA", "cafecafe")
    monkeypatch.setenv("GITHUB_WORKFLOW", "CI")
    monkeypatch.setenv("GITHUB_JOB", "unit")
    monkeypatch.setenv("GITHUB_RUN_ID", "4242")
    monkeypatch.setenv("GITHUB_RUN_ATTEMPT", "2")
    monkeypatch.setenv(ci_insights.TEST_SELECTION_ENABLE_ENV, "true")
    for key, value in (setenv or {}).items():
        if value is None:
            monkeypatch.delenv(key, raising=False)
        else:
            monkeypatch.setenv(key, value)

    conftest.install_fake_api_client(
        monkeypatch,
        quarantine=quarantined_tests or [],
        flaky_context=flaky_context,
        test_selection=served
        if served is not None or selection_error is not None
        # `tests` is on every answer the binding hands over, an empty list
        # on the ones carrying no subset.
        else {"selection": "full", "reason": "no_predecessor", "tests": []},
        test_selection_error=selection_error,
    )

    pytester.makepyfile(code)
    plugin = pytest_mergify.PytestMergify()
    result = pytester.runpytest_inprocess(*args, plugins=[plugin])
    return result, plugin, plugin.mergify_ci.captured_session_verdict


_THREE_TESTS = """
    def test_a():
        pass

    def test_b():
        assert False

    def test_c():
        pass
"""


def test_the_verdict_carries_the_runs_identity_and_counts(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    result, plugin, verdict = _run(pytester, monkeypatch, _THREE_TESTS)

    result.assert_outcomes(passed=2, failed=1)
    assert verdict is not None
    # The same coordinates the selection was asked with, so the engine finds
    # this session by what the next attempt knows.
    assert verdict["head_sha"] == "cafecafe"
    assert verdict["head_branch"] == "queue/main/42"
    assert verdict["pipeline_name"] == "CI"
    assert verdict["job_name"] == "unit"
    assert verdict["run_id"] == 4242
    assert verdict["run_attempt"] == 2
    # Filed under the same id as the spans: one run, one id, for support and
    # for the engine's idempotency.
    assert verdict["test_run_id"] == plugin.mergify_ci.test_run_id
    module = "test_the_verdict_carries_the_runs_identity_and_counts.py"
    assert verdict["collection_fingerprint"] == conftest.collection_fingerprint(
        [f"{module}::test_a", f"{module}::test_b", f"{module}::test_c"]
    )
    assert verdict["collection_count"] == 3
    assert verdict["executed_count"] == 3
    assert verdict["passed_count"] == 2
    assert verdict["failed_count"] == 1
    assert verdict["skipped_count"] == 0
    assert verdict["failing_tests"] == [f"{module}::test_b"]
    assert verdict["quarantined_failing_tests"] == []
    assert verdict["total_test_runtime_ms"] >= 0
    # A `full` answer, echoed as applied: the whole collection was kept.
    assert verdict["selection"] == {
        "answer": "full",
        "reason": "no_predecessor",
        "kept_count": 3,
    }


def test_the_verdict_is_keyed_on_mergify_test_job_name_when_set(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The job name the selection is asked with wins here too, or a matrix leg
    # named through MERGIFY_TEST_JOB_NAME would ask under one name and be
    # answered from a verdict filed under another.
    _, _, verdict = _run(
        pytester,
        monkeypatch,
        "def test_a(): pass",
        setenv={"MERGIFY_TEST_JOB_NAME": "unit (py3.12)"},
    )
    assert verdict is not None
    assert verdict["job_name"] == "unit (py3.12)"


def test_run_attempt_is_omitted_without_a_run_id(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A provider with no run id has nothing for an attempt to be an attempt
    # of, and the engine refuses one on its own -- a 422 nobody would see.
    _, _, verdict = _run(
        pytester,
        monkeypatch,
        "def test_a(): pass",
        setenv={"GITHUB_RUN_ID": None, "GITHUB_RUN_ATTEMPT": "3"},
    )
    assert verdict is not None
    assert "run_id" not in verdict
    assert "run_attempt" not in verdict


# --- The fold: one status per test, pytest's own -------------------------------


def test_a_rescued_test_is_not_failing(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = "test_a_rescued_test_is_not_failing.py"
    result, _, verdict = _run(
        pytester,
        monkeypatch,
        """
        import pytest

        execution_count = 0

        def test_flaky():
            global execution_count
            execution_count += 1
            if execution_count == 1:
                pytest.fail("I'm flaky!")
        """,
        flaky_context=conftest.make_flaky_context(
            flaky_test_names=[f"{module}::test_flaky"],
            max_test_execution_count=5,
            min_test_execution_count=1,
        ),
    )

    # The run is green on it, so the verdict is too: the span still carries
    # the first attempt's failure (that is what keeps the test in the flaky
    # set), but a rerun served this test would replay something that gated
    # nothing.
    assert result.ret == 0
    assert verdict is not None
    assert verdict["failing_tests"] == []
    assert verdict["passed_count"] == 1
    assert verdict["failed_count"] == 0


def test_a_test_retry_never_rescued_is_failing(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = "test_a_test_retry_never_rescued_is_failing.py"
    result, _, verdict = _run(
        pytester,
        monkeypatch,
        "def test_always_fails(): assert False",
        flaky_context=conftest.make_flaky_context(
            flaky_test_names=[f"{module}::test_always_fails"],
            max_test_execution_count=3,
            min_test_execution_count=1,
        ),
    )

    assert result.ret != 0
    assert verdict is not None
    # Three executions, one test, one entry: the fold is per node id.
    assert verdict["failing_tests"] == [f"{module}::test_always_fails"]
    assert verdict["executed_count"] == 1
    assert verdict["failed_count"] == 1


def test_a_new_mode_rerun_that_failed_makes_the_test_failing(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Flaky detection in `new` mode logs rerun failures: they are a merge
    # gate, and this run is red on one even though the test's LAST attempt
    # passed. "Final status" is pytest's verdict, not the last execution --
    # a verdict saying `passed` here would have the next rerun skip the test
    # that made this job red.
    module = "test_a_new_mode_rerun_that_failed_makes_the_test_failing.py"
    result, _, verdict = _run(
        pytester,
        monkeypatch,
        """
        import pytest

        execution_count = 0

        def test_new():
            global execution_count
            execution_count += 1
            if execution_count == 2:
                pytest.fail("flaky on the second attempt only")
        """,
        flaky_context=conftest.make_flaky_context(
            existing_test_names=[f"{module}::test_existing"],
            max_test_execution_count=3,
            min_test_execution_count=1,
        ),
    )

    assert result.ret != 0
    assert verdict is not None
    assert verdict["failing_tests"] == [f"{module}::test_new"]


def test_an_unhealthy_mode_rerun_that_failed_leaves_the_test_passed(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The mirror image: in `unhealthy` mode a rerun failure is logged as a
    # `rerun`, the run stays green, and so does the verdict.
    module = "test_an_unhealthy_mode_rerun_that_failed_leaves_the_test_passed.py"
    result, _, verdict = _run(
        pytester,
        monkeypatch,
        """
        import pytest

        execution_count = 0

        def test_unhealthy():
            global execution_count
            execution_count += 1
            if execution_count == 2:
                pytest.fail("flaky on the second attempt only")
        """,
        flaky_context=conftest.make_flaky_context(
            existing_test_names=[f"{module}::test_unhealthy"],
            unhealthy_test_names=[f"{module}::test_unhealthy"],
            max_test_execution_count=3,
            min_test_execution_count=1,
        ),
        # No base ref: a push run, which is what selects `unhealthy` mode.
        setenv={"GITHUB_BASE_REF": None, "GITHUB_REF_NAME": "main"},
    )

    assert result.ret == 0
    assert verdict is not None
    assert verdict["failing_tests"] == []
    assert verdict["passed_count"] == 1


def test_a_quarantined_failure_is_listed_apart_and_counted_as_failed(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = "test_a_quarantined_failure_is_listed_apart_and_counted_as_failed.py"
    result, _, verdict = _run(
        pytester,
        monkeypatch,
        """
        import pytest

        def test_quarantined_failure():
            assert False

        def test_quarantined_pass():
            pass

        @pytest.mark.xfail
        def test_users_own_xfail():
            assert False

        @pytest.mark.xfail(strict=True)
        def test_users_own_strict_xpass():
            pass
        """,
        quarantined_tests=[
            f"{module}::test_quarantined_failure",
            f"{module}::test_quarantined_pass",
        ],
    )

    # Red on the strict xpass alone: pytest reports a quarantined failure as
    # an expected one (and a quarantined pass as an unexpected one), and
    # nothing on the span tells the two apart. The verdict is where the
    # difference lives.
    result.assert_outcomes(passed=0, failed=1, xfailed=2, xpassed=1)
    assert verdict is not None
    assert verdict["quarantined_failing_tests"] == [
        f"{module}::test_quarantined_failure"
    ]
    assert verdict["failing_tests"] == [f"{module}::test_users_own_strict_xpass"]
    # A user's own xfail is a skip; a quarantined failure is a failure the
    # engine counts and lists apart, so failed == the two lists together.
    assert verdict["skipped_count"] == 1
    assert verdict["failed_count"] == 2
    assert verdict["passed_count"] == 1
    assert verdict["executed_count"] == 4


def test_every_test_that_ran_lands_in_exactly_one_bucket(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = "test_every_test_that_ran_lands_in_exactly_one_bucket.py"
    result, _, verdict = _run(
        pytester,
        monkeypatch,
        """
        import pytest

        @pytest.fixture
        def broken_setup():
            raise RuntimeError("setup")

        @pytest.fixture
        def broken_teardown():
            yield
            raise RuntimeError("teardown")

        def test_setup_error(broken_setup):
            pass

        def test_teardown_error(broken_teardown):
            pass

        @pytest.mark.skipif(True, reason="marked")
        def test_marked_skip():
            pass

        def test_skip_in_call():
            pytest.skip("in call")
        """,
    )

    result.assert_outcomes(passed=1, errors=2, skipped=2)
    assert verdict is not None
    # An error in either phase is a failure of the test to a rerun: the job
    # is red on it and it has to be re-executed. A pass followed by a
    # teardown error is not a pass.
    assert sorted(verdict["failing_tests"]) == [
        f"{module}::test_setup_error",
        f"{module}::test_teardown_error",
    ]
    assert verdict["failed_count"] == 2
    assert verdict["passed_count"] == 0
    assert verdict["skipped_count"] == 2
    # A marked skip runs its setup and is logged, so it counts as executed.
    assert verdict["executed_count"] == 4


def test_a_test_the_selection_did_not_keep_is_not_executed(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = "test_a_test_the_selection_did_not_keep_is_not_executed.py"
    result, _, verdict = _run(
        pytester,
        monkeypatch,
        _THREE_TESTS,
        served={
            "selection": "subset",
            "reason": "queue_rerun",
            "tests": [f"{module}::test_b"],
        },
    )

    result.assert_outcomes(failed=1, deselected=2)
    assert verdict is not None
    # The collection is the whole suite -- what the NEXT attempt collects --
    # while the counts describe what ran.
    assert verdict["collection_count"] == 3
    assert verdict["executed_count"] == 1
    assert verdict["failing_tests"] == [f"{module}::test_b"]
    assert verdict["selection"] == {
        "answer": "subset",
        "reason": "queue_rerun",
        "kept_count": 1,
    }


def test_an_answer_that_could_not_be_applied_is_echoed_with_its_reason(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A subset naming tests this run did not collect runs the full suite and
    # says why, on the verdict as on the spans (#196): `answer` and `reason`
    # stay Mergify's, `not_applied_reason` is the client's own account.
    module = "test_an_answer_that_could_not_be_applied_is_echoed_with_its_reason.py"
    result, plugin, verdict = _run(
        pytester,
        monkeypatch,
        _THREE_TESTS,
        served={
            "selection": "subset",
            "reason": "queue_rerun",
            "tests": ["somewhere_else.py::test_renamed"],
        },
    )

    result.assert_outcomes(passed=2, failed=1)
    assert verdict is not None
    assert verdict["selection"] == {
        "answer": "subset",
        "reason": "queue_rerun",
        "kept_count": 3,
        "not_applied_reason": "subset_matched_no_collected_test",
    }
    # One derivation for both documents.
    resource = plugin.mergify_ci.resource_attributes
    assert resource is not None
    assert (
        resource["test.selection.not_applied_reason"]
        == "subset_matched_no_collected_test"
    )
    assert f"{module}::test_b" in verdict["failing_tests"]


def test_an_interrupted_run_reports_only_what_it_executed(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # `-x` stops after the first failure; the two tests that never started
    # are in the collection and nowhere else. The verdict makes no claim to
    # completeness: `executed_count < kept_count` is the only signal the
    # engine could read this from, and today it does not (the spans path never
    # did either) -- raised on MRGFY-9312, not closed here.
    result, _, verdict = _run(
        pytester,
        monkeypatch,
        """
        def test_a():
            assert False

        def test_b():
            pass

        def test_c():
            pass
        """,
        "-x",
    )

    result.assert_outcomes(failed=1)
    assert verdict is not None
    assert verdict["collection_count"] == 3
    assert verdict["selection"]["kept_count"] == 3
    assert verdict["executed_count"] == 1
    assert verdict["failed_count"] == 1


# --- The answers that run nothing ------------------------------------------


def test_an_empty_selection_reports_that_it_executed_nothing(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    result, _, verdict = _run(
        pytester,
        monkeypatch,
        _THREE_TESTS,
        served={
            "selection": "empty",
            "reason": "predecessor_job_succeeded",
            "tests": [],
        },
    )

    # Green, and the verdict says why: the echo is the only thing that tells
    # "ran nothing because told to" from "ran nothing".
    assert result.ret == pytest.ExitCode.OK
    assert verdict is not None
    assert verdict["executed_count"] == 0
    assert verdict["failed_count"] == 0
    assert verdict["collection_count"] == 3
    assert verdict["selection"] == {
        "answer": "empty",
        "reason": "predecessor_job_succeeded",
        "kept_count": 0,
    }


def test_a_refused_run_still_sends_its_verdict(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    result, _, verdict = _run(
        pytester,
        monkeypatch,
        _THREE_TESTS,
        served={
            "selection": "refused",
            "reason": "ambiguous_test_sessions",
            "tests": [],
        },
    )

    # The run stops before any test, and the verdict says exactly that, as
    # the uploaded session already did: the job Mergify flagged is the one
    # it must keep seeing.
    assert result.ret == pytest.ExitCode.USAGE_ERROR
    assert verdict is not None
    assert verdict["executed_count"] == 0
    assert verdict["collection_count"] == 3
    assert verdict["selection"] == {
        "answer": "refused",
        "reason": "ambiguous_test_sessions",
        "kept_count": 0,
    }


# --- When a verdict is sent at all -------------------------------------------


def test_a_job_that_never_asked_sends_no_verdict(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    result, plugin, verdict = _run(
        pytester,
        monkeypatch,
        "def test_a(): pass",
        setenv={ci_insights.TEST_SELECTION_ENABLE_ENV: None},
    )

    result.assert_outcomes(passed=1)
    assert verdict is None
    assert not plugin.mergify_ci.session_verdict_result.sent
    # Nothing to say either: the section is the same as before this existed.
    assert "merge-queue batch is retried" not in result.stdout.str()


def test_a_run_whose_request_failed_still_sends_its_verdict(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The API may be back by session end, and the verdict is what the NEXT
    # rerun needs whatever this one was told. Gating on "was served" would
    # lose every verdict written during the kind of outage this exists for.
    result, _, verdict = _run(
        pytester,
        monkeypatch,
        _THREE_TESTS,
        selection_error="Mergify API request timed out",
    )

    result.assert_outcomes(passed=2, failed=1)
    assert verdict is not None
    assert verdict["failed_count"] == 1
    # No answer to echo: the key is absent, not a made-up `full`.
    assert "selection" not in verdict


def test_an_xdist_worker_sends_no_verdict(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, _, verdict = _run(
        pytester,
        monkeypatch,
        "def test_a(): pass",
        setenv={"PYTEST_XDIST_WORKER": "gw0"},
    )
    assert verdict is None


def test_a_collect_only_session_sends_no_verdict(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A collect-only step ahead of the real run would otherwise file a second
    # verdict under the same job and run -- an ambiguity the engine refuses
    # to guess between, which would stop the real run's successor.
    _, plugin, verdict = _run(pytester, monkeypatch, _THREE_TESTS, "--collect-only")
    assert verdict is None
    assert not plugin.mergify_ci.session_verdict_result.sent


def test_a_setup_only_session_sends_no_verdict(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, _, verdict = _run(pytester, monkeypatch, _THREE_TESTS, "--setup-only")
    assert verdict is None


def test_a_passing_setup_alone_is_not_a_passed_test() -> None:
    # Only the call phase answers for a test: a session whose tests never
    # reach it executed nothing a rerun could be answered from.
    verdict = session_verdict.SessionVerdict()
    for when in ("setup", "teardown"):
        verdict.record_logged_report(
            _report("t::a", when=when, outcome="passed"), quarantined=False
        )
    assert verdict.counts()["executed_count"] == 0
    verdict.record_logged_report(
        _report("t::a", when="call", outcome="passed"), quarantined=False
    )
    assert verdict.counts() == {
        "executed_count": 1,
        "passed_count": 1,
        "failed_count": 0,
        "skipped_count": 0,
    }


def _report(nodeid: str, when: str, outcome: str) -> typing.Any:
    class _Report:
        pass

    report = _Report()
    report.nodeid = nodeid  # type: ignore[attr-defined]
    report.when = when  # type: ignore[attr-defined]
    report.outcome = outcome  # type: ignore[attr-defined]
    report.duration = 0.0  # type: ignore[attr-defined]
    return report


def test_a_value_the_binding_refuses_never_fails_the_run(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The body is marshalled in Rust, whose refusals are `OverflowError` and
    # `TypeError`, not the `RuntimeError` of a failed request. Any of them
    # escaping here is an INTERNALERROR at session end -- and, because the
    # verdict goes first, no trace upload either.
    conftest.set_test_environment(monkeypatch)
    monkeypatch.delenv("_PYTEST_MERGIFY_TEST", raising=False)
    monkeypatch.setenv("GITHUB_HEAD_REF", "queue/main/42")
    monkeypatch.setenv("GITHUB_SHA", "cafecafe")
    monkeypatch.setenv("GITHUB_WORKFLOW", "CI")
    monkeypatch.setenv("GITHUB_JOB", "unit")
    monkeypatch.setenv(ci_insights.TEST_SELECTION_ENABLE_ENV, "true")
    conftest.install_fake_api_client(
        monkeypatch,
        test_selection={"selection": "full", "reason": "no_predecessor", "tests": []},
    )
    insights = ci_insights.MergifyCIInsights()
    assert insights.trace_mode == "upload"
    insights.on_tests_collected(["t::a"])
    assert insights.test_selection is not None

    def refuse(body: typing.Dict[str, typing.Any]) -> None:
        raise OverflowError("can't convert negative int to unsigned")

    monkeypatch.setattr(insights.api_client, "send_session_verdict", refuse)

    insights.send_session_verdict(session_verdict.SessionVerdict())

    assert insights.session_verdict_result.error == (
        "OverflowError: can't convert negative int to unsigned"
    )
    assert not insights.session_verdict_result.sent


def test_a_negative_run_attempt_is_left_out(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # What a provider hands over is not always what the engine's counter
    # takes; the attempt is dropped rather than the whole verdict refused.
    _, _, verdict = _run(
        pytester, monkeypatch, "def test_a(): pass", setenv={"GITHUB_RUN_ATTEMPT": "-1"}
    )
    assert verdict is not None
    assert verdict["run_id"] == 4242
    assert "run_attempt" not in verdict


# --- On the wire: order, failure, and the terminal ------------------------------


def _configure_opted_in_upload(
    monkeypatch: pytest.MonkeyPatch, collector: conftest.OTLPCollector
) -> None:
    conftest.configure_upload(monkeypatch, collector)
    monkeypatch.setenv("GITHUB_HEAD_REF", "queue/main/42")
    monkeypatch.setenv("GITHUB_SHA", "cafecafe")
    monkeypatch.setenv("GITHUB_WORKFLOW", "CI")
    monkeypatch.setenv("GITHUB_JOB", "unit")
    monkeypatch.setenv("GITHUB_RUN_ID", "4242")
    monkeypatch.setenv("GITHUB_RUN_ATTEMPT", "1")
    monkeypatch.setenv(ci_insights.TEST_SELECTION_ENABLE_ENV, "true")
    collector.serve_test_selection({"selection": "full", "reason": "no_predecessor"})


def test_the_verdict_is_sent_before_the_spans(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    otlp_collector: conftest.OTLPCollector,
) -> None:
    _configure_opted_in_upload(monkeypatch, otlp_collector)
    pytester.makepyfile(_THREE_TESTS)

    result = pytester.runpytest_subprocess()

    result.assert_outcomes(passed=2, failed=1)
    # The whole reason the verdict exists: it must never wait behind the
    # upload's timeout and retries.
    assert [path.rsplit("/", 1)[1] for path in otlp_collector.posted_paths] == [
        "test-session-verdicts",
        "traces",
    ]
    (verdict,) = otlp_collector.session_verdicts
    (batch,) = otlp_collector.batches
    assert verdict["failing_tests"] == [
        "test_the_verdict_is_sent_before_the_spans.py::test_b"
    ]
    # One run, one id, on both documents.
    assert verdict["test_run_id"] == batch.resource_attributes["test.run.id"]
    # GitHub's run id is an integer; the wire wants a string.
    assert verdict["run_id"] == str(batch.resource_attributes["cicd.pipeline.run.id"])
    assert f"Test run ID: {verdict['test_run_id']}" in result.stdout.str()
    # And on success, nothing else: the block above already describes the run.
    assert "merge-queue batch is retried" not in result.stdout.str()


def test_a_failed_verdict_is_reported_and_fails_nothing(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    otlp_collector: conftest.OTLPCollector,
) -> None:
    _configure_opted_in_upload(monkeypatch, otlp_collector)
    # A permanent refusal, which the client does not retry: a 5xx would be
    # ridden out with the real backoff, thirty seconds of it.
    otlp_collector.refuse_session_verdicts(422)
    pytester.makepyfile("def test_a(): pass")

    result = pytester.runpytest_subprocess()

    # Green, still uploaded, and the reader is told what the failure costs
    # them -- the next rerun -- with the bare error for support.
    assert result.ret == pytest.ExitCode.OK
    assert len(otlp_collector.batches) == 1
    # Pinned verbatim: validated by Alexandre on 2026-09-15, a change is a
    # product decision.
    result.stdout.fnmatch_lines(
        [
            "Mergify couldn't record this run's results. If this merge-queue batch is",
            "retried, this job will run its full test suite.",
            "Error: Mergify API returned HTTP 422: {}",
        ]
    )


def test_a_dormant_verdict_is_silent(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    otlp_collector: conftest.OTLPCollector,
) -> None:
    # A repository outside the pilot, or an engine that predates the route:
    # an opted-in job there must not end every run on a red line.
    _configure_opted_in_upload(monkeypatch, otlp_collector)
    otlp_collector.refuse_session_verdicts(404)
    pytester.makepyfile("def test_a(): pass")

    result = pytester.runpytest_subprocess()

    assert result.ret == pytest.ExitCode.OK
    assert len(otlp_collector.session_verdicts) == 1
    assert "merge-queue batch is retried" not in result.stdout.str()
    assert "couldn't record" not in result.stdout.str()


def test_the_run_id_is_printed_when_only_the_verdict_landed(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    otlp_collector: conftest.OTLPCollector,
) -> None:
    # The traces are refused, the verdict landed: it is filed under the id
    # support will be asked for, so the id is printed all the same.
    _configure_opted_in_upload(monkeypatch, otlp_collector)
    otlp_collector.refuse_traces(400)
    pytester.makepyfile("def test_a(): pass")

    result = pytester.runpytest_subprocess()

    assert result.ret == pytest.ExitCode.OK
    (verdict,) = otlp_collector.session_verdicts
    assert f"Test run ID: {verdict['test_run_id']}" in result.stdout.str()
    assert "Error while exporting traces" in result.stdout.str()


def test_the_atexit_backstop_sends_the_verdict_once(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, plugin, verdict = _run(pytester, monkeypatch, "def test_a(): pass")
    assert verdict is not None

    # Session finish built it once; the backstop firing afterwards is the
    # guarded no-op it is for the spans.
    plugin.mergify_ci.captured_session_verdict = None
    plugin._finalize_and_export()
    assert plugin.mergify_ci.captured_session_verdict is None

    # Had session finish never run, the backstop would send it, before the
    # spans, from the same fold.
    session_span = plugin._session_span
    assert session_span is not None
    plugin._exported = False
    plugin._finished_spans.remove(session_span)
    session_span["end_unix_nano"] = 0
    plugin._finalize_and_export()
    assert plugin.mergify_ci.captured_session_verdict == verdict


class _Lines:
    """A terminal reporter that only remembers what it was told to write."""

    def __init__(self) -> None:
        self.lines: typing.List[typing.Tuple[str, typing.Dict[str, bool]]] = []

    def write_line(self, line: str, **markup: bool) -> None:
        self.lines.append((line, markup))


def test_a_truncated_verdict_tells_the_reader_what_it_costs() -> None:
    # The run that truncated is the only place the reason will ever show:
    # the next rerun is served the full suite under an engine reason, and
    # nothing else in the product says why.
    reporter = _Lines()
    pytest_mergify._write_session_verdict_result(
        reporter,  # type: ignore[arg-type]
        session_verdict.SessionVerdictResult(sent=True, truncated=True),
    )
    ((line, markup),) = reporter.lines
    assert line == (
        "Mergify recorded this run's counts but not its failing tests. If this\n"
        "merge-queue batch is retried, this job will run its full test suite.\n"
    )
    assert markup == {"yellow": True}


def test_a_verdict_that_landed_whole_says_nothing() -> None:
    reporter = _Lines()
    pytest_mergify._write_session_verdict_result(
        reporter,  # type: ignore[arg-type]
        session_verdict.SessionVerdictResult(sent=True),
    )
    assert reporter.lines == []


def test_no_verdict_line_tells_the_reader_to_contact_support() -> None:
    # The section's one mention of support is the run id line, which is
    # information; a failure here is ours to see in our own data.
    for result in (
        session_verdict.SessionVerdictResult(error="boom"),
        session_verdict.SessionVerdictResult(sent=True, truncated=True),
    ):
        reporter = _Lines()
        pytest_mergify._write_session_verdict_result(
            reporter,  # type: ignore[arg-type]
            result,
        )
        ((line, _),) = reporter.lines
        assert "support" not in line
        assert "report" not in line
