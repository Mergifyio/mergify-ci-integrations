import pathlib
import sys

import pytest

from mergify_bench_tools import expectations, run_suite

EXPECTED = expectations.ClientExpectations(
    client="rspec",
    job_name="bench-rspec",
    exit_code=1,
    required_output=(r"^--- Mergify CI ---$", r"^4 examples, 1 failure, 1 pending$"),
    forbidden_output=("native extension could not be loaded",),
    recorded={},
    tests=(),
)

GOOD_OUTPUT = (
    "\x1b[31mF\x1b[0m..*\n--- Mergify CI ---\n\n4 examples, 1 failure, 1 pending\n"
)


def test_a_run_that_meets_every_expectation_has_no_problem() -> None:
    assert run_suite.check_output(EXPECTED, 1, GOOD_OUTPUT) == []


def test_a_passing_exit_code_is_a_problem_when_the_suite_fails_on_purpose() -> None:
    assert run_suite.check_output(EXPECTED, 0, GOOD_OUTPUT) == [
        "exit code 0, expected 1"
    ]


def test_a_missing_summary_line_is_a_problem() -> None:
    output = GOOD_OUTPUT.replace("4 examples, 1 failure, 1 pending\n", "")
    assert run_suite.check_output(EXPECTED, 1, output) == [
        "no output line matches '^4 examples, 1 failure, 1 pending$'"
    ]


def test_a_known_failure_message_is_a_problem() -> None:
    output = GOOD_OUTPUT + "WARNING: the Mergify native extension could not be loaded\n"
    assert run_suite.check_output(EXPECTED, 1, output) == [
        "output contains 'native extension could not be loaded'"
    ]


def test_main_sets_the_job_name_and_checks_the_real_output(
    tmp_path: pathlib.Path, capsys: pytest.CaptureFixture[str]
) -> None:
    expectations_file = tmp_path / "expectations.yaml"
    expectations_file.write_text(
        """
clients:
  rspec:
    job_name: bench-rspec
    exit_code: 1
    output:
      required: ['^--- Mergify CI ---$', '^4 examples, 1 failure, 1 pending$']
      forbidden: []
    recorded: {}
    tests: []
""",
        encoding="utf-8",
    )
    script = (
        "import os, sys;"
        "print('job', os.environ['MERGIFY_TEST_JOB_NAME']);"
        "print('--- Mergify CI ---');"
        "print('4 examples, 1 failure, 1 pending');"
        "sys.exit(1)"
    )
    argv = ["--client", "rspec", "--expectations", str(expectations_file)]
    assert run_suite.main([*argv, "--", sys.executable, "-c", script]) == 0
    assert "job bench-rspec" in capsys.readouterr().out
