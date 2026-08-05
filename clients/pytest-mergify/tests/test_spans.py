import anys

import pytest

import pytest_mergify
from tests import conftest


def test_span(
    pytester_with_spans: conftest.PytesterWithSpanT,
) -> None:
    result, spans = pytester_with_spans()
    assert spans is not None
    assert set(spans.keys()) == {
        "pytest session start",
        "test_span.py::test_pass",
    }


def test_session_without_traceparent(
    pytester_with_spans: conftest.PytesterWithSpanT,
) -> None:
    result, spans = pytester_with_spans()
    assert spans is not None
    s = spans["pytest session start"]
    assert s["attributes"] == {"test.scope": "session"}
    assert s["status"] == "ok"
    assert s["parent_span_id"] is None


def test_session_with_traceparent(
    pytester_with_spans: conftest.PytesterWithSpanT,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        "MERGIFY_TRACEPARENT", "00-80e1afed08e019fc1110464cfa66635c-7a085853722dc6d2-01"
    )

    result, spans = pytester_with_spans()
    assert spans is not None
    s = spans["pytest session start"]
    assert s["attributes"] == {"test.scope": "session"}
    assert s["status"] == "ok"
    assert s["parent_span_id"] == bytes.fromhex("7a085853722dc6d2")
    assert s["trace_id"] == bytes.fromhex("80e1afed08e019fc1110464cfa66635c")


def test_session_fail(
    pytester_with_spans: conftest.PytesterWithSpanT,
) -> None:
    result, spans = pytester_with_spans("def test_fail(): assert False")
    assert spans is not None
    s = spans["pytest session start"]
    assert s["attributes"] == {"test.scope": "session"}
    assert s["status"] == "error"


def test_test(
    pytester_with_spans: conftest.PytesterWithSpanT,
) -> None:
    result, spans = pytester_with_spans()
    assert spans is not None
    session_span = spans["pytest session start"]

    assert spans["test_test.py::test_pass"]["attributes"] == {
        "test.scope": "case",
        "code.function": "test_pass",
        "code.lineno": 0,
        "code.filepath": "test_test.py",
        "code.namespace": "",
        "test.case.result.status": "passed",
        "code.file.path": anys.ANY_STR,
        "code.line.number": 0,
        "cicd.test.quarantined": False,
    }
    assert spans["test_test.py::test_pass"]["status"] == "ok"
    assert spans["test_test.py::test_pass"]["parent_span_id"] is not None
    assert spans["test_test.py::test_pass"]["parent_span_id"] == session_span["span_id"]


def test_test_failure(
    pytester_with_spans: conftest.PytesterWithSpanT,
) -> None:
    result, spans = pytester_with_spans("def test_error(): assert False, 'foobar'")
    assert spans is not None
    session_span = spans["pytest session start"]

    assert spans["test_test_failure.py::test_error"]["attributes"] == {
        "test.case.result.status": "failed",
        "test.scope": "case",
        "code.function": "test_error",
        "code.lineno": 0,
        "code.filepath": "test_test_failure.py",
        "code.namespace": "",
        "exception.type": "AssertionError",
        "exception.message": "foobar\nassert False",
        "exception.stacktrace": """>   def test_error(): assert False, 'foobar'
E   AssertionError: foobar
E   assert False

test_test_failure.py:1: AssertionError""",
        "code.file.path": anys.ANY_STR,
        "code.line.number": 0,
        "cicd.test.quarantined": False,
    }
    assert spans["test_test_failure.py::test_error"]["status"] == "error"
    assert (
        spans["test_test_failure.py::test_error"]["status_message"]
        == "<class 'AssertionError'>: foobar\nassert False"
    )
    assert spans["test_test_failure.py::test_error"]["parent_span_id"] is not None
    assert (
        spans["test_test_failure.py::test_error"]["parent_span_id"]
        == session_span["span_id"]
    )


