"""Flaky-detection budget engine.

A thin namespace over the shared Rust core (``_mergify_ci``): test selection,
the session rerun budget, and the per-test time shares. Pure functions, no I/O.

The binding exposes these flat (``compute_budget``, ``should_run``, …); the
grouping and the shorter names live here, in Python, rather than as a PyO3
submodule — a real module avoids the ``sys.modules`` registration a compiled
submodule would need.
"""

from ._mergify_ci import (
    compute_budget as compute,
    dynamic_share_ms,
    should_run,
    static_share_ms,
)

__all__ = ["compute", "dynamic_share_ms", "should_run", "static_share_ms"]
