from tests import conftest


def test_spans_quarantine(
    pytester_with_spans: conftest.PytesterWithSpanT,
) -> None:
    result, spans = pytester_with_spans(
        """
import pytest

def test_my_not_flaky_success_test():
    assert True

def test_my_not_flaky_failure_test():
    assert False

def test_my_very_flaky_failure_test():
    assert False

def test_my_very_flaky_success_test():
    assert True
""",
        setenv={
            "MERGIFY_TOKEN": "foobar",
            "GITHUB_ACTIONS": "true",
            "GITHUB_BASE_REF": "main",
            "GITHUB_REPOSITORY": "foo/bar",
        },
        quarantined_tests=[
            "test_spans_quarantine.py::test_my_very_flaky_failure_test",
            "test_spans_quarantine.py::test_my_very_flaky_success_test",
            "test_spans_quarantine.py::some_other_test",
        ],
    )
    assert spans is not None

    not_flaky_success = spans[
        "test_spans_quarantine.py::test_my_not_flaky_success_test"
    ]
    assert not_flaky_success["status"] == "ok"
    assert not not_flaky_success["attributes"]["cicd.test.quarantined"]

    not_flaky_failure = spans[
        "test_spans_quarantine.py::test_my_not_flaky_failure_test"
    ]
    assert not_flaky_failure["status"] == "error"
    assert not not_flaky_failure["attributes"]["cicd.test.quarantined"]

    very_flaky_failure = spans[
        "test_spans_quarantine.py::test_my_very_flaky_failure_test"
    ]
    very_flaky_success = spans[
        "test_spans_quarantine.py::test_my_very_flaky_success_test"
    ]
    # A quarantined test that failed still reports OK, so it does not break CI.
    assert very_flaky_failure["status"] == "ok"
    assert very_flaky_failure["attributes"]["cicd.test.quarantined"]
    assert very_flaky_success["status"] == "ok"
    assert very_flaky_success["attributes"]["cicd.test.quarantined"]

    assert """🛡️ Quarantine
- Repository: foo/bar
- Branch: main
- Quarantined tests fetched from API: 3

- 🔒 Quarantined:
    · test_spans_quarantine.py::test_my_very_flaky_failure_test
    · test_spans_quarantine.py::test_my_very_flaky_success_test

- Unused quarantined tests:
    · test_spans_quarantine.py::some_other_test
""" in result.stdout.str()
