import re
import typing

import pytest

from tests import conftest


def test_span_resources_attributes_ci(
    pytester_with_spans: conftest.PytesterWithSpanT,
) -> None:
    result, spans = pytester_with_spans()
    assert spans is not None
    assert spans.resource["cicd.provider.name"] == "pytest_mergify_suite"


def test_span_resources_attributes_pytest(
    pytester_with_spans: conftest.PytesterWithSpanT,
) -> None:
    result, spans = pytester_with_spans()
    assert spans is not None
    assert spans.resource["test.framework"] == "pytest"
    assert re.match(
        r"\d\.",
        typing.cast(str, spans.resource["test.framework.version"]),
    )
    # The engine reads the test's programming language from
    # telemetry.sdk.language (the attribute the OTel SDK set before the binding
    # migration), so keep setting it or span_test.test_programming_language
    # goes NULL instead of "python".
    assert spans.resource["telemetry.sdk.language"] == "python"


def test_span_resources_attributes_mergify(
    pytester_with_spans: conftest.PytesterWithSpanT,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MERGIFY_TEST_JOB_NAME", "f00b4r")

    result, spans = pytester_with_spans()
    assert spans is not None
    assert spans.resource["mergify.test.job.name"] == "f00b4r"


def test_span_github_actions(
    monkeypatch: pytest.MonkeyPatch,
    pytester_with_spans: conftest.PytesterWithSpanT,
) -> None:
    # Do a partial reconfig, half GHA, half local to have spans
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    monkeypatch.setenv("GITHUB_REPOSITORY", "Mergifyio/pytest-mergify")
    monkeypatch.setenv("GITHUB_SERVER_URL", "https://github.com")
    monkeypatch.setenv("GITHUB_RUN_ID", "3213121312")
    monkeypatch.setenv("RUNNER_NAME", "self-hosted")
    result, spans = pytester_with_spans()
    assert spans is not None
    assert spans.resource["vcs.repository.name"] == "Mergifyio/pytest-mergify"
    assert (
        spans.resource["vcs.repository.url.full"]
        == "https://github.com/Mergifyio/pytest-mergify"
    )
    assert spans.resource["cicd.pipeline.run.id"] == 3213121312
    assert spans.resource["cicd.pipeline.runner.name"] == "self-hosted"


def test_span_jenkins(
    monkeypatch: pytest.MonkeyPatch,
    pytester_with_spans: conftest.PytesterWithSpanT,
) -> None:
    monkeypatch.setenv("GITHUB_ACTIONS", "false")
    monkeypatch.setenv("JENKINS_URL", "https://jenkins.example.com")
    monkeypatch.setenv(
        "BUILD_URL", "https://jenkins.example.com/Mergifyio/pytest-mergify"
    )
    monkeypatch.setenv("BUILD_ID", "jenkins-job-name#5")
    monkeypatch.setenv("JOB_NAME", "jenkins-job-name")
    monkeypatch.setenv("GIT_URL", "https://github.com/Mergifyio/pytest-mergify")
    monkeypatch.setenv("GIT_BRANCH", "origin/main")
    monkeypatch.setenv("GIT_COMMIT", "1860cf377dd5610e256ff52e47cf38816cc04549")
    monkeypatch.setenv("NODE_NAME", "self-hosted")
    result, spans = pytester_with_spans()
    assert spans is not None
    assert spans.resource["vcs.repository.name"] == "Mergifyio/pytest-mergify"
    assert (
        spans.resource["vcs.repository.url.full"]
        == "https://github.com/Mergifyio/pytest-mergify"
    )
    assert spans.resource["cicd.pipeline.run.id"] == "jenkins-job-name#5"
    assert spans.resource["cicd.pipeline.runner.name"] == "self-hosted"


def test_span_circleci(
    monkeypatch: pytest.MonkeyPatch,
    pytester_with_spans: conftest.PytesterWithSpanT,
) -> None:
    monkeypatch.setenv("GITHUB_ACTIONS", "false")
    monkeypatch.setenv("CIRCLECI", "true")
    monkeypatch.setenv("CIRCLE_JOB", "unit-tests")
    monkeypatch.setenv("CIRCLE_WORKFLOW_ID", "8f2a1c44-0b6e-4c7a-9d3f-1e5b7a9c2d40")
    monkeypatch.setenv(
        "CIRCLE_BUILD_URL", "https://circleci.com/gh/Mergifyio/pytest-mergify/42"
    )
    monkeypatch.setenv("CIRCLE_BRANCH", "main")
    monkeypatch.setenv("CIRCLE_SHA1", "1860cf377dd5610e256ff52e47cf38816cc04549")
    monkeypatch.setenv(
        "CIRCLE_REPOSITORY_URL", "https://github.com/Mergifyio/pytest-mergify"
    )

    result, spans = pytester_with_spans()

    assert spans is not None
    assert spans.resource["cicd.provider.name"] == "circleci"
    assert spans.resource["vcs.repository.name"] == "Mergifyio/pytest-mergify"
    assert spans.resource["vcs.ref.head.name"] == "main"
    assert (
        spans.resource["vcs.ref.head.revision"]
        == "1860cf377dd5610e256ff52e47cf38816cc04549"
    )
    assert spans.resource["cicd.pipeline.run.id"] == (
        "8f2a1c44-0b6e-4c7a-9d3f-1e5b7a9c2d40"
    )
    # CircleCI publishes no workflow name, so the job name serves as both.
    assert spans.resource["cicd.pipeline.name"] == "unit-tests"
    assert spans.resource["cicd.pipeline.task.name"] == "unit-tests"
