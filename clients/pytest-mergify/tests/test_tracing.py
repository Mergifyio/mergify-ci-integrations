from pytest_mergify import tracing

VALID = "00-80e1afed08e019fc1110464cfa66635c-7a085853722dc6d2-01"


def test_parses_a_valid_traceparent() -> None:
    parsed = tracing.parse_traceparent(VALID)
    assert parsed is not None
    trace_id, parent_span_id = parsed
    assert trace_id == bytes.fromhex("80e1afed08e019fc1110464cfa66635c")
    assert parent_span_id == bytes.fromhex("7a085853722dc6d2")
    assert len(trace_id) == 16
    assert len(parent_span_id) == 8


def test_accepts_a_future_version_with_extra_fields() -> None:
    # A version above 00 may carry trailing fields, which are ignored.
    assert (
        tracing.parse_traceparent(
            "cc-80e1afed08e019fc1110464cfa66635c-7a085853722dc6d2-01-extra"
        )
        is not None
    )


def test_rejects_malformed_or_reserved_traceparents() -> None:
    cases = [
        "not-a-traceparent",
        # Uppercase hex — W3C trace-context is lowercase only.
        "00-80E1AFED08E019FC1110464CFA66635C-7a085853722dc6d2-01",
        # All-zero trace id / span id.
        "00-00000000000000000000000000000000-7a085853722dc6d2-01",
        "00-80e1afed08e019fc1110464cfa66635c-0000000000000000-01",
        # Wrong field widths.
        "00-80e1afed-7a085853722dc6d2-01",
        # Reserved version.
        "ff-80e1afed08e019fc1110464cfa66635c-7a085853722dc6d2-01",
        # Version 00 must carry exactly four fields.
        "00-80e1afed08e019fc1110464cfa66635c-7a085853722dc6d2-01-extra",
    ]
    for case in cases:
        assert tracing.parse_traceparent(case) is None, case
