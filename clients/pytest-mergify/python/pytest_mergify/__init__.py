"""pytest-mergify (walking-skeleton stub).

Re-exports the Rust-backed detection entrypoints from the embedded
``_mergify_ci`` extension. The real pytest plugin replaces this package in
MRGFY-7766; the way it imports the binding stays identical.
"""

from ._mergify_ci import (
    detect_attributes,
    detect_provider,
    detect_repository_name,
)

__all__ = ["detect_attributes", "detect_provider", "detect_repository_name"]