def test_test_skipped(
    pytester_with_spans: conftest.PytesterWithSpanT,
) -> None:
    result, spans = pytester_with_spans("""
import pytest
def test_skipped():
    pytest.skip('not needed')
""")
    assert spans is not None
    session_span = spans["pytest session start"]

    assert spans["test_test_skipped.py::test_skipped"]["attributes"] == {
        "test.case.result.status": "skipped",
        "test.scope": "case",
        "code.function": "test_skipped",
        "code.lineno": 1,
        "code.filepath": "test_test_skipped.py",
        "code.namespace": "",
        "code.file.path": anys.ANY_STR,
        "code.line.number": 1,
        "cicd.test.quarantined": False,
    }
    assert spans["test_test_skipped.py::test_skipped"]["status"] == "ok"
    assert spans["test_test_skipped.py::test_skipped"]["parent_span_id"] is not None
    assert (
        spans["test_test_skipped.py::test_skipped"]["parent_span_id"]
        == session_span["span_id"]
    )


@pytest.mark.parametrize(
    "mark",
    [
        "skip",
        "skipif(True, reason='not needed')",
        "skipif(1 + 1, reason='with eval')",
        "skipif('1 + 1', reason='as str')",
        "skipif('sys.version_info.major > 1', reason='not needed')",
        "skipif(condition=True, reason='as kwarg')",
        "skipif(reason='unconditional')",
    ],
)
def test_mark_skipped(
    mark: str,
    pytester_with_spans: conftest.PytesterWithSpanT,
) -> None:
    result, spans = pytester_with_spans(f"""
import pytest
@pytest.mark.{mark}
def test_skipped():
    assert False
""")
    assert spans is not None
    session_span = spans["pytest session start"]

    assert spans["test_mark_skipped.py::test_skipped"]["attributes"] == {
        "test.case.result.status": "skipped",
        "test.scope": "case",
        "code.function": "test_skipped",
        "code.lineno": 1,
        "code.filepath": "test_mark_skipped.py",
        "code.namespace": "",
        "code.file.path": anys.ANY_STR,
        "code.line.number": 1,
        "cicd.test.quarantined": False,
    }
    assert spans["test_mark_skipped.py::test_skipped"]["status"] == "unset"
    assert spans["test_mark_skipped.py::test_skipped"]["parent_span_id"] is not None
    assert (
        spans["test_mark_skipped.py::test_skipped"]["parent_span_id"]
        == session_span["span_id"]
    )


def test_mark_skipped_by_an_outer_mark(
    pytester_with_spans: conftest.PytesterWithSpanT,
) -> None:
    # The mark nearest the test does not decide the outcome on its own: pytest
    # skips as soon as any skipif mark matches.
    result, spans = pytester_with_spans("""
import pytest
pytestmark = pytest.mark.skipif(True, reason='whole module')

@pytest.mark.skipif(False, reason='but not this one')
def test_skipped():
    assert False
""")
    result.assert_outcomes(skipped=1)
    assert spans is not None
    assert spans["test_mark_skipped_by_an_outer_mark.py::test_skipped"][
        "attributes"
    ] == {
        "test.case.result.status": "skipped",
        "test.scope": "case",
        "code.function": "test_skipped",
        "code.lineno": 3,
        "code.filepath": "test_mark_skipped_by_an_outer_mark.py",
        "code.namespace": "",
        "code.file.path": anys.ANY_STR,
        "code.line.number": 3,
        "cicd.test.quarantined": False,
    }


def test_mark_skipped_by_a_later_condition(
    pytester_with_spans: conftest.PytesterWithSpanT,
) -> None:
    # `skipif` accepts several conditions and skips as soon as one of them
    # holds, so reading only the first would report this test as executed.
    result, spans = pytester_with_spans("""
import pytest
@pytest.mark.skipif(False, True, reason='the second one')
def test_skipped():
    assert False
""")
    result.assert_outcomes(skipped=1)
    assert spans is not None
    assert spans["test_mark_skipped_by_a_later_condition.py::test_skipped"][
        "attributes"
    ] == {
        "test.case.result.status": "skipped",
        "test.scope": "case",
        "code.function": "test_skipped",
        "code.lineno": 1,
        "code.filepath": "test_mark_skipped_by_a_later_condition.py",
        "code.namespace": "",
        "code.file.path": anys.ANY_STR,
        "code.line.number": 1,
        "cicd.test.quarantined": False,
    }


