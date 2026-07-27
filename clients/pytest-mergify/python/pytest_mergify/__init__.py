"""pytest-mergify (walking-skeleton stub).

Re-exports the Rust-backed entrypoints from the embedded ``_mergify_ci``
extension: the detection functions, plus the flaky-detection budget engine
grouped under the ``budget`` namespace. The real pytest plugin replaces this
package in MRGFY-7766; the way it imports the binding stays identical.
"""

from . import budget
from ._mergify_ci import (
    detect_attributes,
    detect_provider,
    detect_repository_name,
)

__all__ = [
    "budget",
    "detect_attributes",
    "detect_provider",
    "detect_repository_name",
]
