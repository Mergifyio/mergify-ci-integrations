import dataclasses
import gzip
import http.server
import socketserver
import threading
import typing

from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
)

import _pytest.pytester
import pytest

import pytest_mergify
from pytest_mergify import _mergify_ci, tracing

pytest_plugins = ["pytester"]


def make_flaky_context(
    budget_ratio_for_new_tests: float = 0.1,
    budget_ratio_for_unhealthy_tests: float = 0.05,
    existing_test_names: typing.Optional[typing.List[str]] = None,
    existing_tests_mean_duration_ms: int = 0,
    unhealthy_test_names: typing.Optional[typing.List[str]] = None,
    max_test_execution_count: int = 1000,
    max_test_name_length: int = 65536,
    min_budget_duration_ms: int = 4000,
    min_test_execution_count: int = 5,
) -> typing.Dict[str, typing.Any]:
    """A flaky-detection context dict, as `CiApiClient.fetch_flaky_context` returns."""
    return {
        "budget_ratio_for_new_tests": budget_ratio_for_new_tests,
        "budget_ratio_for_unhealthy_tests": budget_ratio_for_unhealthy_tests,
        "existing_test_names": existing_test_names or [],
        "existing_tests_mean_duration_ms": existing_tests_mean_duration_ms,
        "unhealthy_test_names": unhealthy_test_names or [],
        "max_test_execution_count": max_test_execution_count,
        "max_test_name_length": max_test_name_length,
        "min_budget_duration_ms": min_budget_duration_ms,
        "min_test_execution_count": min_test_execution_count,
    }


def install_fake_api_client(
    monkeypatch: pytest.MonkeyPatch,
    *,
    quarantine: typing.Optional[typing.List[str]] = None,
    flaky_context: typing.Optional[typing.Dict[str, typing.Any]] = None,
    test_selection: typing.Optional[typing.Dict[str, typing.Any]] = None,
    quarantine_error: typing.Optional[str] = None,
    flaky_error: typing.Optional[str] = None,
    test_selection_error: typing.Optional[str] = None,
) -> None:
    """Replace the binding's `CiApiClient` with a fake returning injected data.

    The fetches themselves are unit-tested in Rust (wiremock: pagination,
    402/404, failures); the plugin-side tests only need the data the lifecycle
    would have received, so no HTTP is performed. Passing a `*_error` makes the
    matching fetch raise `RuntimeError`, as the binding does on a real failure.
    """

    class _FakeApiClient:
        def __init__(self, api_url: str, token: str, owner: str, repo: str) -> None:
            pass

        def fetch_quarantine(self, branch: str) -> typing.Optional[typing.List[str]]:
            if quarantine_error is not None:
                raise RuntimeError(quarantine_error)
            return quarantine

        def fetch_flaky_context(
            self,
        ) -> typing.Optional[typing.Dict[str, typing.Any]]:
            if flaky_error is not None:
                raise RuntimeError(flaky_error)
            return flaky_context

        def fetch_test_selection(
            self,
            branch: str,
            head_sha: str,
            pipeline_name: str,
            job_name: str,
        ) -> typing.Optional[typing.Dict[str, typing.Any]]:
            if test_selection_error is not None:
                raise RuntimeError(test_selection_error)
            return test_selection

    monkeypatch.setattr(_mergify_ci, "CiApiClient", _FakeApiClient)


@pytest.fixture(autouse=True)
def set_api_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Always override API
    monkeypatch.setenv("MERGIFY_API_URL", "http://localhost:9999")


@pytest.fixture(autouse=True)
def isolate_ci_provider_env(monkeypatch: pytest.MonkeyPatch) -> None:
    # A host CI (e.g. GitHub Actions running this very suite) sets provider vars
    # the Rust core would otherwise detect, leaking into tests. Clear them so
    # each test starts clean and opts into a provider explicitly.
    for var in ("GITHUB_ACTIONS", "CIRCLECI", "JENKINS_URL", "BUILDKITE"):
        monkeypatch.delenv(var, raising=False)


