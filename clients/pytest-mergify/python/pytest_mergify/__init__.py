"""pytest-mergify (walking-skeleton stub).

Re-exports the Rust-backed detection entrypoint from the embedded
``_mergify_ci`` extension. The real pytest plugin replaces this package in
MRGFY-7766; the way it imports the binding stays identical.
"""

from ._mergify_ci import detect_provider

__all__ = ["detect_provider"]
