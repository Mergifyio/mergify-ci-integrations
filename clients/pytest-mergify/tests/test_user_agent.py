import contextlib
import importlib.metadata
import sys

import _pytest.pytester
import pytest

from pytest_mergify import _mergify_ci
from tests import conftest


def test_every_request_names_the_installed_plugin(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    otlp_collector: conftest.OTLPCollector,
) -> None:
    # The binding reads its version back from the wheel's metadata on its own,
    # so nothing on the Python side would notice that lookup going wrong: every
    # install would just report `unknown`. A real run in a subprocess is what
    # exercises it.
    conftest.configure_upload(monkeypatch, otlp_collector)
    pytester.makepyfile("def test_pass(): pass")

    result = pytester.runpytest_subprocess()

    result.assert_outcomes(passed=1)
    version = importlib.metadata.version("pytest-mergify")
    python = "{}.{}.{}".format(*sys.version_info[:3])
    assert otlp_collector.user_agents
    for user_agent in otlp_collector.user_agents:
        assert user_agent.startswith(f"pytest-mergify/{version} (python/{python}; ")


def test_a_plugin_without_metadata_still_builds_its_client(
    monkeypatch: pytest.MonkeyPatch,
    otlp_collector: conftest.OTLPCollector,
) -> None:
    def not_installed(name: str) -> str:
        raise importlib.metadata.PackageNotFoundError(name)

    monkeypatch.setattr(importlib.metadata, "version", not_installed)

    # Only a source tree that was never installed gets here. The User-Agent is
    # telemetry: it reports an unknown version rather than costing the run the
    # client its quarantine and uploads go through.
    client = _mergify_ci.CiApiClient(otlp_collector.url, "token", "owner", "repo")
    # The collector has no quarantine to serve; only the request it received
    # matters here, not how the client took the answer.
    with contextlib.suppress(RuntimeError):
        client.fetch_quarantine("main")

    assert otlp_collector.user_agents
    for user_agent in otlp_collector.user_agents:
        assert user_agent.startswith("pytest-mergify/unknown (python/")
