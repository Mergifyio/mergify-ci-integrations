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

# Resource attribute carrying the identity of the tests this run collected --
# reported with the spans so the engine can persist it on the run.
_TEST_COLLECTION_FINGERPRINT = "test.collection.fingerprint"
# How many tests that same collection holds. Derived from the very list the
# fingerprint is computed over, so the two can never describe different sets,
# and reported on every run whether or not a selection was ever asked for: it
# is the denominator a reduction is read against, and the engine cannot
# recount it from the uploaded results, whose ingestion keeps no row for an
# ordinary passing test (MRGFY-8885).
_TEST_COLLECTION_COUNT = "test.collection.count"

# The served answer as this run applied it. Nothing on the server keeps its own
# answer -- it is computed, served, and dropped -- so a session that does not
# describe its own reduction leaves no reduction reportable afterwards, for any
# surface (MRGFY-8859). "As applied" and not "as sent", because the two differ:
# a subset matching none of the collected tests degrades to a full run here,
# and the reporting has to describe the run that happened rather than the one
# that was offered.
#
# `answer`, not `outcome`: `Outcome` is this repository's word for how an API
# call went -- `Ready`, `Dormant`, `Failed` (`crates/mergify-ci-api`), and
# `fetch_test_selection` returns one -- so a key named after it would read as
# "did the selection work", under which `full` means success. It is the
# opposite: `full` is what a served full answer and every degradation alike
# come to.
_TEST_SELECTION_ANSWER = "test.selection.answer"
# The server's own word for why it answered that way, forwarded verbatim and
# never read here -- except that a degradation replaces it with the client's
# own (`subset_matched_no_collected_test`), so a reader cannot assume every
# value came from the server.
_TEST_SELECTION_REASON = "test.selection.reason"
# How many tests the selection left this run to run -- the whole collection on
# a full run, the served subset on a reduced one, none on an `empty` answer and
# none on a refusal, which stops the run before any test starts.
#
# `kept`, the word this module already uses for the quantity, and not
# `executed`: it is counted in the collection hook, before a single test has
# started, so it is what selection left rather than what ran. Fewer run under
# `-x`, under `--maxfail`, or when the interpreter dies mid-suite, and a saving
# computed from an "executed" count would quietly over-claim on all three.
_TEST_SELECTION_KEPT_COUNT = "test.selection.kept_count"

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
    # Whether the object above holds an answer the server actually gave. It is
    # also built when the fetch came back with nothing to answer with -- no
    # subscription, or the endpoint not serving this repository -- and when the
    # fetch failed outright, and in both cases it reads as a plain full run
    # (`selection="full"`, `reason="not_requested"`). Those runs are not runs
    # Mergify answered `full`, and reporting them as such would count every
    # repository outside the pilot, and every run whose request errored, as a
    # reduction the feature chose not to make.
    test_selection_was_served: bool = dataclasses.field(init=False, default=False)

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

        # Test selection is NOT loaded here: it is asked for once the tests are
        # collected, so the request can carry their fingerprint. See
        # `on_tests_collected`.

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

    def on_tests_collected(self, collected_test_ids: typing.List[str]) -> None:
        """Take the identity of what this run collected, and act on it.

        Called from the collection hook, once user filters (`-k`, `-m`,
        `--deselect`) have run: the fingerprint then describes the set this run
        actually intends to execute. It does two independent things — reports
        the fingerprint with the run's spans, and asks Mergify whether a subset
        of that collection is enough — so a run that never asks (no
        subscription, no job coordinates, the kill switch) still reports it.
        """
        if self.resource_attributes is None:
            # No resource means no spans and no API client: nothing to report
            # the fingerprint on, and nobody to ask.
            return

        if os.environ.get("PYTEST_XDIST_WORKER") is not None:
            # Every worker of a run collects the whole suite, so all of them
            # would report ONE identity while each holds a fraction of the
            # results -- measured: `pytest -n 2` over three tests uploads two
            # sessions, both claiming the three-test fingerprint. That breaks
            # the design's degradation rule, which is that a session whose
            # results never arrive matches no fingerprint and only that session
            # pays: here a worker that died before uploading leaves its
            # siblings carrying the same identity, failure-free, for a suite
            # part of which never ran.
            #
            # (A reduced rerun also collects more than it executes, but there
            # the identity belongs to one session and the server chose the
            # reduction, so it stays attributable. What cannot be attributed is
            # a set of sibling sessions sharing an identity.)
            #
            # Selection is off under `-n` anyway (MRGFY-8632), so reporting
            # nothing costs nothing.
            return

        fingerprint = _mergify_ci.compute_test_collection_fingerprint(
            collected_test_ids
        )
        self.resource_attributes[_TEST_COLLECTION_FINGERPRINT] = fingerprint
        self.resource_attributes[_TEST_COLLECTION_COUNT] = len(collected_test_ids)

        self._load_test_selection(fingerprint)

    def on_selection_applied(self, kept_count: int) -> None:
        """Report what the served selection came to, on the run's own session.

        Called once the answer has been applied to the collection, which is the
        only moment both halves are known: the collection is what the fetch was
        keyed on, and `kept_count` is what survived it.

        Nothing is reported unless the server actually answered. A run that
        never asked -- the kill switch, incomplete job coordinates, an xdist
        worker -- and a run whose question went unanswered -- no subscription,
        or a fetch that errored -- both degrade to a full run locally, and
        neither was offered a reduction. That absence is the honest signal:
        recording a `full` answer for them would make a repository outside the
        pilot, and an API that was down, indistinguishable from a run Mergify
        looked at and chose not to reduce -- in every count taken afterwards.
        """
        if (
            self.resource_attributes is None
            or self.test_selection is None
            or not self.test_selection_was_served
        ):
            return

        self.resource_attributes[_TEST_SELECTION_ANSWER] = self.test_selection.selection
        self.resource_attributes[_TEST_SELECTION_REASON] = self.test_selection.reason
        self.resource_attributes[_TEST_SELECTION_KEPT_COUNT] = kept_count

    def _load_test_selection(self, collection_fingerprint: str) -> None:
        try:
            disabled = utils.strtobool(
                os.environ.get("MERGIFY_TEST_SELECTION_DISABLE", "false")
            )
        except ValueError:
            # A kill switch must never crash pytest startup: any value we
            # cannot parse reads as an attempt to disable.
            disabled = True

        if self.api_client is None or self.resource_attributes is None or disabled:
            return

        # The selection is keyed on the run's OWN identity: the head branch
        # and head revision (a merge-queue draft branch on reruns) plus the
        # job coordinates — the exact values this plugin reports with each
        # uploaded test, so the server can match its records. The collection
        # fingerprint travels with them: a subset is only safe to serve when
        # this run collects the same tests the previous attempt did.
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
                collection_fingerprint,
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
            self.test_selection_was_served = True
            self.test_selection = pytest_mergify.test_selection.TestSelection(
                selection=fetched["selection"],
                reason=fetched["reason"],
                tests=fetched["tests"],
                # `.get`, unlike the keys above, even though the binding sets
                # this key on every answer: the plugin already holds a wording
                # for a refusal that arrives without one, so a binding that
                # stopped setting it should reach the user as that fallback
                # rather than as a `KeyError` crashing their pytest session.
                message=fetched.get("message"),
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
