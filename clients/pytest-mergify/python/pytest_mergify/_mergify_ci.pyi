# Type stub for the compiled Rust binding (built by maturin from ../../src/lib.rs
# and packaged as pytest_mergify._mergify_ci). Keep in sync with lib.rs.

from typing import Any, Dict, List, Mapping, Optional, Sequence

def detect_provider() -> Optional[str]: ...
def detect_repository_name() -> Optional[str]: ...
def detect_attributes() -> Dict[str, Any]: ...
def compute_budget(
    context: Dict[str, Any],
    mode: str,
    session_tests: List[str],
    excluded: List[str],
) -> Dict[str, Any]: ...
def should_run(context: Dict[str, Any], mode: str) -> bool: ...
def static_share_ms(available_budget_ms: float, num_tests: int) -> float: ...
def dynamic_share_ms(
    available_budget_ms: float,
    used_budget_ms: float,
    num_tests: int,
    processed: int,
) -> float: ...

class CiApiClient:
    def __init__(
        self,
        api_url: str,
        token: str,
        owner: str,
        repo: str,
        client_version: str,
    ) -> None: ...
    def fetch_quarantine(self, branch: str) -> Optional[List[str]]: ...
    def fetch_flaky_context(self) -> Optional[Dict[str, Any]]: ...
    def fetch_test_selection(
        self,
        branch: str,
        head_sha: str,
        pipeline_name: str,
        job_name: str,
    ) -> Optional[Dict[str, Any]]: ...
    def upload_trace(
        self,
        resource_attributes: Mapping[str, Any],
        spans: Sequence[Mapping[str, Any]],
    ) -> None: ...
