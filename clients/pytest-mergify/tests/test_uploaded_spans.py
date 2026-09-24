import re

import _pytest.pytester
import pytest

from pytest_mergify import utils
from tests import conftest


def test_a_run_uploads_its_spans(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    otlp_collector: conftest.OTLPCollector,
) -> None:
    conftest.configure_upload(monkeypatch, otlp_collector)
    pytester.makepyfile("def test_pass(): pass")

    result = pytester.runpytest_subprocess()

    result.assert_outcomes(passed=1)
    assert len(otlp_collector.batches) == 1
    assert otlp_collector.span_names == {
        "pytest session start",
        "test_a_run_uploads_its_spans.py::test_pass",
    }


def test_spans_are_reported_under_the_plugin_scope(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    otlp_collector: conftest.OTLPCollector,
) -> None:
    conftest.configure_upload(monkeypatch, otlp_collector)
    pytester.makepyfile("def test_pass(): pass")

    result = pytester.runpytest_subprocess()

    result.assert_outcomes(passed=1)
    (batch,) = otlp_collector.batches
    assert batch.scopes == [("pytest-mergify", utils.get_version())]


def test_an_uploaded_span_carries_its_attributes(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    otlp_collector: conftest.OTLPCollector,
) -> None:
    # Asserting on the decoded payload rather than on terminal text: a run can
    # print a run id and still have uploaded nothing.
    conftest.configure_upload(monkeypatch, otlp_collector)
    pytester.makepyfile("def test_pass(): pass")

    result = pytester.runpytest_subprocess()

    # Asserted before the payload, so a run that died on the way to uploading
    # reads as the failure it is rather than as a missing key.
    result.assert_outcomes(passed=1)
    (batch,) = otlp_collector.batches
    span = batch.span("test_an_uploaded_span_carries_its_attributes.py::test_pass")

    assert span.attributes["test.case.result.status"] == "passed"
    assert span.attributes["test.scope"] == "case"
    assert (
        batch.resource_attributes["vcs.repository.name"] == "Mergifyio/pytest-mergify"
    )
    # The id the run reported to the user has to be the one it filed the spans
    # under, or the summary sends them looking up somebody else's run.
    printed_run_id = re.search(r"Test run ID: (\w+)", result.stdout.str())
    assert printed_run_id is not None
    assert batch.resource_attributes["test.run.id"] == printed_run_id.group(1)


def test_the_uploaded_fingerprint_describes_the_uploaded_tests(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    otlp_collector: conftest.OTLPCollector,
) -> None:
    # The fingerprint is computed from the collection and the test names are
    # reported one span at a time, so nothing inside the plugin makes the two
    # agree. Rebuilding the fingerprint from what actually arrived is what
    # catches them drifting apart -- the failure mode of MRGFY-8695, where a
    # runner built one name and its reporter uploaded another, and quarantine
    # silently matched nothing ever after.
    conftest.configure_upload(monkeypatch, otlp_collector)
    pytester.makepyfile(
        """
        import pytest

        def test_one():
            pass

        def test_two():
            pass

        @pytest.mark.parametrize("value", [1, 2])
        def test_parametrized(value):
            pass
        """
    )

    result = pytester.runpytest_subprocess()

    result.assert_outcomes(passed=4)
    (batch,) = otlp_collector.batches
    # One span per collected test. A set, because the fingerprint is the
    # identity of a *set* of node ids -- and because a rerun would upload the
    # same name twice (none happens here: nothing served a flaky context).
    uploaded_test_ids = {
        span.name for span in batch.spans if span.attributes.get("test.scope") == "case"
    }
    assert len(uploaded_test_ids) == 4

    assert batch.resource_attributes[
        "test.collection.fingerprint"
    ] == conftest.collection_fingerprint(uploaded_test_ids)


def test_only_the_controller_of_a_distributed_run_claims_a_fingerprint(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    otlp_collector: conftest.OTLPCollector,
) -> None:
    # Under `pytest -n`, every worker collects the whole suite and runs a share
    # of it, so a worker claiming the collection's identity would report ONE
    # identity over partial results -- and a worker that died before uploading
    # would leave its siblings looking complete and green. The run's identity
    # is the controller's to claim: it is the one process that knows the whole
    # collection and asks for the selection on it (MRGFY-8632). This runs the
    # real thing rather than simulating a worker with an environment variable.
    conftest.configure_upload(monkeypatch, otlp_collector)
    pytester.makepyfile(
        """
        def test_one(): pass
        def test_two(): pass
        def test_three(): pass
        """
    )

    result = pytester.runpytest_subprocess("-n", "2")

    result.assert_outcomes(passed=3)
    batches = otlp_collector.batches
    workers = [
        batch
        for batch in batches
        if any(span.attributes.get("test.scope") == "case" for span in batch.spans)
    ]
    # The run did upload its tests -- otherwise the assertion below passes
    # vacuously.
    assert workers
    for batch in workers:
        assert "test.collection.fingerprint" not in batch.resource_attributes
    (controller,) = [batch for batch in batches if batch not in workers]
    assert controller.resource_attributes[
        "test.collection.fingerprint"
    ] == conftest.collection_fingerprint(
        f"test_only_the_controller_of_a_distributed_run_claims_a_fingerprint.py::{name}"
        for name in ("test_one", "test_two", "test_three")
    )
    assert controller.resource_attributes["test.collection.count"] == 3
