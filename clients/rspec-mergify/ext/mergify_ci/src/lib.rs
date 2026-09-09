//! Ruby binding over `mergify-ci-core`, the Ruby counterpart of the `PyO3` and
//! napi bindings.
//!
//! The surface is deliberately the same three functions those expose, with the
//! same semantics: the environment and working directory are read at call time,
//! so Ruby code that mutates `ENV` before calling sees its own changes.
//!
//! Everything lands under `Mergify::RSpec::Native`, a namespace the gem owns —
//! the extension is an implementation detail behind `Utils`, not public API.

use std::collections::BTreeMap;
use std::ffi::c_void;

use magnus::{Error, ExceptionClass, RHash, Ruby, function, method, prelude::*};
use mergify_ci_api::{
    ApiConfig, Client, ClientInfo, FlakyDetectionContext, Mode, Outcome, budget,
};
use mergify_ci_core::{AttrValue, CiContext};

/// The distribution this binding ships inside, as reported in the `User-Agent`.
/// Its version comes from Ruby: the crate version is the build-time 0.0.0
/// placeholder, while the gem carries the real one.
const CLIENT_NAME: &str = "rspec-mergify";

/// Detect from the current process environment and working directory.
fn context() -> CiContext {
    let env: BTreeMap<String, String> = std::env::vars().collect();
    let cwd = std::env::current_dir().unwrap_or_else(|_| ".".into());
    mergify_ci_core::detect(&env, &cwd)
}

/// The detected CI provider as its stable name, or `nil` when not in CI.
fn detect_provider() -> Option<String> {
    context().provider.map(|p| p.as_str().to_owned())
}

/// The API-endpoint `owner/repo`, or `nil` when undeterminable.
fn detect_repository_name() -> Option<String> {
    context().repository_name
}

/// The OTel resource attributes for this run, as a `Hash[String, String | Integer]`.
fn detect_attributes(ruby: &Ruby) -> Result<RHash, Error> {
    let hash = ruby.hash_new();
    for (key, value) in mergify_ci_core::otel_attributes(&context()).into_map() {
        match value {
            AttrValue::Int(i) => hash.aset(key, i)?,
            AttrValue::Str(s) => hash.aset(key, s)?,
        }
    }
    Ok(hash)
}

#[magnus::init]
fn init(ruby: &Ruby) -> Result<(), Error> {
    let mergify = ruby.define_module("Mergify")?;
    let rspec = mergify.define_module("RSpec")?;
    let native = rspec.define_module("Native")?;

    native.define_singleton_method("detect_provider", function!(detect_provider, 0))?;
    native.define_singleton_method(
        "detect_repository_name",
        function!(detect_repository_name, 0),
    )?;
    native.define_singleton_method("detect_attributes", function!(detect_attributes, 0))?;

    let client = native.define_class("Client", ruby.class_object())?;
    client.define_singleton_method("new", function!(ApiClient::new, 5))?;
    client.define_method("fetch_quarantine", method!(ApiClient::fetch_quarantine, 1))?;
    client.define_method("fetch_flaky_context", method!(ApiClient::fetch_flaky_context, 0))?;

    let budget = native.define_module("Budget")?;
    budget.define_singleton_method("should_run", function!(should_run, 2))?;
    budget.define_singleton_method("compute", function!(compute_budget, 4))?;
    budget.define_singleton_method("static_share_ms", function!(static_share_ms, 2))?;
    budget.define_singleton_method("dynamic_share_ms", function!(dynamic_share_ms, 4))?;

    Ok(())
}

/// A blocking Ruby wrapper over the async `mergify_ci_api::Client`.
///
/// The core client is async so mergify-cli can share it; Ruby is sync, so each
/// call drives the future to completion on an owned single-threaded runtime.
/// Fetches return the value, `nil` when the feature is not enabled for the
/// repository, and raise on a genuine failure -- the same three-way split the
/// `PyO3` binding surfaces, because it is `Outcome`'s.
#[magnus::wrap(class = "Mergify::RSpec::Native::Client", free_immediately, size)]
struct ApiClient {
    runtime: tokio::runtime::Runtime,
    client: Client,
}

