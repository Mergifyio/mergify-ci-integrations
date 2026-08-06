import importlib.metadata

import pytest

from pytest_mergify.utils import get_version, is_in_ci


@pytest.mark.parametrize(
    argnames=("value", "expected"),
    argvalues=[
        pytest.param("true", True, id="boolean-true"),
        pytest.param("1", True, id="boolean-one"),
        pytest.param("false", False, id="boolean-false"),
        pytest.param("0", False, id="boolean-zero"),
        # Woodpecker and Drone set `CI` to their own name rather than a boolean.
        pytest.param("woodpecker", True, id="provider-name"),
        pytest.param("drone", True, id="other-provider-name"),
        # A workflow whose `env: CI: ${{ ... }}` resolved to nothing.
        pytest.param("", False, id="empty"),
        pytest.param("   ", False, id="blank"),
        # A YAML block scalar keeps the newline its author did not intend.
        pytest.param("false ", False, id="boolean-false-with-trailing-space"),
        pytest.param(" 0", False, id="boolean-zero-with-leading-space"),
        pytest.param("true\n", True, id="boolean-true-with-newline"),
    ],
)
def test_is_in_ci_accepts_any_value(
    monkeypatch: pytest.MonkeyPatch,
    value: str,
    expected: bool,
) -> None:
    monkeypatch.setenv("CI", value)
    monkeypatch.delenv("PYTEST_MERGIFY_ENABLE", raising=False)

    assert is_in_ci() is expected


def test_get_version_reads_the_installed_distribution() -> None:
    assert get_version() == importlib.metadata.version("pytest-mergify")


def test_get_version_falls_back_when_not_installed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def not_installed(name: str) -> str:
        raise importlib.metadata.PackageNotFoundError(name)

    monkeypatch.setattr(importlib.metadata, "version", not_installed)

    # The User-Agent is telemetry: a plugin running from an uninstalled source
    # tree reports an unknown version rather than breaking the session.
    assert get_version() == "unknown"