class CapturedSpans(typing.Dict[str, tracing.Span]):
    """The run's spans keyed by name, plus the resource they upload under.

    A `dict` subclass so `spans["name"]`, `spans.values()`, and `len(spans)`
    work as before, while `spans.resource` exposes the run's resource
    attributes (one dict per run, previously read off each span's `.resource`).
    """

    resource: typing.Dict[str, tracing.AttrValue]


PytesterWithSpanReturnT = typing.Tuple[
    _pytest.pytester.RunResult, typing.Optional[CapturedSpans]
]


class PytesterWithSpanT(typing.Protocol):
    def __call__(
        self,
        code: str = ...,
        setenv: typing.Optional[typing.Dict[str, typing.Optional[str]]] = ...,
        quarantined_tests: typing.Optional[typing.List[str]] = None,
        flaky_context: typing.Optional[typing.Dict[str, typing.Any]] = None,
        test_selection: typing.Optional[typing.Dict[str, typing.Any]] = None,
    ) -> PytesterWithSpanReturnT: ...


_DEFAULT_PYTESTER_CODE = "def test_pass(): pass"


@pytest.fixture
def pytester_with_spans(
    pytester: _pytest.pytester.Pytester,
    monkeypatch: pytest.MonkeyPatch,
) -> PytesterWithSpanT:
    def _run(
        code: str = _DEFAULT_PYTESTER_CODE,
        setenv: typing.Optional[typing.Dict[str, typing.Optional[str]]] = None,
        quarantined_tests: typing.Optional[typing.List[str]] = None,
        flaky_context: typing.Optional[typing.Dict[str, typing.Any]] = None,
        test_selection: typing.Optional[typing.Dict[str, typing.Any]] = None,
    ) -> PytesterWithSpanReturnT:
        monkeypatch.delenv("PYTEST_MERGIFY_DEBUG", raising=False)
        monkeypatch.setenv("CI", "true")
        monkeypatch.setenv("_PYTEST_MERGIFY_TEST", "true")

        for k, v in (setenv or {}).items():
            if v is None:
                monkeypatch.delenv(k, raising=False)
            else:
                monkeypatch.setenv(k, v)

        # The plugin's fetches go through the binding (Rust reqwest); a fake
        # client feeds them the injected data so no HTTP is attempted.
        install_fake_api_client(
            monkeypatch,
            quarantine=list(quarantined_tests) if quarantined_tests else [],
            flaky_context=flaky_context,
            test_selection=test_selection,
        )

        plugin = pytest_mergify.PytestMergify()
        pytester.makepyfile(code)
        result = pytester.runpytest_inprocess(plugins=[plugin])

        captured: typing.Optional[CapturedSpans]
        if code is _DEFAULT_PYTESTER_CODE:
            result.assert_outcomes(passed=1)
        if plugin.mergify_ci.trace_mode is not None:
            spans = plugin._finished_spans
            captured = CapturedSpans((span["name"], span) for span in spans)
            captured.resource = plugin.mergify_ci.resource_attributes or {}
            # Make sure we don't lose spans in the process
            assert len(captured) == len(spans)
        else:
            captured = None

        return result, captured

    return _run


class TestHTTPRequestHandler(http.server.BaseHTTPRequestHandler):
    # Class attribute for the response code, set by the fixture.
    response_code: int = 200

    def do_POST(self) -> None:
        path = self.path[1:].split("/")
        # loozy match, who cares
        if path[0] == "v1" and path[-1] == "traces":
            self.send_response(self.__class__.response_code)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"OK")
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format: str, *args: object) -> None:
        # Override to suppress console logging during tests.
        pass


def _decode_any_value(value: typing.Any) -> typing.Any:
    kind = value.WhichOneof("value")
    if kind is None:
        return None

    if kind == "array_value":
        return [_decode_any_value(item) for item in value.array_value.values]

    return getattr(value, kind)


