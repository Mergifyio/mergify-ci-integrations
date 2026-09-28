import json
import typing

import _pytest.pytester
import pytest

import pytest_mergify
from tests import conftest

# Long enough to dwarf pytest's own per-phase overhead, short enough that the
# reruns below stay a few seconds.
_EXECUTION_SECONDS = 0.1

_SOURCE = f"""
import time

import pytest

executions = 0

@pytest.fixture
def slow():
    time.sleep({_EXECUTION_SECONDS})
    yield

def test_existing():
    pass

def test_rerun(slow):
    global executions
    executions += 1
    if executions in FAILING_EXECUTIONS:
        pytest.fail("I'm flaky!")
"""


@pytest.fixture(
    params=[
        pytest.param([], id="serial"),
        # A worker's reports reach pytest-split on the controller, serialized
        # at the moment they are logged.
        pytest.param(["-n", "2"], id="xdist"),
    ]
)
def xdist_args(request: pytest.FixtureRequest) -> typing.List[str]:
    args: typing.List[str] = request.param
    return args


def _stored_durations(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    xdist_args: typing.List[str],
    mode: typing.Literal["new", "unhealthy"],
    flaky_context: typing.Dict[str, typing.Any],
    failing_executions: typing.Set[int],
) -> typing.Tuple[_pytest.pytester.RunResult, typing.Dict[str, float]]:
    pytest.importorskip("pytest_split")
    conftest.set_test_environment(monkeypatch, mode=mode)
    conftest.install_fake_api_client(monkeypatch, flaky_context=flaky_context)
    pytester.makepyfile(
        test_rerun=f"FAILING_EXECUTIONS = {failing_executions!r}\n{_SOURCE}"
    )
    durations_path = pytester.path / ".test_durations"

    result = pytester.runpytest_inprocess(
        "--store-durations",
        f"--durations-path={durations_path}",
        *xdist_args,
        plugins=[pytest_mergify.PytestMergify()],
    )

    with durations_path.open() as f:
        durations: typing.Dict[str, float] = json.load(f)
    return result, durations


def _assert_one_execution(duration: float) -> None:
    # Every execution sleeps once, so a duration summed over the reruns is a
    # multiple of the sleep; one execution is the sleep plus pytest's overhead.
    assert _EXECUTION_SECONDS <= duration < 3 * _EXECUTION_SECONDS


@pytest.mark.parametrize(
    ("mode", "expected_ret"),
    [
        # A rerun that fails is what keeps a new flaky test out, so the session
        # still goes red on it.
        pytest.param("new", 1, id="new"),
        # There the failure is a finding about a known test, not a verdict.
        pytest.param("unhealthy", 0, id="unhealthy"),
    ],
)
def test_pytest_split_stores_one_execution_of_a_test_flaky_detection_reran(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    xdist_args: typing.List[str],
    mode: typing.Literal["new", "unhealthy"],
    expected_ret: int,
) -> None:
    """MRGFY-9701: pytest-split sums every report logged under a test's id, so
    reruns reported with their real duration are stored as that many times the
    test, and the shards are balanced on it."""
    result, durations = _stored_durations(
        pytester,
        monkeypatch,
        xdist_args,
        mode,
        conftest.make_flaky_context(
            # `test_rerun` is new next to it in `new` mode, and known unhealthy
            # in `unhealthy` mode.
            existing_test_names=["test_rerun.py::test_existing"],
            unhealthy_test_names=["test_rerun.py::test_rerun"],
            max_test_execution_count=10,
        ),
        failing_executions={3},
    )

    assert result.ret == expected_ret
    assert "'test_rerun.py::test_rerun' has been tested 10 times" in (
        result.stdout.str()
    )
    _assert_one_execution(durations["test_rerun.py::test_rerun"])


def test_pytest_split_stores_one_execution_of_a_test_retry_reran(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
    xdist_args: typing.List[str],
) -> None:
    """Retry logs its attempts' setup and teardown, which pytest-split would
    otherwise add to the attempt the session reports."""
    result, durations = _stored_durations(
        pytester,
        monkeypatch,
        xdist_args,
        "new",
        conftest.make_flaky_context(
            flaky_test_names=["test_rerun.py::test_rerun"],
            max_test_execution_count=5,
            min_test_execution_count=1,
        ),
        failing_executions={1, 2, 3, 4},
    )

    assert result.ret == 0
    assert result.parseoutcomes()["rescued"] == 1
    _assert_one_execution(durations["test_rerun.py::test_rerun"])
