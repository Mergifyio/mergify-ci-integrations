import atexit
import datetime
import os
import time
import typing

import _pytest.config
import _pytest.config.argparsing
import _pytest.main
import _pytest.nodes
import _pytest.outcomes
import _pytest.pathlib
import _pytest.reports
import _pytest.runner
import _pytest.skipping
import _pytest.terminal
import pytest
import pytest_timeout

from pytest_mergify import flaky_detection as _flaky_detection
from pytest_mergify import tracing, utils
from pytest_mergify.ci_insights import MergifyCIInsights

# OpenTelemetry semantic-convention attribute keys, inlined now that the
# semconv package is gone with the SDK.
_CODE_FILEPATH = "code.filepath"
_CODE_FUNCTION = "code.function"
_CODE_LINENO = "code.lineno"
_CODE_NAMESPACE = "code.namespace"
_EXCEPTION_TYPE = "exception.type"
_EXCEPTION_MESSAGE = "exception.message"
_EXCEPTION_STACKTRACE = "exception.stacktrace"


class PytestMergify:
    mergify_ci: MergifyCIInsights
    # Defaulted at class level so a report hook firing before `pytest_configure`
    # (e.g. a unit test that wires the plugin by hand) still finds them set.
    _session_span: typing.Optional[tracing.Span] = None
    _current_test_span: typing.Optional[tracing.Span] = None
    _export_result: typing.Tuple[bool, typing.Optional[str]] = (False, None)
    # Guards the one-shot export so session-finish and the atexit backstop
    # can't upload the spans twice.
    _exported: bool = False

    def pytest_configure(self, config: _pytest.config.Config) -> None:
        config.addinivalue_line(
            "markers",
            "mergify(flaky_detection=bool): Mergify per-test options. "
            "Set flaky_detection=False to disable flaky detection for the test.",
        )
        kwargs = {}
        api_url = config.getoption("--mergify-api-url")
        if api_url is not None:
            kwargs["api_url"] = api_url
        self.mergify_ci = MergifyCIInsights(**kwargs)

        # Spans are built by hand (no OpenTelemetry SDK) and handed to the
        # binding at the end of the session; these hold the run's spans until
        # then.
        self._finished_spans: typing.List[tracing.Span] = []
        self._session_span = None
        self._current_test_span = None
        self.has_error = False
        # Set once the spans are exported at session finish; read by the summary.
        self._export_result = (False, None)
        self._exported = False
        # Backstop, restoring the OTel SDK's atexit flush: if the session ends
        # without pytest_sessionfinish completing (e.g. another plugin's
        # sessionfinish raises) but the interpreter still exits cleanly, the
        # collected spans are flushed here. `_finalize_and_export` is idempotent,
        # so on a normal run this is a no-op. (No help on a hard kill / OOM,
        # where atexit never runs.)
        if self._traces_enabled:
            atexit.register(self._finalize_and_export)

        self._xdist_controller = _flaky_detection.XdistFlakyDetectionController()

        if _is_xdist_worker(config):
            self._load_flaky_detector_from_xdist_worker(config)

    def _load_flaky_detector_from_xdist_worker(
        self, config: _pytest.config.Config
    ) -> None:
        """Load flaky detector from controller-provided context on xdist workers."""
        workerinput = getattr(config, "workerinput", {})
        context = workerinput.get("flaky_detection_context")
        mode = workerinput.get("flaky_detection_mode")
        if context is not None and mode is not None:
            self.mergify_ci.load_flaky_detector_from_context(context, mode)

    @pytest.hookimpl(optionalhook=True)
    def pytest_configure_node(self, node: typing.Any) -> None:
        """xdist hook: distribute flaky detection context to workers."""
        # Disable under 'each' mode to avoid duplicated budgets.
        if getattr(node.config.option, "dist", None) == "each":
            return

        # Lazily extract context on first node setup to avoid timing issues
        # with xdist's dsession registration.
        if not self._xdist_controller.has_context and self.mergify_ci.flaky_detector:
            self._xdist_controller.extract_context_from_detector(
                self.mergify_ci.flaky_detector
            )

        self._xdist_controller.populate_workerinput(node.workerinput)

    @pytest.hookimpl(optionalhook=True)
    def pytest_testnodedown(self, node: typing.Any, error: typing.Any) -> None:
        """xdist hook: collect metrics from completed workers."""
        workeroutput = getattr(node, "workeroutput", None)
        if workeroutput is None:
            return

        worker_metrics = workeroutput.get("flaky_detection_metrics")
        if worker_metrics is None:
            return

        self._xdist_controller.collect_worker_metrics(worker_metrics)

    def pytest_terminal_summary(
        self, terminalreporter: _pytest.terminal.TerminalReporter
    ) -> None:
        # No CI, nothing to do
        if not utils.is_in_ci():
            return

        terminalreporter.section("Mergify CI")

        if not self.mergify_ci.token:
            terminalreporter.write_line(
                "No token configured for Mergify; test results will not be uploaded",
                yellow=True,
            )
            return

        if not self.mergify_ci.repo_name:
            terminalreporter.write_line(
                "Unable to determine repository name; test results will not be uploaded",
                red=True,
            )
            return

        if _is_xdist_controller(terminalreporter.config):
            if self._xdist_controller.has_context:
                terminalreporter.write_line(self._xdist_controller.make_report())
            elif self.mergify_ci.flaky_detector_error_message:
                _write_flaky_detector_error(
                    terminalreporter, self.mergify_ci.flaky_detector_error_message
                )
        elif self.mergify_ci.flaky_detector:
            terminalreporter.write_line(self.mergify_ci.flaky_detector.make_report())
        elif self.mergify_ci.flaky_detector_error_message:
            _write_flaky_detector_error(
                terminalreporter, self.mergify_ci.flaky_detector_error_message
            )

        # Mergify Test Insights Quarantine warning logs
        if not self.mergify_ci.branch_name:
            terminalreporter.write_line(
                "No valid branch name found, unable to set up Mergify Test Insights Quarantine",
                yellow=True,
            )

        if self.mergify_ci.quarantined_tests is None:
            terminalreporter.write_line(
                "Mergify Test Insights Quarantine could not be set up"
            )
        elif self.mergify_ci.quarantined_tests is not None:
            if self.mergify_ci.quarantined_tests.init_error_msg:
                terminalreporter.write_line(
                    self.mergify_ci.quarantined_tests.init_error_msg, yellow=True
                )
            else:
                terminalreporter.write_line(
                    self.mergify_ci.quarantined_tests.quarantined_tests_report()
                )

        # Mergify test selection (reduced merge-queue reruns) logs
        if self.mergify_ci.test_selection is not None:
            if self.mergify_ci.test_selection.init_error_msg:
                terminalreporter.write_line(
                    self.mergify_ci.test_selection.init_error_msg, yellow=True
                )
            else:
                terminalreporter.write_line(self.mergify_ci.test_selection.report())

        # Mergify Test Insights Traces upload logs
        if self.mergify_ci.trace_mode is None:
            terminalreporter.write_line(
                "Mergify Tracer didn't start for unexpected reason (please contact Mergify support); test results will not be uploaded",
                red=True,
            )
        else:
            uploaded, error = self._export_result
            if uploaded:
                terminalreporter.write_line(
                    f"MERGIFY_TEST_RUN_ID={self.mergify_ci.test_run_id}",
                )
            elif error is not None:
                terminalreporter.write_line(
                    f"Error while exporting traces: {error}",
                    red=True,
                )
            else:
                terminalreporter.write_line(
                    "Mergify's API did not accept the test results; they were not uploaded",
                    red=True,
                )

    @property
    def _traces_enabled(self) -> bool:
        return self.mergify_ci.trace_mode is not None

    def pytest_sessionstart(self, session: _pytest.main.Session) -> None:
        if self._traces_enabled:
            trace_id = tracing.new_trace_id()
            parent_span_id: typing.Optional[bytes] = None

            # A propagated `traceparent` sets the trace this session belongs to
            # and its parent span; a missing or malformed one starts a fresh,
            # unparented trace.
            traceparent = os.environ.get("MERGIFY_TRACEPARENT")
            if traceparent and (parsed := tracing.parse_traceparent(traceparent)):
                trace_id, parent_span_id = parsed

            self._session_span = {
                "name": "pytest session start",
                "trace_id": trace_id,
                "span_id": tracing.new_span_id(),
                "parent_span_id": parent_span_id,
                "start_unix_nano": time.time_ns(),
                "end_unix_nano": 0,
                "attributes": {"test.scope": "session"},
                "status": "unset",
                "status_message": None,
            }
        self.has_error = False

    @pytest.hookimpl(trylast=True)
    def pytest_collection_modifyitems(
        self,
        config: _pytest.config.Config,
        items: typing.List[_pytest.nodes.Item],
    ) -> None:
        # trylast so user filters (-k, -m, --deselect) apply first; the
        # reduced-rerun subset then only ever narrows what remains.
        if self.mergify_ci.test_selection:
            self.mergify_ci.test_selection.filter_items(config, items)

    def pytest_collection_finish(self, session: _pytest.main.Session) -> None:
        if self.mergify_ci.flaky_detector:
            self.mergify_ci.flaky_detector.prepare_for_session(session)

    @pytest.hookimpl(hookwrapper=True)
    def pytest_sessionfinish(
        self,
        session: _pytest.main.Session,
    ) -> typing.Generator[None, None, None]:
        # xdist worker: export metrics via workeroutput (independent of tracer).
        if _is_xdist_worker(session.config) and self.mergify_ci.flaky_detector:
            workeroutput = getattr(session.config, "workeroutput", None)
            if workeroutput is not None:
                workeroutput["flaky_detection_metrics"] = (
                    self.mergify_ci.flaky_detector.to_serializable_metrics()
                )

        if not self._traces_enabled or self._session_span is None:
            yield
            return

        yield

        # Export here rather than in the terminal summary: the summary's token
        # checks return early on a run with nothing to upload, but the capture
        # path (tests) and the debug path have spans to hand off regardless.
        self._finalize_and_export()

    def _finalize_and_export(self) -> None:
        """Close the session span and export every collected span, exactly once.

        Called from `pytest_sessionfinish` on a normal run, and from the atexit
        backstop if that never ran; the `_exported` guard makes the second call
        a no-op.
        """
        if self._exported or not self._traces_enabled or self._session_span is None:
            return
        self._exported = True
        # Whichever path runs first, drop the atexit backstop so nothing is left
        # registered at interpreter exit.
        atexit.unregister(self._finalize_and_export)
        # The session span is still open when the atexit backstop runs (session
        # finish never closed it); close it before exporting.
        if self._session_span["end_unix_nano"] == 0:
            self._session_span["status"] = "error" if self.has_error else "ok"
            self._session_span["end_unix_nano"] = time.time_ns()
            self._finished_spans.append(self._session_span)

        self._export_result = self.mergify_ci.export_spans(self._finished_spans)

    def _get_item_attributes(
        self, item: _pytest.nodes.Item
    ) -> typing.Dict[str, tracing.AttrValue]:
        filepath, line_number, testname = item.location
        namespace = testname.replace(item.name, "")
        if namespace.endswith("."):
            namespace = namespace[:-1]

        result: typing.Dict[str, tracing.AttrValue] = {
            _CODE_FILEPATH: filepath,
            _CODE_FUNCTION: item.name,
            _CODE_LINENO: line_number or 0,
            _CODE_NAMESPACE: namespace,
            "code.file.path": str(_pytest.pathlib.absolutepath(item.reportinfo()[0])),
            "code.line.number": line_number or 0,
            "test.scope": "case",
        }

        if _should_skip_item(item):
            result["cicd.test.quarantined"] = False
            result["test.case.result.status"] = "skipped"
        else:
            result["cicd.test.quarantined"] = (
                self.mergify_ci.mark_test_as_quarantined_if_needed(item)
            )

        return result

    @pytest.hookimpl(tryfirst=True)
    def pytest_runtest_protocol(
        self,
        item: _pytest.nodes.Item,
        nextitem: typing.Optional[_pytest.nodes.Item],
    ) -> typing.Optional[bool]:
        # Returning `None` lets pytest continue with its normal test execution
        # flow. Returning `True` means we took care of running the protocol.
        # See:
        # https://docs.pytest.org/en/7.1.x/how-to/writing_hook_functions.html#firstresult
        if not self._traces_enabled and not self.mergify_ci.flaky_detector:
            return None

        if self._traces_enabled:
            return self._run_test_protocol_with_tracing(item, nextitem)

        return self._run_test_protocol(item, nextitem)

    def _run_test_protocol_with_tracing(
        self,
        item: _pytest.nodes.Item,
        nextitem: typing.Optional[_pytest.nodes.Item],
    ) -> bool:
        """Run test protocol with tracing and optional flaky detection."""
        assert self._session_span is not None

        # The test span is a child of the session span, in the same trace. It is
        # held as the "current" span so the report hooks can annotate it while
        # the test runs.
        span: tracing.Span = {
            "name": item.nodeid,
            "trace_id": self._session_span["trace_id"],
            "span_id": tracing.new_span_id(),
            "parent_span_id": self._session_span["span_id"],
            "start_unix_nano": time.time_ns(),
            "end_unix_nano": 0,
            "attributes": self._get_item_attributes(item),
            "status": "unset",
            "status_message": None,
        }
        self._current_test_span = span

        try:
            distinct_outcomes, rerun_count = self._execute_test_with_reruns(
                item, nextitem
            )

            if rerun_count > 0:
                if "failed" in distinct_outcomes and "passed" in distinct_outcomes:
                    span["attributes"]["cicd.test.flaky"] = True
                span["attributes"]["cicd.test.rerun_count"] = rerun_count
        finally:
            span["end_unix_nano"] = time.time_ns()
            self._finished_spans.append(span)
            self._current_test_span = None

        return True

    def _run_test_protocol(
        self,
        item: _pytest.nodes.Item,
        nextitem: typing.Optional[_pytest.nodes.Item],
    ) -> bool:
        """Run test protocol without tracing (e.g. xdist workers without tracer)."""
        self._execute_test_with_reruns(item, nextitem)
        return True

    def _execute_test_with_reruns(
        self,
        item: _pytest.nodes.Item,
        nextitem: typing.Optional[_pytest.nodes.Item],
    ) -> typing.Tuple[typing.Set[str], int]:
        """Run initial test and flaky detection reruns. Returns (outcomes, rerun_count)."""
        distinct_outcomes: typing.Set[str] = set()

        distinct_outcomes |= _call_outcomes(
            _pytest.runner.runtestprotocol(item=item, nextitem=nextitem, log=True)
        )

        if (
            not self.mergify_ci.flaky_detector
            or not self.mergify_ci.flaky_detector.has_test_executed(item.nodeid)
        ):
            return distinct_outcomes, 0

        # Decided at the first teardown, before any finalizer was suspended.
        if self.mergify_ci.flaky_detector.is_test_too_slow(item.nodeid):
            return distinct_outcomes, 0

        rerun_count = 0
        while not self.mergify_ci.flaky_detector.is_on_last_rerun(item.nodeid):
            self.mergify_ci.flaky_detector.flag_last_rerun(item.nodeid)

            # Always execute a last rerun before stopping to properly
            # restore finalizers. Otherwise, it can lead to resource leaks.
            distinct_outcomes |= _call_outcomes(self._reruntestprotocol(item, nextitem))

            rerun_count += 1

        return distinct_outcomes, rerun_count

    def _reruntestprotocol(
        self, item: _pytest.nodes.Item, nextitem: typing.Optional[_pytest.nodes.Item]
    ) -> typing.List[_pytest.reports.TestReport]:
        """
        Run the protocol for a rerun of a given test.

        In `new` mode, we log rerun failures to pytest's report to enforce a
        quality gate and prevent merging PRs with new flaky tests. In other
        modes (`unhealthy`), we skip logging to avoid blocking CI, but still
        capture reruns in metrics.
        """

        if not self.mergify_ci.flaky_detector:
            return []

        if self.mergify_ci.flaky_detector.mode == "new":
            return _pytest.runner.runtestprotocol(
                item=item, nextitem=nextitem, log=True
            )

        reports = _pytest.runner.runtestprotocol(
            item=item, nextitem=nextitem, log=False
        )
        for report in reports:
            if report.when != "call":
                item.ihook.pytest_runtest_logreport(report=report)  # Log as usual.
            else:
                # Make rerun visible in the logs by temporarily changing
                # outcome. The goal is to count a potential failure as a rerun
                # instead of a regular failure.
                original_outcome = report.outcome
                report.outcome = "rerun"  # type: ignore[assignment]
                item.ihook.pytest_runtest_logreport(report=report)
                report.outcome = original_outcome

        return reports

    @pytest.hookimpl
    def pytest_report_teststatus(
        self,
        report: _pytest.reports.TestReport,
    ) -> typing.Optional[
        typing.Tuple[
            str, str, typing.Union[str, typing.Tuple[str, typing.Mapping[str, bool]]]
        ]
    ]:
        # https://github.com/pytest-dev/pytest-rerunfailures/blob/master/src/pytest_rerunfailures.py#L622-L625
        if report.outcome == "rerun":  # type: ignore[comparison-overlap]
            return "rerun", "R", ("RERUN", {"yellow": True})  # type: ignore[unreachable]

        return None

    @pytest.hookimpl(tryfirst=True)
    def pytest_runtest_teardown(
        self,
        item: _pytest.nodes.Item,
    ) -> None:
        detector = self.mergify_ci.flaky_detector
        if detector is None or not detector.has_test_executed(item.nodeid):
            return

        if not detector.has_test_deadline(item.nodeid):
            # First teardown for this test. Whether it gets rerun is decided
            # here, before any finalizer moves: suspending for a test that is
            # then skipped leaves higher-scoped finalizers outside pytest's
            # stack with nothing left to restore them.
            detector.set_test_deadline(
                test=item.nodeid,
                timeout=datetime.timedelta(seconds=timeout_seconds)
                if (timeout_seconds := pytest_timeout._get_item_settings(item).timeout)
                else None,
            )

            if detector.decide_test_is_too_slow(item.nodeid):
                return

        # The goal here is to keep only function-scoped finalizers during
        # reruns and restore higher-scoped finalizers only on the last one.
        if detector.is_on_last_rerun(item.nodeid):
            detector.restore_item_finalizers(item)
        else:
            detector.suspend_item_finalizers(item)

    def pytest_exception_interact(
        self,
        node: _pytest.nodes.Node,
        call: _pytest.runner.CallInfo[typing.Any],
        report: _pytest.reports.TestReport,
    ) -> None:
        if self._current_test_span is None:
            return

        excinfo = call.excinfo

        if excinfo is not None:
            self._current_test_span["attributes"].update(
                {
                    _EXCEPTION_TYPE: str(excinfo.type.__name__),
                    _EXCEPTION_MESSAGE: str(excinfo.value),
                    _EXCEPTION_STACKTRACE: str(report.longrepr),
                }
            )
            self._current_test_span["status"] = "error"
            self._current_test_span["status_message"] = (
                f"{excinfo.type}: {excinfo.value}"
            )

    def pytest_runtest_logreport(self, report: _pytest.reports.TestReport) -> None:
        if self.mergify_ci.flaky_detector:
            self.mergify_ci.flaky_detector.try_fill_metrics_from_report(report)

        if self._current_test_span is None:
            return

        if report.when != "call":
            return

        if report.outcome is None:
            return  # type: ignore[unreachable]

        if (
            self.mergify_ci.flaky_detector
            and self.mergify_ci.flaky_detector.has_test_been_rerun(report.nodeid)
        ):
            return

        self._update_current_span_from_report(report)

    def _update_current_span_from_report(
        self, report: _pytest.reports.TestReport
    ) -> None:
        span = self._current_test_span
        if span is None:
            return

        has_error = report.outcome == "failed"
        self.has_error |= has_error

        # A status set to "error" by `pytest_exception_interact` already carries
        # its description; leave that in place while marking the outcome here.
        span["status"] = "error" if has_error else "ok"
        span["attributes"]["test.case.result.status"] = report.outcome

        if (
            self.mergify_ci.flaky_detector
            and self.mergify_ci.flaky_detector.has_test_executed(report.nodeid)
        ):
            span["attributes"]["cicd.test.flaky_detection"] = True
            if self.mergify_ci.flaky_detector.mode == "new":
                span["attributes"]["cicd.test.new"] = True


