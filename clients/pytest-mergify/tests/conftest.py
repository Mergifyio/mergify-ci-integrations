import pytest

pytest_plugins = ["pytester"]


@pytest.fixture(autouse=True)
def set_ci(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CI", "1")
