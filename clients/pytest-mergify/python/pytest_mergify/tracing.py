"""Native span records for the trace-upload path.

Replaces the OpenTelemetry SDK: the plugin builds these plain, typed records
directly and hands the batch to the bundled binding (`CiApiClient.upload_trace`)
which encodes and uploads them as OTLP. Keeping them as a `TypedDict` means they
type-check under `mypy --strict` yet are already the exact `dict` shape the
binding parses -- one representation end to end, no conversion.
"""

import os
import re
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


# W3C trace-context is lowercase hex only; an all-zero id is invalid.
_HEX = re.compile(r"\A[0-9a-f]+\Z")
_ZERO_TRACE_ID = b"\x00" * 16
_ZERO_SPAN_ID = b"\x00" * 8


def parse_traceparent(
    traceparent: str,
) -> typing.Optional[typing.Tuple[bytes, bytes]]:
    """Parse a W3C `traceparent` into `(trace_id, parent_span_id)` bytes.

    Format: `<version>-<32 hex trace id>-<16 hex span id>-<flags>`, all
    lowercase hex per the spec. A version-`00` traceparent has exactly those
    four fields; a future version may carry extra trailing fields, which are
    ignored. A malformed or reserved value -- wrong widths, uppercase or
    non-hex, an all-zero id, or the reserved `ff` version -- yields `None`, so
    the session starts a fresh, unparented trace. This mirrors the W3C
    propagator pytest-mergify parsed it with, which rejected the same inputs.
    """
    parts = traceparent.split("-")
    if len(parts) < 4:
        return None

    version, trace_id_hex, span_id_hex, flags = parts[:4]

    # Version: two lowercase-hex chars; `ff` is reserved. Only version `00`
    # forbids trailing fields.
    if len(version) != 2 or not _HEX.match(version) or version == "ff":
        return None
    if version == "00" and len(parts) != 4:
        return None

    # Fixed widths, lowercase hex, a well-formed 2-char flags field.
    if (
        len(trace_id_hex) != 32
        or len(span_id_hex) != 16
        or len(flags) != 2
        or not _HEX.match(trace_id_hex)
        or not _HEX.match(span_id_hex)
        or not _HEX.match(flags)
    ):
        return None

    trace_id = bytes.fromhex(trace_id_hex)
    parent_span_id = bytes.fromhex(span_id_hex)

    # An all-zero trace or span id is invalid per the spec.
    if trace_id == _ZERO_TRACE_ID or parent_span_id == _ZERO_SPAN_ID:
        return None

    return trace_id, parent_span_id
