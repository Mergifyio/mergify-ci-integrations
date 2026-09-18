"""Run one bench suite and check the job's own output.

The suite fails on purpose, so the exit code is compared against the expected
one instead of being ignored. The output has to show the client's report and
the framework's own summary line, and none of the client's known failure
messages.

The job name the client reports is set here, from the expectations, so the
name verify searches by cannot drift from the one the run used.
"""

import argparse
import os
import pathlib
import re
import subprocess
import sys

from mergify_bench_tools import expectations

ANSI_ESCAPE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def check_output(
    expected: expectations.ClientExpectations,
    exit_code: int,
    output: str,
) -> list[str]:
    """Return one problem per expectation the run did not meet."""
    plain = ANSI_ESCAPE.sub("", output)
    problems = []
    if exit_code != expected.exit_code:
        problems.append(f"exit code {exit_code}, expected {expected.exit_code}")
    for pattern in expected.required_output:
        if not re.search(pattern, plain, flags=re.MULTILINE):
            problems.append(f"no output line matches {pattern!r}")
    for text in expected.forbidden_output:
        if text in plain:
            problems.append(f"output contains {text!r}")
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--client", required=True)
    parser.add_argument(
        "--expectations", type=pathlib.Path, default=expectations.DEFAULT_PATH
    )
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("give the suite's command after --")

    expected = expectations.load(args.client, args.expectations)
    env = os.environ | {"MERGIFY_TEST_JOB_NAME": expected.job_name}

    # Streamed as well as captured, so the job log still reads like a normal run.
    process = subprocess.Popen(
        command,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    assert process.stdout is not None
    lines = []
    for line in process.stdout:
        sys.stdout.write(line)
        lines.append(line)
    exit_code = process.wait()

    problems = check_output(expected, exit_code, "".join(lines))
    print(f"\n--- bench: {args.client} run checks ---")
    if problems:
        for problem in problems:
            print(f"✗ {problem}")
        return 1
    print(f"✓ exit code {exit_code}, report and summary line present")
    return 0


if __name__ == "__main__":
    sys.exit(main())
