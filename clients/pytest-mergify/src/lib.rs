//! Rust binding embedded in the `pytest-mergify` wheel (walking skeleton).
//!
//! Built as a `cdylib` by maturin and packaged *inside* the pytest-mergify
//! wheel as `pytest_mergify._mergify_ci` — there is no separately published
//! binding artifact (the bundled model). When the real pytest plugin migrates
//! in (MRGFY-7766) it replaces the stub Python package next to this file; the
//! binding wiring stays identical.

use std::collections::BTreeMap;

use mergify_ci_api::{ApiConfig, Client, FlakyDetectionContext, Outcome};
use mergify_ci_core::{AttrValue as CoreAttrValue, CiContext};
use pyo3::exceptions::PyRuntimeError;
use pyo3::prelude::*;
use pyo3::types::PyDict;

/// Detect from the current process environment and working directory.
fn context() -> CiContext {
    let env: BTreeMap<String, String> = std::env::vars().collect();
    let cwd = std::env::current_dir().unwrap_or_else(|_| ".".into());
    mergify_ci_core::detect(&env, &cwd)
}

/// The detected CI provider, or `None` when not running in CI.
#[pyfunction]
fn detect_provider() -> Option<String> {
    context().provider.map(|p| p.as_str().to_owned())
}

/// The detected API-endpoint `owner/repo`, or `None` when undeterminable.
#[pyfunction]
fn detect_repository_name() -> Option<String> {
    context().repository_name
}

/// The OpenTelemetry resource attributes for this run, as a `dict[str, str|int]`.
#[pyfunction]
fn detect_attributes(py: Python<'_>) -> PyResult<Py<PyDict>> {
    let dict = PyDict::new(py);
    for (key, value) in mergify_ci_core::otel_attributes(&context()) {
        match value {
            CoreAttrValue::Int(i) => dict.set_item(key, i)?,
            CoreAttrValue::Str(s) => dict.set_item(key, s)?,
        }
    }
    Ok(dict.into())
}

/// A blocking Python wrapper over the async `mergify_ci_api::Client`.
///
/// The core client is async so mergify-cli can share it; Python is sync, so
/// each call drives the future to completion on an owned single-threaded
/// runtime with the GIL released (`Python::detach`). Fetches resolve to a
/// value, `None` when the feature is not enabled for the repository, or raise
/// `RuntimeError` on a genuine failure.
#[pyclass]
struct CiApiClient {
    runtime: tokio::runtime::Runtime,
    client: Client,
}

#[pymethods]
impl CiApiClient {
    #[new]
    fn new(api_url: String, token: String, owner: String, repo: String) -> PyResult<Self> {
        let client = Client::new(ApiConfig::new(api_url, token, owner, repo)).map_err(|error| {
            PyRuntimeError::new_err(format!("failed to build HTTP client: {error}"))
        })?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| PyRuntimeError::new_err(format!("failed to start runtime: {error}")))?;
        Ok(Self { runtime, client })
    }

    /// The quarantined test names, or `None` when quarantine is not enabled.
    fn fetch_quarantine(&self, py: Python<'_>, branch: &str) -> PyResult<Option<Vec<String>>> {
        let outcome = py.detach(|| self.runtime.block_on(self.client.fetch_quarantine(branch)));
        match outcome {
            Outcome::Ready(names) => Ok(Some(names)),
            Outcome::Dormant => Ok(None),
            Outcome::Failed(message) => Err(PyRuntimeError::new_err(message)),
        }
    }

    /// The flaky-detection context as a dict, or `None` when it is not enabled.
    fn fetch_flaky_context(&self, py: Python<'_>) -> PyResult<Option<Py<PyDict>>> {
        let outcome = py.detach(|| self.runtime.block_on(self.client.fetch_flaky_context()));
        match outcome {
            Outcome::Ready(context) => Ok(Some(flaky_context_dict(py, &context)?)),
            Outcome::Dormant => Ok(None),
            Outcome::Failed(message) => Err(PyRuntimeError::new_err(message)),
        }
    }
}

/// Marshal a [`FlakyDetectionContext`] into the dict shape pytest-mergify feeds
/// to its own dataclass (`_FlakyDetectionContext(**dict)`).
fn flaky_context_dict(py: Python<'_>, context: &FlakyDetectionContext) -> PyResult<Py<PyDict>> {
    let dict = PyDict::new(py);
    dict.set_item("budget_ratio_for_new_tests", context.budget_ratio_for_new_tests)?;
    dict.set_item("budget_ratio_for_unhealthy_tests", context.budget_ratio_for_unhealthy_tests)?;
    dict.set_item("existing_test_names", context.existing_test_names.clone())?;
    dict.set_item("existing_tests_mean_duration_ms", context.existing_tests_mean_duration_ms)?;
    dict.set_item("unhealthy_test_names", context.unhealthy_test_names.clone())?;
    dict.set_item("max_test_execution_count", context.max_test_execution_count)?;
    dict.set_item("max_test_name_length", context.max_test_name_length)?;
    dict.set_item("min_budget_duration_ms", context.min_budget_duration_ms)?;
    dict.set_item("min_test_execution_count", context.min_test_execution_count)?;
    Ok(dict.into())
}

#[pymodule]
fn _mergify_ci(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(detect_provider, m)?)?;
    m.add_function(wrap_pyfunction!(detect_repository_name, m)?)?;
    m.add_function(wrap_pyfunction!(detect_attributes, m)?)?;
    m.add_class::<CiApiClient>()?;
    Ok(())
}
