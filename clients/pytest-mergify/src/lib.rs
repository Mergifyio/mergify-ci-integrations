//! Rust binding embedded in the `pytest-mergify` wheel (walking skeleton).
//!
//! Built as a `cdylib` by maturin and packaged *inside* the pytest-mergify
//! wheel as `pytest_mergify._mergify_ci` — there is no separately published
//! binding artifact (the bundled model). When the real pytest plugin migrates
//! in (MRGFY-7766) it replaces the stub Python package next to this file; the
//! binding wiring stays identical.

use std::collections::BTreeMap;

use pyo3::prelude::*;
use pyo3::types::PyDict;

use mergify_ci_core::{AttrValue, CiContext};

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
            AttrValue::Int(i) => dict.set_item(key, i)?,
            AttrValue::Str(s) => dict.set_item(key, s)?,
        }
    }
    Ok(dict.into())
}

#[pymodule]
fn _mergify_ci(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(detect_provider, m)?)?;
    m.add_function(wrap_pyfunction!(detect_repository_name, m)?)?;
    m.add_function(wrap_pyfunction!(detect_attributes, m)?)?;
    Ok(())
}
