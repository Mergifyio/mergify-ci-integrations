//! Rust binding embedded in the `pytest-mergify` wheel (walking skeleton).
//!
//! Built as a `cdylib` by maturin and packaged *inside* the pytest-mergify
//! wheel as `pytest_mergify._mergify_ci` — there is no separately published
//! binding artifact (the bundled model). When the real pytest plugin migrates
//! in (MRGFY-7766) it replaces the stub Python package next to this file; the
//! binding wiring stays identical.

use std::collections::BTreeMap;

use mergify_ci_api::{
    ApiConfig, AttrValue, Client, FlakyDetectionContext, Mode, Outcome, SpanData, SpanStatus,
    budget,
};
use mergify_ci_core::{AttrValue as CoreAttrValue, CiContext};
use pyo3::exceptions::{PyKeyError, PyRuntimeError, PyTypeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyBool, PyDict};

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
/// `RuntimeError` on a genuine failure. Trace upload fails loud.
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

    /// Upload `spans` (under `resource_attributes`) as gzipped OTLP protobuf.
    ///
    /// `resource_attributes` is a `dict[str, str|int|float|bool]`; each span is
    /// a dict with `name`, `trace_id` (16 bytes), `span_id` (8 bytes), optional
    /// `parent_span_id` (8 bytes), `start_unix_nano`, `end_unix_nano`, optional
    /// `attributes` (a dict), and optional `status` (`"unset"`/`"ok"`/`"error"`
    /// with an optional `status_message`). Raises `RuntimeError` on failure.
    // pyo3 extracts the span list by value; we only borrow it to marshal.
    #[allow(clippy::needless_pass_by_value)]
    fn upload_trace(
        &self,
        py: Python<'_>,
        resource_attributes: &Bound<'_, PyDict>,
        spans: Vec<Bound<'_, PyDict>>,
    ) -> PyResult<()> {
        let resource = attributes_from_dict(resource_attributes)?;
        let spans = spans
            .iter()
            .map(span_from_dict)
            .collect::<PyResult<Vec<SpanData>>>()?;
        py.detach(|| self.runtime.block_on(self.client.upload_trace(&resource, &spans)))
            .map_err(|error| PyRuntimeError::new_err(error.to_string()))
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

/// Select the tests to rerun and compute the session's rerun budget.
///
/// `context` is the dict from [`CiApiClient::fetch_flaky_context`], `mode` is
/// `"new"` or `"unhealthy"`. Returns a dict with `available_budget_ms` and
/// `tests_to_process`.
// pyo3 extracts the test lists by value; the budget engine only borrows them.
#[allow(clippy::needless_pass_by_value)]
#[pyfunction]
fn compute_budget(
    py: Python<'_>,
    context: &Bound<'_, PyDict>,
    mode: &str,
    session_tests: Vec<String>,
    excluded: Vec<String>,
) -> PyResult<Py<PyDict>> {
    let plan = budget::plan(&context_from_dict(context)?, parse_mode(mode)?, &session_tests, &excluded);
    let result = PyDict::new(py);
    result.set_item("available_budget_ms", plan.available_budget_ms)?;
    result.set_item("tests_to_process", plan.tests_to_process)?;
    Ok(result.into())
}

/// Whether flaky detection should run for `context` and `mode` (`false` in
/// `"new"` mode with an empty baseline).
#[pyfunction]
fn should_run(context: &Bound<'_, PyDict>, mode: &str) -> PyResult<bool> {
    Ok(budget::should_run(&context_from_dict(context)?, parse_mode(mode)?))
}

/// Per-test time share (ms) for a static, equal split of the whole budget.
#[pyfunction]
fn static_share_ms(available_budget_ms: f64, num_tests: usize) -> f64 {
    budget::static_share_ms(available_budget_ms, num_tests)
}

/// Per-test time share (ms) for a dynamic split of the remaining budget.
#[pyfunction]
fn dynamic_share_ms(
    available_budget_ms: f64,
    used_budget_ms: f64,
    num_tests: usize,
    processed: usize,
) -> f64 {
    budget::dynamic_share_ms(available_budget_ms, used_budget_ms, num_tests, processed)
}

fn parse_mode(mode: &str) -> PyResult<Mode> {
    match mode {
        "new" => Ok(Mode::New),
        "unhealthy" => Ok(Mode::Unhealthy),
        other => Err(PyValueError::new_err(format!("unknown mode: {other}"))),
    }
}

fn context_from_dict(dict: &Bound<'_, PyDict>) -> PyResult<FlakyDetectionContext> {
    Ok(FlakyDetectionContext {
        budget_ratio_for_new_tests: req_item(dict, "budget_ratio_for_new_tests")?.extract()?,
        budget_ratio_for_unhealthy_tests: req_item(dict, "budget_ratio_for_unhealthy_tests")?
            .extract()?,
        existing_test_names: req_item(dict, "existing_test_names")?.extract()?,
        existing_tests_mean_duration_ms: req_item(dict, "existing_tests_mean_duration_ms")?
            .extract()?,
        unhealthy_test_names: req_item(dict, "unhealthy_test_names")?.extract()?,
        max_test_execution_count: req_item(dict, "max_test_execution_count")?.extract()?,
        max_test_name_length: req_item(dict, "max_test_name_length")?.extract()?,
        min_budget_duration_ms: req_item(dict, "min_budget_duration_ms")?.extract()?,
        min_test_execution_count: req_item(dict, "min_test_execution_count")?.extract()?,
    })
}

fn span_from_dict(dict: &Bound<'_, PyDict>) -> PyResult<SpanData> {
    let attributes = match opt_item(dict, "attributes")? {
        Some(value) => attributes_from_dict(value.cast::<PyDict>()?)?,
        None => Vec::new(),
    };
    let parent_span_id = match opt_item(dict, "parent_span_id")? {
        Some(value) => Some(byte_array::<8>(&value)?),
        None => None,
    };
    let status = match opt_item(dict, "status")? {
        Some(value) => match value.extract::<String>()?.as_str() {
            "ok" => SpanStatus::Ok,
            "unset" => SpanStatus::Unset,
            "error" => SpanStatus::Error(
                opt_item(dict, "status_message")?
                    .map(|message| message.extract::<String>())
                    .transpose()?
                    .unwrap_or_default(),
            ),
            other => return Err(PyValueError::new_err(format!("unknown span status: {other}"))),
        },
        None => SpanStatus::Unset,
    };
    Ok(SpanData {
        name: req_item(dict, "name")?.extract()?,
        trace_id: byte_array::<16>(&req_item(dict, "trace_id")?)?,
        span_id: byte_array::<8>(&req_item(dict, "span_id")?)?,
        parent_span_id,
        start_unix_nano: req_item(dict, "start_unix_nano")?.extract()?,
        end_unix_nano: req_item(dict, "end_unix_nano")?.extract()?,
        attributes,
        status,
    })
}

fn attributes_from_dict(dict: &Bound<'_, PyDict>) -> PyResult<Vec<(String, AttrValue)>> {
    dict.iter()
        .map(|(key, value)| Ok((key.extract::<String>()?, attr_value(&value)?)))
        .collect()
}

/// Infer an [`AttrValue`] from a Python object. `bool` is checked before `int`
/// because `bool` is an `int` subclass in Python.
fn attr_value(object: &Bound<'_, PyAny>) -> PyResult<AttrValue> {
    if let Ok(value) = object.cast::<PyBool>() {
        return Ok(AttrValue::Bool(value.is_true()));
    }
    if let Ok(value) = object.extract::<i64>() {
        return Ok(AttrValue::Int(value));
    }
    if let Ok(value) = object.extract::<f64>() {
        return Ok(AttrValue::Double(value));
    }
    if let Ok(value) = object.extract::<String>() {
        return Ok(AttrValue::Str(value));
    }
    Err(PyTypeError::new_err("attribute value must be str, int, float, or bool"))
}

fn byte_array<const N: usize>(object: &Bound<'_, PyAny>) -> PyResult<[u8; N]> {
    let bytes: Vec<u8> = object.extract()?;
    bytes
        .try_into()
        .map_err(|bytes: Vec<u8>| PyValueError::new_err(format!("expected {N} bytes, got {}", bytes.len())))
}

fn opt_item<'py>(dict: &Bound<'py, PyDict>, key: &str) -> PyResult<Option<Bound<'py, PyAny>>> {
    Ok(dict.get_item(key)?.filter(|value| !value.is_none()))
}

fn req_item<'py>(dict: &Bound<'py, PyDict>, key: &str) -> PyResult<Bound<'py, PyAny>> {
    opt_item(dict, key)?.ok_or_else(|| PyKeyError::new_err(key.to_owned()))
}

#[pymodule]
fn _mergify_ci(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(detect_provider, m)?)?;
    m.add_function(wrap_pyfunction!(detect_repository_name, m)?)?;
    m.add_function(wrap_pyfunction!(detect_attributes, m)?)?;
    m.add_function(wrap_pyfunction!(compute_budget, m)?)?;
    m.add_function(wrap_pyfunction!(should_run, m)?)?;
    m.add_function(wrap_pyfunction!(static_share_ms, m)?)?;
    m.add_function(wrap_pyfunction!(dynamic_share_ms, m)?)?;
    m.add_class::<CiApiClient>()?;
    Ok(())
}