impl ApiClient {
    // magnus converts Ruby arguments into owned values, so these arrive by
    // value whether or not each one is consumed.
    #[allow(clippy::needless_pass_by_value)]
    fn new(
        ruby: &Ruby,
        api_url: String,
        token: String,
        owner: String,
        repo: String,
        client_version: String,
    ) -> Result<Self, Error> {
        let client_info = ClientInfo::new(CLIENT_NAME, &client_version)
            .with_runtime("ruby", &ruby.eval::<String>("RUBY_VERSION")?);
        let client = Client::new(
            ApiConfig::new(api_url, token, owner, repo),
            &client_info,
        )
        .map_err(|error| api_error(ruby, format!("failed to build HTTP client: {error}")))?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| api_error(ruby, format!("failed to start runtime: {error}")))?;
        Ok(Self { runtime, client })
    }

    /// The quarantined test names, or `nil` when quarantine is not enabled.
    #[allow(clippy::needless_pass_by_value)]
    fn fetch_quarantine(
        ruby: &Ruby,
        rb_self: &Self,
        branch: String,
    ) -> Result<Option<Vec<String>>, Error> {
        match without_gvl(|| rb_self.runtime.block_on(rb_self.client.fetch_quarantine(&branch))) {
            Outcome::Ready(names) => Ok(Some(names)),
            Outcome::Dormant => Ok(None),
            Outcome::Failed(message) => Err(api_error(ruby, message)),
        }
    }

    /// The flaky-detection context as a Hash, or `nil` when it is not enabled.
    fn fetch_flaky_context(ruby: &Ruby, rb_self: &Self) -> Result<Option<RHash>, Error> {
        match without_gvl(|| rb_self.runtime.block_on(rb_self.client.fetch_flaky_context())) {
            Outcome::Ready(context) => flaky_context_hash(ruby, &context).map(Some),
            Outcome::Dormant => Ok(None),
            Outcome::Failed(message) => Err(api_error(ruby, message)),
        }
    }
}

/// Run a blocking call with the GVL released, so Ruby threads keep running.
///
/// Every API call blocks on a network round trip. Holding the GVL across it
/// would stop the whole VM -- including the gem's own span-processor thread,
/// and any thread the suite under test is running -- until the request came
/// back. The `PyO3` binding releases the GIL for the same reason; magnus 0.8 does
/// not wrap `rb_thread_call_without_gvl`, so call it through rb-sys.
///
/// No unblocking function is registered, which means a request in flight is not
/// interruptible by Ruby: the client's own timeout is what bounds it.
fn without_gvl<F, R>(func: F) -> R
where
    F: FnOnce() -> R,
{
    struct Payload<F, R> {
        func: Option<F>,
        result: Option<R>,
    }

    unsafe extern "C" fn call<F, R>(data: *mut c_void) -> *mut c_void
    where
        F: FnOnce() -> R,
    {
        // SAFETY: `data` is the &mut Payload handed to rb_thread_call_without_gvl
        // below, which outlives this call and is not aliased -- Ruby invokes the
        // callback once, on this thread, before returning.
        let payload = unsafe { &mut *data.cast::<Payload<F, R>>() };
        if let Some(func) = payload.func.take() {
            payload.result = Some(func());
        }
        std::ptr::null_mut()
    }

    let mut payload = Payload { func: Some(func), result: None };
    // SAFETY: the callback matches the expected C signature and `payload` lives
    // across the call.
    unsafe {
        rb_sys::rb_thread_call_without_gvl(
            Some(call::<F, R>),
            std::ptr::from_mut(&mut payload).cast::<c_void>(),
            None,
            std::ptr::null_mut(),
        );
    }
    payload
        .result
        .expect("rb_thread_call_without_gvl did not run the callback")
}

/// Raise `Mergify::RSpec::Native::ApiError`, declared in native.rb so it exists
/// whether or not this extension loaded. Falling back to `RuntimeError` keeps a
/// failure reportable if the shim ever stops declaring it.
fn api_error(ruby: &Ruby, message: String) -> Error {
    match ruby.eval::<ExceptionClass>("Mergify::RSpec::Native::ApiError") {
        Ok(class) => Error::new(class, message),
        Err(_) => Error::new(ruby.exception_runtime_error(), message),
    }
}

/// Mirrors the `PyO3` binding's dict, key for key, so the two clients hand their
/// plugins the same context.
fn flaky_context_hash(ruby: &Ruby, context: &FlakyDetectionContext) -> Result<RHash, Error> {
    let hash = ruby.hash_new();
    hash.aset("budget_ratio_for_new_tests", context.budget_ratio_for_new_tests)?;
    hash.aset(
        "budget_ratio_for_unhealthy_tests",
        context.budget_ratio_for_unhealthy_tests,
    )?;
    hash.aset("existing_test_names", context.existing_test_names.clone())?;
    hash.aset(
        "existing_tests_mean_duration_ms",
        context.existing_tests_mean_duration_ms,
    )?;
    hash.aset("unhealthy_test_names", context.unhealthy_test_names.clone())?;
    hash.aset(
        "budget_ratio_for_test_retries",
        context.budget_ratio_for_test_retries,
    )?;
    hash.aset("flaky_test_names", context.flaky_test_names.clone())?;
    hash.aset("broken_test_names", context.broken_test_names.clone())?;
    hash.aset("max_test_execution_count", context.max_test_execution_count)?;
    hash.aset("max_test_name_length", context.max_test_name_length)?;
    hash.aset("min_budget_duration_ms", context.min_budget_duration_ms)?;
    hash.aset("min_test_execution_count", context.min_test_execution_count)?;
    Ok(hash)
}

