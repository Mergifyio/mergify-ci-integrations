"""Check what Mergify recorded for a bench run.

Test details are only published once ingestion catches up, so this polls. A
test counts as reported by this run once its last success or failure is later
than the run's start. Skipped tests have no timestamp of their own, so they
are only checked for presence and fields.

Mergify builds test details from runs on the default branch, which is why the
bench uploads from pushes to `main`.
"""

import argparse
import collections.abc
import dataclasses
import datetime
import json
import os
import pathlib
import sys
import time
import typing
import urllib.error
import urllib.parse
import urllib.request

from mergify_bench_tools import expectations

FRESHNESS_FIELD = {"passed": "last_success_at", "failed": "last_failure_at"}


class Api(typing.Protocol):
    def search_tests(self, job_name: str) -> dict[str, str]:
        """Map each test name reported under `job_name` to its test id."""

    def test_details(self, test_id: str) -> dict[str, typing.Any] | None:
        """The test's details, or None when Mergify has none yet."""


@dataclasses.dataclass(frozen=True)
class Mismatch:
    test: str
    field: str
    expected: str
    recorded: str


@dataclasses.dataclass
class Outcome:
    waiting: list[str] = dataclasses.field(default_factory=list)
    mismatches: list[Mismatch] = dataclasses.field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.waiting and not self.mismatches


def _parse_time(value: str | None) -> datetime.datetime | None:
    return datetime.datetime.fromisoformat(value) if value else None


def compare(
    expected: expectations.ClientExpectations,
    details: collections.abc.Mapping[
        str, collections.abc.Mapping[str, typing.Any] | None
    ],
    since: datetime.datetime,
    framework_version: str,
) -> Outcome:
    """Compare what Mergify returned with the expectations.

    `details` is keyed by test name. A test that is missing, or whose result
    predates `since`, is still waiting rather than wrong.
    """
    outcome = Outcome()
    for test in expected.tests:
        recorded = details.get(test.name)
        if recorded is None:
            outcome.waiting.append(f"{test.name}: not reported yet")
            continue
        # The timestamp of what Mergify recorded, not of what was expected: a
        # test expected to pass that failed has a fresh last failure, and its
        # conclusion mismatch should be reported rather than waited out.
        freshness = FRESHNESS_FIELD.get(
            str(recorded.get("last_conclusion"))
        ) or FRESHNESS_FIELD.get(test.last_conclusion)
        if freshness is not None:
            at = _parse_time(recorded.get(freshness))
            if at is None or at < since:
                outcome.waiting.append(f"{test.name}: no {freshness} since {since}")
                continue

        wanted = {
            **expected.recorded,
            "test_framework_version": framework_version,
            "test_filepath": test.test_filepath,
            "test_function_name": test.test_function_name,
            "last_conclusion": test.last_conclusion,
        }
        for field, value in wanted.items():
            got = recorded.get(field)
            if got != value:
                outcome.mismatches.append(
                    Mismatch(
                        test.name, field, value, json.dumps(got, ensure_ascii=False)
                    )
                )
    return outcome


def render(outcome: Outcome) -> str:
    lines = []
    if outcome.mismatches:
        lines += ["| Test | Field | Expected | Recorded |", "|---|---|---|---|"]
        lines += [
            f"| `{m.test}` | `{m.field}` | `{m.expected}` | `{m.recorded}` |"
            for m in outcome.mismatches
        ]
    if outcome.waiting:
        lines += ["", "Still missing when verify gave up:"]
        lines += [f"- {entry}" for entry in outcome.waiting]
    return "\n".join(lines)


class HttpApi:
    def __init__(self, api_url: str, token: str, repository: str) -> None:
        owner, repo = repository.split("/", 1)
        self.base = f"{api_url.rstrip('/')}/v1/ci/{owner}/repositories/{repo}"
        self.token = token

    def _get(self, path: str, query: dict[str, str] | None = None) -> typing.Any:
        url = self.base + path
        if query:
            url += "?" + urllib.parse.urlencode(query)
        request = urllib.request.Request(
            url, headers={"Authorization": f"Bearer {self.token}"}
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)

    def search_tests(self, job_name: str) -> dict[str, str]:
        body = self._get(
            "/search/tests",
            {"test_name": "*mergify_bench*", "job_name": job_name, "per_page": "100"},
        )
        return {test["test_name"]: test["test_id"] for test in body["tests"]}

    def test_details(self, test_id: str) -> dict[str, typing.Any] | None:
        try:
            details: dict[str, typing.Any] = self._get(f"/tests/{test_id}")
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            raise
        return details


def poll(
    api: Api,
    expected: expectations.ClientExpectations,
    since: datetime.datetime,
    framework_version: str,
    timeout: float,
    interval: float,
    sleep: typing.Callable[[float], None] = time.sleep,
    clock: typing.Callable[[], float] = time.monotonic,
) -> Outcome:
    deadline = clock() + timeout
    while True:
        search = api.search_tests(expected.job_name)
        details = {
            test.name: api.test_details(search[test.name])
            for test in expected.tests
            if test.name in search
        }
        outcome = compare(expected, details, since, framework_version)
        # A mismatch on a fresh result is final; only missing results are
        # worth waiting for.
        if outcome.ok or outcome.mismatches or clock() >= deadline:
            return outcome
        print(f"waiting for {len(outcome.waiting)} test(s)…", flush=True)
        sleep(interval)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--client", required=True)
    parser.add_argument(
        "--expectations", type=pathlib.Path, default=expectations.DEFAULT_PATH
    )
    parser.add_argument(
        "--repository", default=os.environ.get("GITHUB_REPOSITORY"), required=False
    )
    parser.add_argument(
        "--since",
        required=True,
        type=datetime.datetime.fromisoformat,
        help="when the run started, as ISO 8601 with a timezone",
    )
    parser.add_argument("--framework-version", required=True)
    parser.add_argument("--timeout", type=float, default=900)
    parser.add_argument("--interval", type=float, default=30)
    args = parser.parse_args(argv)
    if not args.repository:
        parser.error("--repository is required outside GitHub Actions")

    token = os.environ.get("MERGIFY_BENCH_ADMIN_TOKEN")
    if not token:
        parser.error("MERGIFY_BENCH_ADMIN_TOKEN is not set")
    api_url = os.environ.get("MERGIFY_API_URL", "https://api.mergify.com")

    expected = expectations.load(args.client, args.expectations)
    outcome = poll(
        HttpApi(api_url, token, args.repository),
        expected,
        args.since,
        args.framework_version,
        args.timeout,
        args.interval,
    )

    report = render(outcome)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as file:
            status = (
                "recorded as expected" if outcome.ok else "not recorded as expected"
            )
            file.write(f"### bench {args.client}: {status}\n\n{report}\n")
    if outcome.ok:
        count = len(expected.tests)
        print(f"✓ Mergify recorded all {count} {args.client} tests as expected")
        return 0
    print(f"✗ Mergify did not record the {args.client} run as expected\n\n{report}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
