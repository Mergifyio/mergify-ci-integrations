from pytest_mergify import tracing


def test_parses_a_valid_traceparent() -> None:
    parsed = tracing.parse_traceparent(
        "00-80e1afed08e019fc1110464cfa66635c-7a085853722dc6d2-01"
    )
    assert parsed == (
        bytes.fromhex("80e1afed08e019fc1110464cfa66635c"),
        bytes.fromhex("7a085853722dc6d2"),
    )


def test_ignores_trailing_future_version_fields() -> None:
    # A future traceparent version may append fields after the flags; a v00
    # parser is expected to ignore them rather than reject the whole value.
    parsed = tracing.parse_traceparent(
        "01-80e1afed08e019fc1110464cfa66635c-7a085853722dc6d2-01-extra"
    )
    assert parsed == (
        bytes.fromhex("80e1afed08e019fc1110464cfa66635c"),
        bytes.fromhex("7a085853722dc6d2"),
    )


def test_rejects_all_zero_ids() -> None:
    # All-zero ids are invalid per W3C; start a fresh, unparented trace.
    assert (
        tracing.parse_traceparent(
            "00-00000000000000000000000000000000-0000000000000000-01"
        )
        is None
    )


def test_rejects_malformed_traceparent() -> None:
    assert tracing.parse_traceparent("garbage") is None
    assert tracing.parse_traceparent("00-nothex-7a085853722dc6d2-01") is None
    assert tracing.parse_traceparent("00-80e1afed08e019fc1110464cfa66635c") is None