def pytest_addoption(parser: _pytest.config.argparsing.Parser) -> None:
    group = parser.getgroup("pytest-mergify", "Mergify support for pytest")
    group.addoption(
        "--mergify-api-url",
        help=(
            "URL of the Mergify API (or set via MERGIFY_API_URL environment variable)"
        ),
    )


def pytest_configure(config: _pytest.config.Config) -> None:
    # NOTE(remyduthu):
    # We are using `isinstance` instead of `get_plugin` because the plugin can
    # be registered with a different name (e.g. `pytester`). It feels safer to
    # check the class name directly.
    for plugin in config.pluginmanager.get_plugins():
        if isinstance(plugin, PytestMergify):
            return

    config.pluginmanager.register(PytestMergify(), name="PytestMergify")


def _call_outcomes(
    reports: typing.List[_pytest.reports.TestReport],
) -> typing.Set[str]:
    """
    Outcomes of the call phase only.

    Setup and teardown report "passed" for every test that runs, so counting
    them would make a test that never once passed look like it both passed and
    failed.
    """
    return {report.outcome for report in reports if report.when == "call"}


def _should_skip_item(item: _pytest.nodes.Item) -> bool:
    """
    Whether pytest will skip this item before it gets to run.

    Asked of pytest rather than worked out here, so that the answer cannot
    drift from the rules pytest actually applies.
    """
    try:
        return _pytest.skipping.evaluate_skip_marks(item) is not None
    except (Exception, _pytest.outcomes.OutcomeException):
        # Setup meets the same mark again and turns it into one clean error on
        # the test, rather than the end of everyone's session. Outcomes descend
        # from BaseException, so `Exception` alone would swallow one raised
        # here -- outside the phase entitled to act on it.
        return False


def _write_flaky_detector_error(
    terminalreporter: _pytest.terminal.TerminalReporter,
    error_message: str,
) -> None:
    terminalreporter.write_line(
        f"""⚠️ Flaky detection couldn't be enabled because of an error.

Common issues:
  • Your 'MERGIFY_TOKEN' might not be set or could be invalid
  • There might be a network connectivity issue with the Mergify API

📚 Documentation: https://docs.mergify.com/ci-insights/test-frameworks/pytest/
🔍 Details: {error_message}""",
        yellow=True,
    )


def _is_xdist_controller(config: _pytest.config.Config) -> bool:
    """Check if running as xdist controller (not a worker)."""
    return config.pluginmanager.has_plugin("dsession") and not hasattr(
        config, "workerinput"
    )


def _is_xdist_worker(config: _pytest.config.Config) -> bool:
    """Check if running as xdist worker."""
    return hasattr(config, "workerinput")
