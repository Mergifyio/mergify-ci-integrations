"""Native span records for the trace-upload path.

Replaces the OpenTelemetry SDK: the plugin builds these plain, typed records
directly and hands the batch to the bundled binding (`CiApiClient.upload_trace`)
which encodes and uploads them as OTLP. Keeping them as a `TypedDict` means they
type-check under `mypy --strict` yet are already the exact `dict` shape the
binding parses -- one representation end to end, no conversion.
"""

import os
import typing

AttrValue = typing.Union[str, int, float, bool]

SpanStatus = typing.Literal["unset", "ok", "error"]


class Span(typing.TypedDict):
    name: str
    # 16-byte trace id and 8-byte span id, as the OTLP wire format wants them.
    trace_id: bytes
    span_id: bytes
    parent_span_id: typing.Optional[bytes]
    start_unix_nano: int
    end_unix_nano: int
    attributes: typing.Dict[str, AttrValue]
    status: SpanStatus
    status_message: typing.Optional[str]


def new_trace_id() -> bytes:
    return os.urandom(16)


def new_span_id() -> bytes:
    return os.urandom(8)


def parse_traceparent(
    traceparent: str,
) -> typing.Optional[typing.Tuple[bytes, bytes]]:
    """Parse a W3C `traceparent` into `(trace_id, parent_span_id)` bytes.

    Format: `<version>-<32 hex trace id>-<16 hex span id>-<flags>`. Anything
    that does not parse to a 16-byte trace id and an 8-byte span id yields
    `None`, so a malformed value simply starts a fresh, unparented trace.
    """
    parts = traceparent.split("-")
    if len(parts) != 4:
        return None

    _version, trace_id_hex, span_id_hex, _flags = parts
    try:
        trace_id = bytes.fromhex(trace_id_hex)
        parent_span_id = bytes.fromhex(span_id_hex)
    except ValueError:
        return None

    if len(trace_id) != 16 or len(parent_span_id) != 8:
        return None

    return trace_id, parent_span_id