def test_mark_skipped_with_an_unresolvable_condition(
    pytester_with_spans: conftest.PytesterWithSpanT,
) -> None:
    # pytest turns a condition it cannot evaluate into one clean error on the
    # test. Reading the same mark to build a span must not turn it into the end
    # of the session.
    result, _ = pytester_with_spans("""
import pytest
@pytest.mark.skipif('undefined_symbol_xyz', reason='broken')
def test_broken():
    pass
""")
    assert "INTERNALERROR" not in result.stdout.str()
    result.assert_outcomes(errors=1)


def test_mark_not_skipped(
    pytester_with_spans: conftest.PytesterWithSpanT,
) -> None:
    result, spans = pytester_with_spans("""
import pytest
@pytest.mark.skipif(False, reason='not skipped')
def test_not_skipped():
    assert True
""")
    assert spans is not None
    session_span = spans["pytest session start"]

    assert spans["test_mark_not_skipped.py::test_not_skipped"]["attributes"] == {
        "test.case.result.status": "passed",
        "test.scope": "case",
        "code.function": "test_not_skipped",
        "code.lineno": 1,
        "code.filepath": "test_mark_not_skipped.py",
        "code.namespace": "",
        "code.file.path": anys.ANY_STR,
        "code.line.number": 1,
        "cicd.test.quarantined": False,
    }
    assert spans["test_mark_not_skipped.py::test_not_skipped"]["status"] == "ok"
    assert (
        spans["test_mark_not_skipped.py::test_not_skipped"]["parent_span_id"]
        is not None
    )
    assert (
        spans["test_mark_not_skipped.py::test_not_skipped"]["parent_span_id"]
        == session_span["span_id"]
    )


def test_span_attributes_namespace(
    pytester_with_spans: conftest.PytesterWithSpanT,
) -> None:
    result, spans = pytester_with_spans("""
import pytest

class TestClassBasic:
    def test_namespace(self):
        assert True

def test_namespace():
    assert True


@pytest.mark.parametrize("hello", ["foo", "bar"])
def test_parametrized(hello):
    assert True
""")
    assert spans is not None

    assert "test_span_attributes_namespace.py::test_namespace" in spans
    assert "test_span_attributes_namespace.py::TestClassBasic::test_namespace" in spans
    assert "test_span_attributes_namespace.py::test_parametrized[foo]" in spans
    assert "test_span_attributes_namespace.py::test_parametrized[bar]" in spans


def test_span_resources_test_run_id(
    pytester_with_spans: conftest.PytesterWithSpanT,
) -> None:
    result, spans = pytester_with_spans()
    assert spans is not None
    run_id = spans.resource["test.run.id"]
    assert isinstance(run_id, str)
    assert len(run_id) == 16
    assert int(run_id, 16) > 0


def test_atexit_backstop(
    pytester: pytest.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CI", "true")
    monkeypatch.setenv("_PYTEST_MERGIFY_TEST", "true")
    conftest.install_fake_api_client(monkeypatch, quarantine=[])

    plugin = pytest_mergify.PytestMergify()
    pytester.makepyfile("def test_pass(): pass")
    pytester.runpytest_inprocess(plugins=[plugin])

    session_span = plugin._session_span
    assert session_span is not None

    # pytest_sessionfinish exported once; the atexit backstop firing afterwards
    # is a guarded no-op -- the spans are not exported (or appended) twice.
    assert plugin._exported is True
    n_spans = len(plugin._finished_spans)
    plugin._finalize_and_export()
    assert plugin._exported is True
    assert len(plugin._finished_spans) == n_spans

    # If session finish had NOT run, the backstop closes the (still-open) session
    # span and exports everything itself.
    plugin._exported = False
    plugin._finished_spans.remove(session_span)
    session_span["end_unix_nano"] = 0
    plugin._finalize_and_export()
    assert plugin._exported is True
    assert session_span in plugin._finished_spans
    assert session_span["end_unix_nano"] != 0