def _decode_attributes(key_values: typing.Any) -> typing.Dict[str, typing.Any]:
    return {kv.key: _decode_any_value(kv.value) for kv in key_values}


@dataclasses.dataclass
class UploadedSpan:
    name: str
    attributes: typing.Dict[str, typing.Any]


@dataclasses.dataclass
class UploadedBatch:
    """
    One resource's spans, as they arrived over the wire.

    A request carries a batch per resource it saw, so counting these counts
    resources rather than requests -- which for this plugin, holding one
    provider for the whole session, comes to one per request.
    """

    resource_attributes: typing.Dict[str, typing.Any]
    spans: typing.List[UploadedSpan]

    def span(self, name: str) -> UploadedSpan:
        """
        The one span with this name.

        A list rather than a dict keyed by name, because names repeat: a rerun
        of a flaky test uploads the same node id again. Unpacking raises here
        instead of letting the second copy overwrite the first unseen.
        """
        (span,) = [span for span in self.spans if span.name == name]
        return span


class _OTLPServer(socketserver.TCPServer):
    allow_reuse_address = True

    def __init__(self, *args: typing.Any, **kwargs: typing.Any) -> None:
        self.bodies: typing.List[bytes] = []
        super().__init__(*args, **kwargs)


class _OTLPRequestHandler(http.server.BaseHTTPRequestHandler):
    server: _OTLPServer

    def do_POST(self) -> None:
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if self.headers.get("Content-Encoding") == "gzip":
            body = gzip.decompress(body)
        self.server.bodies.append(body)

        self.send_response(200)
        self.send_header("Content-Type", "application/x-protobuf")
        self.end_headers()

    def do_GET(self) -> None:
        # Quarantine and test selection share this base URL. Answering 404 keeps
        # them out of the way without pretending they were served.
        self.send_response(404)
        self.end_headers()

    def log_message(self, format: str, *args: object) -> None:
        pass


@dataclasses.dataclass
class OTLPCollector:
    """
    What the plugin actually put on the wire.

    The in-memory exporter reaches into the plugin's own process, which cannot
    see a batch that was never sent, a process other than this one, or a run
    that ended without a terminal summary. This can.
    """

    url: str
    _server: _OTLPServer

    @property
    def batches(self) -> typing.List[UploadedBatch]:
        batches = []

        for body in self._server.bodies:
            request = ExportTraceServiceRequest()
            request.ParseFromString(body)

            for resource_spans in request.resource_spans:
                spans = [
                    UploadedSpan(
                        name=span.name,
                        attributes=_decode_attributes(span.attributes),
                    )
                    for scope_spans in resource_spans.scope_spans
                    for span in scope_spans.spans
                ]
                batches.append(
                    UploadedBatch(
                        resource_attributes=_decode_attributes(
                            resource_spans.resource.attributes
                        ),
                        spans=spans,
                    )
                )

        return batches

    @property
    def span_names(self) -> typing.Set[str]:
        return {span.name for batch in self.batches for span in batch.spans}


@pytest.fixture
def otlp_collector() -> typing.Generator[OTLPCollector, None, None]:
    with _OTLPServer(("127.0.0.1", 0), _OTLPRequestHandler) as httpd:
        host, port = httpd.server_address[0], httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever)
        thread.daemon = True
        thread.start()

        yield OTLPCollector(url=f"http://{host!s}:{port}", _server=httpd)

        httpd.shutdown()


@pytest.fixture
def http_server(request: pytest.FixtureRequest) -> typing.Generator[str, None, None]:
    # Allow parameterization of the response code via request.param.
    response_code = getattr(request, "param", 200)
    TestHTTPRequestHandler.response_code = response_code

    with socketserver.TCPServer(("", 0), TestHTTPRequestHandler) as httpd:
        host, port = httpd.server_address  # retrieve the actual port
        thread = threading.Thread(target=httpd.serve_forever)
        thread.daemon = True
        thread.start()
        yield f"http://{host!s}:{port}"
        httpd.shutdown()