// ---------------------------------------------------------------------------
// Flaky-detection budget
//
// The arithmetic lives in Rust so every client spends its budget the same way.
// The lifecycle around it stays in Ruby -- the rerun loop, filling metrics from
// each report, the terminal summary -- because that is RSpec-shaped, not shared.
//
// A context crosses as the same Hash `fetch_flaky_context` returns, so a plugin
// can hold onto one, hand it back, and never learn a native type.
// ---------------------------------------------------------------------------

fn parse_mode(ruby: &Ruby, mode: &str) -> Result<Mode, Error> {
    match mode {
        "new" => Ok(Mode::New),
        "unhealthy" => Ok(Mode::Unhealthy),
        other => Err(Error::new(
            ruby.exception_arg_error(),
            format!("unknown mode: {other}"),
        )),
    }
}

fn required<T>(ruby: &Ruby, context: RHash, key: &str) -> Result<T, Error>
where
    T: magnus::TryConvert,
{
    match context.get(key) {
        Some(value) => T::try_convert(value),
        None => Err(Error::new(
            ruby.exception_key_error(),
            format!("flaky detection context is missing {key}"),
        )),
    }
}

/// Optional, matching the wire model's serde defaults: a context built before
/// test retry existed is still a valid one to plan from.
fn optional<T>(context: RHash, key: &str) -> Result<T, Error>
where
    T: magnus::TryConvert + Default,
{
    match context.get(key) {
        Some(value) => T::try_convert(value),
        None => Ok(T::default()),
    }
}

fn context_from_hash(ruby: &Ruby, context: RHash) -> Result<FlakyDetectionContext, Error> {
    Ok(FlakyDetectionContext {
        budget_ratio_for_new_tests: required(ruby, context, "budget_ratio_for_new_tests")?,
        budget_ratio_for_unhealthy_tests: required(
            ruby,
            context,
            "budget_ratio_for_unhealthy_tests",
        )?,
        existing_test_names: required(ruby, context, "existing_test_names")?,
        existing_tests_mean_duration_ms: required(ruby, context, "existing_tests_mean_duration_ms")?,
        unhealthy_test_names: required(ruby, context, "unhealthy_test_names")?,
        budget_ratio_for_test_retries: optional(context, "budget_ratio_for_test_retries")?,
        flaky_test_names: optional(context, "flaky_test_names")?,
        broken_test_names: optional(context, "broken_test_names")?,
        max_test_execution_count: required(ruby, context, "max_test_execution_count")?,
        max_test_name_length: required(ruby, context, "max_test_name_length")?,
        min_budget_duration_ms: required(ruby, context, "min_budget_duration_ms")?,
        min_test_execution_count: required(ruby, context, "min_test_execution_count")?,
    })
}

/// Whether flaky detection has anything to do this session.
#[allow(clippy::needless_pass_by_value)]
fn should_run(ruby: &Ruby, context: RHash, mode: String) -> Result<bool, Error> {
    Ok(budget::should_run(
        &context_from_hash(ruby, context)?,
        parse_mode(ruby, &mode)?,
    ))
}

/// The session's budget and the tests it covers, as
/// `{ "available_budget_ms" => Float, "tests_to_process" => [String] }`.
#[allow(clippy::needless_pass_by_value)]
fn compute_budget(
    ruby: &Ruby,
    context: RHash,
    mode: String,
    session_tests: Vec<String>,
    excluded: Vec<String>,
) -> Result<RHash, Error> {
    let plan = budget::plan(
        &context_from_hash(ruby, context)?,
        parse_mode(ruby, &mode)?,
        &session_tests,
        &excluded,
    );
    let result = ruby.hash_new();
    result.aset("available_budget_ms", plan.available_budget_ms)?;
    result.aset("tests_to_process", plan.tests_to_process)?;
    Ok(result)
}

/// The per-test slice when the budget is split evenly up front.
fn static_share_ms(available_budget_ms: f64, num_tests: usize) -> f64 {
    budget::static_share_ms(available_budget_ms, num_tests)
}

/// The per-test slice recomputed from what is left, as the session progresses.
fn dynamic_share_ms(
    available_budget_ms: f64,
    used_budget_ms: f64,
    num_tests: usize,
    processed: usize,
) -> f64 {
    budget::dynamic_share_ms(available_budget_ms, used_budget_ms, num_tests, processed)
}
