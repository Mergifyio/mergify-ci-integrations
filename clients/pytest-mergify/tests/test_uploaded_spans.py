import re

import _pytest.pytester
import pytest

from tests import conftest


def _configure_upload(
    monkeypatch: pytest.MonkeyPatch,
    collector: conftest.OTLPCollector,
) -> None:
    monkeypatch.setenv("CI", "true")
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    monkeypatch.setenv("GITHUB_REPOSITORY", "Mergifyio/pytest-mergify")
    monkeypatch.setenv("MERGIFY_TOKEN", "token")
    monkeypatch.setenv("MERGIFY_API_URL", collector.url)
    # Both of these swap the exporter for one that uploads nothing.
    monkeypatch.delenv("_PYTEST_MERGIFY_TEST", raising=False)
    monkeypatch.delenv("PYTEST_MERGIFY_DEBUG", raising=False)


def test_a_run_uploads_its_spans(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    otlp_collector: conftest.OTLPCollector,
) -> None:
    _configure_upload(monkeypatch, otlp_collector)
    pytester.makepyfile("def test_pass(): pass")

    result = pytester.runpytest_subprocess()

    result.assert_outcomes(passed=1)
    assert len(otlp_collector.batches) == 1
    assert otlp_collector.span_names == {
        "pytest session start",
        "test_a_run_uploads_its_spans.py::test_pass",
    }


def test_an_uploaded_span_carries_its_attributes(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    otlp_collector: conftest.OTLPCollector,
) -> None:
    # Asserting on the decoded payload rather than on terminal text: a run can
    # print a run id and still have uploaded nothing.
    _configure_upload(monkeypatch, otlp_collector)
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
    printed_run_id = re.search(r"MERGIFY_TEST_RUN_ID=(\w+)", result.stdout.str())
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
    _configure_upload(monkeypatch, otlp_collector)
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


def test_no_session_of_a_distributed_run_claims_a_fingerprint(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    otlp_collector: conftest.OTLPCollector,
) -> None:
    # Under `pytest -n`, every worker collects the whole suite and runs a share
    # of it, so all of them would report ONE identity over partial results --
    # and a worker that died before uploading would leave its siblings looking
    # complete and green. The guard that prevents it is only as good as xdist
    # keeping collection out of the controller, which is a third-party detail
    # this repo pins nowhere else; this runs the real thing rather than
    # simulating a worker with an environment variable.
    _configure_upload(monkeypatch, otlp_collector)
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
    # The run did upload -- otherwise the assertion below passes vacuously.
    assert batches
    assert any(span.name for batch in batches for span in batch.spans)
    for batch in batches:
        assert "test.collection.fingerprint" not in batch.resource_attributes
