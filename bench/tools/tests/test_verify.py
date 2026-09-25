import datetime
import typing

from mergify_bench_tools import expectations, verify

SINCE = datetime.datetime(2026, 9, 17, 12, 0, tzinfo=datetime.UTC)
AFTER = "2026-09-17T12:05:00Z"
BEFORE = "2026-09-17T11:00:00Z"

EXPECTED = expectations.ClientExpectations(
    client="pytest",
    job_name="bench-pytest",
    exit_code=1,
    required_output=(),
    forbidden_output=(),
    recorded={"test_framework": "pytest", "test_programming_language": "python"},
    tests=(
        expectations.ExpectedTest(
            name="test_mergify_bench.py::test_passes",
            test_filepath="test_mergify_bench.py",
            test_function_name="test_passes",
            last_conclusion="passed",
        ),
        expectations.ExpectedTest(
            name="test_mergify_bench.py::test_skipped",
            test_filepath="test_mergify_bench.py",
            test_function_name="test_skipped",
            last_conclusion="skipped",
        ),
    ),
)


def recorded(**overrides: typing.Any) -> dict[str, typing.Any]:
    return {
        "test_framework": "pytest",
        "test_framework_version": "9.1.1",
        "test_programming_language": "python",
        "test_filepath": "test_mergify_bench.py",
        "test_function_name": "test_passes",
        "last_conclusion": "passed",
        "last_success_at": AFTER,
        "last_failure_at": None,
    } | overrides


SKIPPED = recorded(
    test_function_name="test_skipped", last_conclusion="skipped", last_success_at=None
)


def test_everything_recorded_as_expected_is_ok() -> None:
    details = {
        "test_mergify_bench.py::test_passes": recorded(),
        "test_mergify_bench.py::test_skipped": SKIPPED,
    }
    assert verify.compare(EXPECTED, details, SINCE, "9.1.1").ok


def test_a_missing_language_is_a_mismatch() -> None:
    details = {
        "test_mergify_bench.py::test_passes": recorded(test_programming_language=None),
        "test_mergify_bench.py::test_skipped": SKIPPED,
    }
    outcome = verify.compare(EXPECTED, details, SINCE, "9.1.1")
    assert outcome.mismatches == [
        verify.Mismatch(
            "test_mergify_bench.py::test_passes",
            "test_programming_language",
            "python",
            "null",
        )
    ]
    row = "| `test_mergify_bench.py::test_passes` | `test_programming_language` |"
    assert f"{row} `python` | `null` |" in verify.render(outcome)


def test_a_result_from_before_the_run_is_waited_for_not_compared() -> None:
    details = {
        "test_mergify_bench.py::test_passes": recorded(
            last_success_at=BEFORE, test_programming_language=None
        ),
        "test_mergify_bench.py::test_skipped": SKIPPED,
    }
    outcome = verify.compare(EXPECTED, details, SINCE, "9.1.1")
    assert outcome.mismatches == []
    assert outcome.waiting == [
        f"test_mergify_bench.py::test_passes: no last_success_at since {SINCE}"
    ]


def test_an_unexpected_fresh_failure_is_a_mismatch_not_a_wait() -> None:
    details = {
        "test_mergify_bench.py::test_passes": recorded(
            last_conclusion="failed", last_success_at=BEFORE, last_failure_at=AFTER
        ),
        "test_mergify_bench.py::test_skipped": SKIPPED,
    }
    outcome = verify.compare(EXPECTED, details, SINCE, "9.1.1")
    assert outcome.waiting == []
    assert [(m.field, m.expected, m.recorded) for m in outcome.mismatches] == [
        ("last_conclusion", "passed", '"failed"')
    ]


def test_a_test_mergify_has_not_reported_is_waited_for() -> None:
    details = {"test_mergify_bench.py::test_passes": recorded()}
    outcome = verify.compare(EXPECTED, details, SINCE, "9.1.1")
    assert outcome.waiting == ["test_mergify_bench.py::test_skipped: not reported yet"]


class FakeApi:
    def __init__(self, rounds: list[dict[str, dict[str, typing.Any]]]) -> None:
        self.rounds = rounds
        self.calls = 0

    def search_tests(self, job_name: str) -> dict[str, str]:
        assert job_name == "bench-pytest"
        current = self.rounds[min(self.calls, len(self.rounds) - 1)]
        self.calls += 1
        self.current = current
        return {name: name for name in current}

    def test_details(self, test_id: str) -> dict[str, typing.Any] | None:
        return self.current.get(test_id)


def test_poll_waits_for_ingestion_then_succeeds() -> None:
    api = FakeApi(
        [
            {},
            {
                "test_mergify_bench.py::test_passes": recorded(),
                "test_mergify_bench.py::test_skipped": SKIPPED,
            },
        ]
    )
    sleeps: list[float] = []
    outcome = verify.poll(
        api,
        EXPECTED,
        SINCE,
        "9.1.1",
        timeout=60,
        interval=5,
        sleep=sleeps.append,
        clock=lambda: 0,
    )
    assert outcome.ok
    assert sleeps == [5]


def test_poll_stops_at_the_first_mismatch() -> None:
    api = FakeApi(
        [
            {
                "test_mergify_bench.py::test_passes": recorded(test_framework="true"),
                "test_mergify_bench.py::test_skipped": SKIPPED,
            }
        ]
    )
    outcome = verify.poll(
        api,
        EXPECTED,
        SINCE,
        "9.1.1",
        timeout=60,
        interval=5,
        sleep=lambda _: None,
        clock=lambda: 0,
    )
    assert [m.field for m in outcome.mismatches] == ["test_framework"]
    assert api.calls == 1


def test_poll_gives_up_at_the_deadline() -> None:
    ticks = iter([0.0, 10.0, 70.0])
    outcome = verify.poll(
        FakeApi([{}]),
        EXPECTED,
        SINCE,
        "9.1.1",
        timeout=60,
        interval=5,
        sleep=lambda _: None,
        clock=lambda: next(ticks),
    )
    assert not outcome.ok
    assert len(outcome.waiting) == 2
