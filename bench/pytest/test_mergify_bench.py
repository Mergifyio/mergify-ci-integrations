import pytest


def test_passes() -> None:
    pass


def test_fails() -> None:
    raise AssertionError("boom")


@pytest.mark.skip(reason="skipped on purpose")
def test_skipped() -> None:
    pass


def test_évènement() -> None:
    pass
