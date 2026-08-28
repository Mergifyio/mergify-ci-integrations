import dataclasses
import os
import random
import typing

import _pytest.nodes
import pytest

import pytest_mergify.quarantine
import pytest_mergify.test_selection
from pytest_mergify import _mergify_ci, flaky_detection, test_retry, tracing, utils

# OpenTelemetry resource-attribute keys the plugin reads back, kept as literals
# now that the semantic-convention package is gone with the SDK. They match the
# keys the Rust core emits in `otel_attributes`.
_VCS_REF_BASE_NAME = "vcs.ref.base.name"
_VCS_REF_HEAD_NAME = "vcs.ref.head.name"
_VCS_REF_HEAD_REVISION = "vcs.ref.head.revision"
_CICD_PIPELINE_NAME = "cicd.pipeline.name"
_CICD_PIPELINE_TASK_NAME = "cicd.pipeline.task.name"
_MERGIFY_TEST_JOB_NAME = "mergify.test.job.name"

# How the built spans leave the session.
TraceMode = typing.Literal["capture", "upload", "debug"]


@dataclasses.dataclass
class MergifyCIInsights:
    token: typing.Optional[str] = dataclasses.field(
        default_factory=lambda: os.environ.get("MERGIFY_TOKEN")
    )
    repo_name: typing.Optional[str] = dataclasses.field(
        default_factory=_mergify_ci.detect_repository_name
    )
    api_url: str = dataclasses.field(
        default_factory=lambda: os.environ.get(
            "MERGIFY_API_URL", "https://api.mergify.com"
        )
    )
    branch_name: typing.Optional[str] = dataclasses.field(
        init=False,
        default=None,
    )
    # None when spans are not being produced; otherwise how they leave the
    # session (retained for tests, uploaded via the binding, or printed).
    trace_mode: typing.Optional[TraceMode] = dataclasses.field(init=False, default=None)
    # The OpenTelemetry resource for the run, as a flat dict handed to
    # `upload_trace` alongside the spans.
    resource_attributes: typing.Optional[typing.Dict[str, tracing.AttrValue]] = (
        dataclasses.field(init=False, default=None)
    )
    test_run_id: str = dataclasses.field(
        init=False,
        default_factory=lambda: random.getrandbits(64).to_bytes(8, "big").hex(),
    )

    # The server's answer for this repository, held raw so both mechanisms can
    # be built from it -- and so the fetch happens once whether or not either
    # ends up running.
    run_context_dict: typing.Optional[typing.Dict[str, typing.Any]] = dataclasses.field(
        init=False,
        default=None,
    )

    flaky_detector: typing.Optional[flaky_detection.FlakyDetector] = dataclasses.field(
        init=False,
        default=None,
    )
    flaky_detector_error_message: typing.Optional[str] = dataclasses.field(
        init=False,
        default=None,
    )

    test_retrier: typing.Optional[test_retry.TestRetrier] = dataclasses.field(
        init=False,
        default=None,
    )
    # Its own, rather than flaky detection's: a repository may have opted into
    # retry alone, and being told a mechanism it never enabled is broken says
    # nothing about the one that is.
    test_retrier_error_message: typing.Optional[str] = dataclasses.field(
        init=False,
        default=None,
    )

    quarantined_tests: typing.Optional[pytest_mergify.quarantine.Quarantine] = (
        dataclasses.field(
            init=False,
            default=None,
        )
    )

    test_selection: typing.Optional[pytest_mergify.test_selection.TestSelection] = (
        dataclasses.field(
            init=False,
            default=None,
        )
    )

    # One binding-backed API client for the whole session, shared by the flaky,
    # quarantine, and test-selection fetches and the trace upload. Built once we
    # have a token and a well-formed repository name.
    api_client: typing.Optional["_mergify_ci.CiApiClient"] = dataclasses.field(
        init=False,
        default=None,
    )

    def __post_init__(self) -> None:
        if not utils.is_in_ci():
            return

        if utils.is_env_true("PYTEST_MERGIFY_DEBUG"):
            self.trace_mode = "debug"
        elif utils.is_env_true("_PYTEST_MERGIFY_TEST"):
            self.trace_mode = "capture"
        elif self.token and self.repo_name:
            self.trace_mode = "upload"
        else:
            return

        # The CI/git/mergify attributes come from the bundled Rust core
        # (`detect_attributes`, itself the merge of every provider + the git
        # fallback). `test.framework`/version is language-specific, so it is
        # added here rather than in the shared core.
        resource_attributes: typing.Dict[str, tracing.AttrValue] = dict(
            _mergify_ci.detect_attributes()
        )
        resource_attributes["test.framework"] = "pytest"
        resource_attributes["test.framework.version"] = pytest.__version__
        # The OpenTelemetry SDK used to set `telemetry.sdk.language` for free;
        # now that it is gone, set it explicitly -- the engine derives the
        # test's language from it (the fallback for a `test.language` span
        # attribute), so without it span_test.test_programming_language came
        # back NULL instead of "python" on the binding versions.
        resource_attributes["telemetry.sdk.language"] = "python"
        resource_attributes["test.run.id"] = self.test_run_id
        self.resource_attributes = resource_attributes

        # Retrieve the branch name, preferring base ref (target branch) over
        # head ref. `or` ensures an empty base ref (e.g. `GITHUB_BASE_REF=""` on
        # push runs) falls through to the head ref.
        branch_name = resource_attributes.get(
            _VCS_REF_BASE_NAME
        ) or resource_attributes.get(_VCS_REF_HEAD_NAME)
        if branch_name is not None:
            # `str` cast just for `mypy`.
            self.branch_name = str(branch_name)

        if self.token and self.repo_name:
            try:
                owner, repo = utils.split_full_repo_name(self.repo_name)
            except utils.InvalidRepositoryFullNameError:
                pass
            else:
                self.api_client = _mergify_ci.CiApiClient(
                    self.api_url, self.token, owner, repo, utils.get_version()
                )

        self._load_run_context()

        self._build_flaky_detector(
            # A base branch indicates a PR context. Use `new` mode for PRs to
            # detect newly flaky tests, `unhealthy` for push/scheduled runs to
            # focus on known problematic tests.
            mode="new" if resource_attributes.get(_VCS_REF_BASE_NAME) else "unhealthy",
        )

        self._build_test_retrier()

        self._load_quarantine()

        self._load_test_selection()

    def export_spans(
        self, spans: typing.List[tracing.Span]
    ) -> typing.Tuple[bool, typing.Optional[str]]:
        """Send the session's spans to their destination.

        Returns `(uploaded, error_message)`. In `capture`/`debug` modes nothing
        leaves the process, so both report success.
        """
        if self.trace_mode == "capture":
            # Spans stay on the plugin (`_finished_spans`) for tests to read;
            # nothing leaves the process.
            return True, None

        if self.trace_mode == "debug":
            for span in spans:
                print(f"MERGIFY SPAN {span['name']}: {span}")
            return True, None

        if self.api_client is None or self.resource_attributes is None:
            return False, None

        try:
            self.api_client.upload_trace(self.resource_attributes, spans)
        except RuntimeError as exception:
            return False, str(exception)

        return True, None

    def _load_quarantine(self) -> None:
        # api_client is only built when repo_name is set (see _setup), so this
        # also narrows repo_name to str for the Quarantine call below.
        if (
            self.api_client is None
            or self.branch_name is None
            or self.repo_name is None
        ):
            return

        names: typing.List[str] = []
        init_error_msg: typing.Optional[str] = None
        try:
            fetched = self.api_client.fetch_quarantine(self.branch_name)
        except RuntimeError as exception:
            init_error_msg = (
                "Error when querying Mergify's API, tests won't be quarantined. "
                f"Error: {str(exception)}"
            )
        else:
            # `None` is the dormant state (no subscription): no tests to mark,
            # but the report still lists the empty, error-free result.
            if fetched is not None:
                names = fetched

        self.quarantined_tests = pytest_mergify.quarantine.Quarantine(
            repo_name=self.repo_name,
            branch_name=self.branch_name,
            quarantined_tests=names,
            init_error_msg=init_error_msg,
        )

    def _load_test_selection(self) -> None:
        try:
            disabled = utils.strtobool(
                os.environ.get("MERGIFY_TEST_SELECTION_DISABLE", "false")
            )
        except ValueError:
            # A kill switch must never crash pytest startup: any value we
            # cannot parse reads as an attempt to disable.
            disabled = True

        if (
            self.api_client is None
            or self.resource_attributes is None
            or disabled
            # On xdist workers the controller already filtered the collection.
            or os.environ.get("PYTEST_XDIST_WORKER") is not None
        ):
            return

        # The selection is keyed on the run's OWN identity: the head branch
        # and head revision (a merge-queue draft branch on reruns) plus the
        # job coordinates — the exact values this plugin reports with each
        # uploaded test, so the server can match its records.
        head_branch = self.resource_attributes.get(_VCS_REF_HEAD_NAME)
        head_sha = self.resource_attributes.get(_VCS_REF_HEAD_REVISION)
        pipeline_name = self.resource_attributes.get(_CICD_PIPELINE_NAME)
        job_name = self.resource_attributes.get(
            _MERGIFY_TEST_JOB_NAME
        ) or self.resource_attributes.get(_CICD_PIPELINE_TASK_NAME)
        if not (head_branch and head_sha and pipeline_name and job_name):
            return

        init_error_msg: typing.Optional[str] = None
        try:
            fetched = self.api_client.fetch_test_selection(
                str(head_branch),
                str(head_sha),
                str(pipeline_name),
                str(job_name),
            )
        except RuntimeError as exception:
            init_error_msg = (
                "Error when querying Mergify's API, the full test suite will "
                f"run. Error: {str(exception)}"
            )
            fetched = None

        if fetched is None:
            # Dormant (no subscription/endpoint) or a failure: run everything.
            self.test_selection = pytest_mergify.test_selection.TestSelection(
                init_error_msg=init_error_msg,
            )
        else:
            self.test_selection = pytest_mergify.test_selection.TestSelection(
                selection=fetched["selection"],
                reason=fetched["reason"],
                tests=fetched["tests"],
            )

    def _load_run_context(self) -> None:
        """Fetch the context once, for whichever mechanisms it turns out to enable.

        Kept apart from building them: the fetch answers for a repository that
        opted into flaky detection, into test retry, or into both, and a reason
        to skip one of them is not a reason to go without the answer.
        """
        if (
            self.api_client is None
            # On xdist workers the context arrives from the controller, so skip
            # the redundant per-worker API call.
            or os.environ.get("PYTEST_XDIST_WORKER") is not None
        ):
            return

        try:
            # `None` is dormant: the repository opted into neither mechanism.
            self.run_context_dict = self.api_client.fetch_flaky_context()
        except RuntimeError as exception:
            # Both mechanisms are built from this one answer, so both are off.
            self.flaky_detector_error_message = (
                f"Could not load flaky detector: {str(exception)}"
            )
            self.test_retrier_error_message = (
                f"Could not load test retry: {str(exception)}"
            )

    def _build_flaky_detector(
        self,
        mode: typing.Literal["new", "unhealthy"],
    ) -> None:
        context = self.run_context_dict or {}
        # A repository that never opted into flaky detection is served both
        # lists empty: the server computes them from a detection config it does
        # not have. Building anyway would rerun the whole suite in `new` mode,
        # where every test looks new without a baseline, and in `unhealthy`
        # mode would write a "🐛 Flaky detection" block for a mechanism nobody
        # enabled. A repository that did opt in keeps its block even with
        # nothing unhealthy today, because its baseline is not empty.
        if not context.get("existing_test_names") and not (
            mode == "unhealthy" and context.get("unhealthy_test_names")
        ):
            return

        assert self.run_context_dict is not None

        self.flaky_detector = flaky_detection.FlakyDetector.from_context_dict(
            self.run_context_dict,
            mode,
            is_xdist=False,
        )

    def _build_test_retrier(self, is_xdist: bool = False) -> None:
        # An empty eligible set is the quiet case: either the repository did not
        # opt into retry, or it did and Mergify currently knows of no flaky test
        # to retry. Neither is worth a terminal block.
        if not (self.run_context_dict or {}).get("flaky_test_names"):
            return

        assert self.run_context_dict is not None
        self.test_retrier = test_retry.TestRetrier.from_context_dict(
            self.run_context_dict,
            is_xdist=is_xdist,
        )

    def load_mechanisms_from_context(
        self,
        context_dict: typing.Dict[str, typing.Any],
        mode: typing.Optional[typing.Literal["new", "unhealthy"]],
    ) -> None:
        """Build both mechanisms from pre-fetched context (xdist worker path).

        `mode` is `None` when the controller had no flaky detection to run, in
        which case retry may still have work: the two opt-ins are independent.
        """
        self.run_context_dict = context_dict

        # One `try` each: the mechanisms are independent opt-ins, so one of
        # them failing to build is not a reason for the worker to go without
        # the other.
        if mode is not None:
            try:
                self.flaky_detector = flaky_detection.FlakyDetector.from_context_dict(
                    context_dict,
                    mode,
                    is_xdist=True,
                )
            except Exception as exception:
                self.flaky_detector_error_message = (
                    f"Could not load flaky detector: {str(exception)}"
                )

        try:
            self._build_test_retrier(is_xdist=True)
        except Exception as exception:
            self.test_retrier_error_message = (
                f"Could not load test retry: {str(exception)}"
            )

    def mark_test_as_quarantined_if_needed(self, item: _pytest.nodes.Item) -> bool:
        """
        Returns `True` if the test was marked as quarantined, otherwise returns `False`.
        """
        if self.quarantined_tests is not None and item in self.quarantined_tests:
            self.quarantined_tests.mark_test_as_quarantined(item)
            return True

        return False
