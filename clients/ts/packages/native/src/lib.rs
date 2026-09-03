//! Node binding over `mergify-ci-core` and `mergify-ci-api`, packaged as
//! `@mergifyio/ci-native`.
//!
//! One `.node` per platform, published as `@mergifyio/ci-native-<target>`
//! optional dependencies of the loader package. `@mergifyio/ci-core` loads it
//! fail-open: when no prebuilt exists for the platform, detection reports
//! nothing and the backend features stay off rather than breaking the test run.
//!
//! The API mirrors the `PyO3` binding: three detection calls, each running a
//! fresh detection (environment and cwd are read at call time), plus
//! [`CiApiClient`] over the shared async backend client. Detection returns
//! native JS values built entry-by-entry; the client's returns are typed
//! `#[napi(object)]` structs, so the generated `.d.ts` — not a hand-written TS
//! interface — is the contract.

use std::collections::{BTreeMap, HashMap};

use mergify_ci_api::{
    ApiConfig, AttrValue as ApiAttrValue, Client, ClientInfo, Outcome, SpanData, SpanStatus,
    TestSelection as ApiTestSelection,
};
use mergify_ci_core::{AttrValue, CiContext};
use napi::bindgen_prelude::{BigInt, Either, Either3};
use napi::{Error, Result, Status};
use napi_derive::napi;

/// Detect from the current process environment and working directory.
fn context() -> CiContext {
    let env: BTreeMap<String, String> = std::env::vars().collect();
    let cwd = std::env::current_dir().unwrap_or_else(|_| ".".into());
    mergify_ci_core::detect(&env, &cwd)
}

/// The detected CI provider, or `null` when not running in a recognized CI.
/// The first provider whose detection variable (`GITHUB_ACTIONS`, `CIRCLECI`,
/// `JENKINS_URL`, `BUILDKITE`) is present *and* truthy wins — a
/// present-but-falsy value like `GITHUB_ACTIONS=false` is skipped, not a
/// match. Returns the stable name emitted as `cicd.provider.name`:
/// `github_actions`, `circleci`, `jenkins`, or `buildkite`. Reads the
/// environment at call time.
#[napi]
#[must_use]
pub fn detect_provider() -> Option<String> {
    context().provider.map(|p| p.as_str().to_owned())
}

/// The API-endpoint `owner/repo` used for CI Insights calls, or `null` when
/// undeterminable. Resolved from the active provider's environment first —
/// `GITHUB_REPOSITORY` on GitHub Actions, parsed from `CIRCLE_REPOSITORY_URL`
/// on CircleCI, `GIT_URL` on Jenkins, `BUILDKITE_REPO` on Buildkite — falling
/// back to parsing the working directory's `origin` git remote when no
/// provider is active. Can legitimately differ from the
/// `vcs.repository.name` *attribute* (e.g. on CircleCI the endpoint comes
/// from the env URL while the attribute may come from the git remote).
#[napi]
#[must_use]
pub fn detect_repository_name() -> Option<String> {
    context().repository_name
}

/// The OTel resource attributes for this run, as a dotted-key map (`cicd.*`,
/// `vcs.*`, `mergify.test.job.name`) with string or number values — integer
/// attributes like `cicd.pipeline.run.id` (GitHub) and
/// `cicd.pipeline.run.attempt` arrive as JS numbers. Provider-scoped
/// attributes are suppressed outside CI; `mergify.test.job.name` is always-on
/// when `MERGIFY_TEST_JOB_NAME` is set. When in CI, the provider's
/// environment is read first and the git CLI fills whatever it didn't supply
/// (head branch/revision, remote URL). Same shape as Rust's
/// `CiResourceAttributes` and Python's `detect_attributes()` dict; the
/// semconv keys flow through untouched, so `otel.rs` stays their single
/// source of truth.
#[napi]
#[must_use]
pub fn detect_attributes() -> HashMap<String, Either<i64, String>> {
    mergify_ci_core::otel_attributes(&context())
        .into_map()
        .into_iter()
        .map(|(key, value)| {
            let value = match value {
                AttrValue::Int(i) => Either::A(i),
                AttrValue::Str(s) => Either::B(s),
            };
            (key, value)
        })
        .collect()
}

/// How to reach one repository's Mergify backend API, and who is calling.
///
/// The calling *distribution* is named by the plugin rather than fixed here:
/// unlike the pytest wheel, this binding is shared by `@mergifyio/vitest` and
/// `@mergifyio/playwright`, and the backend counts them separately.
#[napi(object)]
pub struct ApiClientOptions {
    /// API base URL (`MERGIFY_API_URL`, default `https://api.mergify.com`).
    pub api_url: String,
    /// Bearer token (`MERGIFY_TOKEN`).
    pub token: String,
    /// The repository as `owner/repo`.
    pub repo_name: String,
    /// The npm package calling, e.g. `@mergifyio/vitest`.
    pub client_name: String,
    /// That package's version.
    pub client_version: String,
    /// `process.versions.node`, reported as the runtime in the `User-Agent`.
    pub node_version: String,
}

/// The flaky-detection context: the server's baseline and budget parameters.
///
/// The field names stay `snake_case` (`js_name`) because this object *is*
/// `@mergifyio/ci-core`'s public `FlakyDetectionContext` — it is accepted as a
/// reporter option and persisted in the Playwright state file. It is also the
/// wire contract shared with pytest-mergify, so the keys match the API's.
#[napi(object)]
pub struct FlakyDetectionContext {
    #[napi(js_name = "budget_ratio_for_new_tests")]
    pub budget_ratio_for_new_tests: f64,
    #[napi(js_name = "budget_ratio_for_unhealthy_tests")]
    pub budget_ratio_for_unhealthy_tests: f64,
    #[napi(js_name = "existing_test_names")]
    pub existing_test_names: Vec<String>,
    #[napi(js_name = "existing_tests_mean_duration_ms")]
    pub existing_tests_mean_duration_ms: i64,
    #[napi(js_name = "unhealthy_test_names")]
    pub unhealthy_test_names: Vec<String>,
    #[napi(js_name = "max_test_execution_count")]
    pub max_test_execution_count: i64,
    #[napi(js_name = "max_test_name_length")]
    pub max_test_name_length: i64,
    #[napi(js_name = "min_budget_duration_ms")]
    pub min_budget_duration_ms: i64,
    #[napi(js_name = "min_test_execution_count")]
    pub min_test_execution_count: i64,
}

impl From<mergify_ci_api::FlakyDetectionContext> for FlakyDetectionContext {
    fn from(context: mergify_ci_api::FlakyDetectionContext) -> Self {
        Self {
            budget_ratio_for_new_tests: context.budget_ratio_for_new_tests,
            budget_ratio_for_unhealthy_tests: context.budget_ratio_for_unhealthy_tests,
            existing_test_names: context.existing_test_names,
            existing_tests_mean_duration_ms: context.existing_tests_mean_duration_ms,
            unhealthy_test_names: context.unhealthy_test_names,
            max_test_execution_count: context.max_test_execution_count,
            max_test_name_length: context.max_test_name_length,
            min_budget_duration_ms: context.min_budget_duration_ms,
            min_test_execution_count: context.min_test_execution_count,
        }
    }
}

/// Whether this run should execute only a subset of tests.
///
/// Left as the server sent it, deliberately: only the caller holds the tests
/// the framework actually collected, and normalising `subset` down to `full`
/// (an empty list, a list matching nothing) is a decision that needs them. The
/// binding's job is to deliver the answer, not to interpret it.
#[napi(object)]
pub struct TestSelection {
    /// `"full"` (run everything) or `"subset"` (run only `tests`).
    pub selection: String,
    /// Why the server chose this selection — surfaced in the plugin report.
    pub reason: String,
    /// The test identifiers to run; absent on a `full` answer.
    pub tests: Option<Vec<String>>,
}

// A plain comment, not a doc one: `napi` copies `///` into the generated
// `index.d.ts`, and this says nothing a caller of that interface needs.
//
// `ApiTestSelection` also carries `message` -- the server's own explanation of
// a `refused` answer -- and it is deliberately NOT mirrored here. These clients
// collapse anything that is not a `subset` to a full run and never show the
// user a reason, so the field would be dead weight on the interface. Whoever
// wires the refusal path here (test selection is off for vitest and playwright
// during the pilot, MRGFY-8906) should carry it over rather than write the
// wording client-side: the copy is the server's so it can be corrected without
// publishing a client.
impl From<ApiTestSelection> for TestSelection {
    fn from(selection: ApiTestSelection) -> Self {
        Self {
            selection: selection.selection,
            reason: selection.reason,
            tests: selection.tests,
        }
    }
}

/// One `OpenTelemetry` attribute, as a key and a JS `boolean | number | string`.
#[napi(object)]
pub struct Attribute {
    pub key: String,
    pub value: Either3<bool, f64, String>,
}

/// One finished span, handed over as plain data — no live `OpenTelemetry`
/// objects cross the boundary. Ids are the lowercase hex strings the JS SDK
/// already exposes on a span context; timestamps are `bigint` because
/// nanoseconds since the epoch exceed what a JS `number` holds exactly.
#[napi(object)]
pub struct Span {
    pub name: String,
    /// 32 hex characters.
    pub trace_id: String,
    /// 16 hex characters.
    pub span_id: String,
    /// 16 hex characters, or `null` for a root span.
    pub parent_span_id: Option<String>,
    pub start_unix_nano: BigInt,
    pub end_unix_nano: BigInt,
    pub attributes: Vec<Attribute>,
    /// `"unset"`, `"ok"`, or `"error"`.
    pub status: String,
    /// The error description; only read when `status` is `"error"`.
    pub status_message: Option<String>,
}

/// The Mergify backend API for one repository, over the shared async client.
///
/// Every method returns a Promise (napi drives the future on its own tokio
/// runtime). The fetches are tri-state, flattened to JS the same way the `PyO3`
/// binding flattens them to Python: the value when the feature is enabled,
/// `null` when the server says it is not (a dormant `402`/`404`), and a
/// rejection on a genuine failure. Trace upload fails loud.
#[napi]
pub struct CiApiClient {
    client: Client,
}

#[napi]
impl CiApiClient {
    /// Build a client for one repository. Throws when `repoName` is not an
    /// `owner/repo` pair, or when the HTTP client cannot be built.
    // napi extracts the options object by value; we only borrow it to build the
    // config.
    #[allow(clippy::needless_pass_by_value)]
    #[napi(constructor)]
    pub fn new(options: ApiClientOptions) -> Result<Self> {
        let config = ApiConfig::from_full_name(
            &options.api_url,
            &options.token,
            &options.repo_name,
        )
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("invalid repository name: {}", options.repo_name),
            )
        })?;
        let info = ClientInfo::new(&options.client_name, &options.client_version)
            .with_runtime("node", &options.node_version);
        let client = Client::new(config, &info).map_err(|error| {
            Error::new(Status::GenericFailure, format!("failed to build HTTP client: {error}"))
        })?;
        Ok(Self { client })
    }

    /// The quarantined test names for `branch`, or `null` when quarantine is
    /// not enabled for the repository.
    #[napi]
    pub async fn fetch_quarantine(&self, branch: String) -> Result<Option<Vec<String>>> {
        match self.client.fetch_quarantine(&branch).await {
            Outcome::Ready(names) => Ok(Some(names)),
            Outcome::Dormant => Ok(None),
            Outcome::Failed(message) => Err(Error::from_reason(message)),
        }
    }

    /// The flaky-detection context, or `null` when it is not enabled for the
    /// repository.
    #[napi]
    pub async fn fetch_flaky_context(&self) -> Result<Option<FlakyDetectionContext>> {
        match self.client.fetch_flaky_context().await {
            Outcome::Ready(context) => Ok(Some(context.into())),
            Outcome::Dormant => Ok(None),
            Outcome::Failed(message) => Err(Error::from_reason(message)),
        }
    }

    /// The test selection for a run, identified by its own `branch`,
    /// `headSha` and job coordinates, or `null` when test selection is not
    /// enabled for the repository.
    #[napi]
    pub async fn fetch_test_selection(
        &self,
        branch: String,
        head_sha: String,
        pipeline_name: String,
        job_name: String,
    ) -> Result<Option<TestSelection>> {
        match self
            .client
            // No fingerprint from here. Vitest collects inside its workers in
            // batches (`onCollected` sees one worker's files, never the run's
            // whole collection) and Playwright's `preprocess` hook runs before
            // `onBegin`, where the full suite becomes available -- so neither
            // runner holds its own collection at the moment it asks. Sending
            // none is what makes the server answer for a run it cannot
            // identify; sending an empty value would claim a collection.
            // Resolving that ordering is open work, not tracked work.
            .fetch_test_selection(&branch, &head_sha, &pipeline_name, &job_name, None)
            .await
        {
            Outcome::Ready(selection) => Ok(Some(selection.into())),
            Outcome::Dormant => Ok(None),
            Outcome::Failed(message) => Err(Error::from_reason(message)),
        }
    }

    /// Upload `spans` under `resourceAttributes` as gzipped OTLP protobuf,
    /// splitting oversized traces across several uploads. Rejects on failure.
    #[napi]
    pub async fn upload_trace(
        &self,
        resource_attributes: Vec<Attribute>,
        spans: Vec<Span>,
    ) -> Result<()> {
        let resource = attributes(resource_attributes);
        let spans = spans.into_iter().map(span_data).collect::<Result<Vec<_>>>()?;
        self.client
            .upload_trace(&resource, &spans)
            .await
            .map_err(|error| Error::from_reason(error.to_string()))
    }
}

fn attributes(list: Vec<Attribute>) -> Vec<(String, ApiAttrValue)> {
    list.into_iter().map(|entry| (entry.key, attr_value(entry.value))) .collect()
}

/// JS has one numeric type, so an integral `number` becomes an OTLP `intValue`
/// and a fractional one a `doubleValue` — the same split
/// `@opentelemetry/otlp-transformer` made, keeping the wire bytes identical to
/// what the OTLP exporter this replaced produced. The bound is the largest
/// integer a double represents exactly, so the cast never truncates.
#[allow(clippy::cast_possible_truncation)]
fn attr_value(value: Either3<bool, f64, String>) -> ApiAttrValue {
    const MAX_EXACT_INTEGER: f64 = 9_007_199_254_740_992.0;
    match value {
        Either3::A(flag) => ApiAttrValue::Bool(flag),
        Either3::B(number)
            if number.fract() == 0.0 && number.abs() <= MAX_EXACT_INTEGER =>
        {
            ApiAttrValue::Int(number as i64)
        }
        Either3::B(number) => ApiAttrValue::Double(number),
        Either3::C(text) => ApiAttrValue::Str(text),
    }
}

fn span_data(span: Span) -> Result<SpanData> {
    let status = match span.status.as_str() {
        "ok" => SpanStatus::Ok,
        "unset" => SpanStatus::Unset,
        "error" => SpanStatus::Error(span.status_message.unwrap_or_default()),
        other => {
            return Err(Error::new(
                Status::InvalidArg,
                format!("unknown span status: {other}"),
            ));
        }
    };
    Ok(SpanData {
        name: span.name,
        trace_id: hex_id::<16>(&span.trace_id)?,
        span_id: hex_id::<8>(&span.span_id)?,
        parent_span_id: span.parent_span_id.as_deref().map(hex_id::<8>).transpose()?,
        start_unix_nano: unix_nano(&span.start_unix_nano)?,
        end_unix_nano: unix_nano(&span.end_unix_nano)?,
        attributes: attributes(span.attributes),
        status,
    })
}

/// Decode an `N`-byte trace or span id from its hex string.
fn hex_id<const N: usize>(hex: &str) -> Result<[u8; N]> {
    let raw = hex.as_bytes();
    if raw.len() != N * 2 {
        return Err(Error::new(
            Status::InvalidArg,
            format!("expected {} hex characters, got {:?}", N * 2, hex),
        ));
    }
    let mut bytes = [0u8; N];
    // `as_chunks` rather than `chunks_exact`: the pair is then a `&[u8; 2]`
    // instead of a `&[u8]`, so the length is carried by the type. The length
    // was already guaranteed by the check above; clippy names this one and
    // `-D warnings` turns it into a build failure.
    let (pairs, _) = raw.as_chunks::<2>();
    for (byte, pair) in bytes.iter_mut().zip(pairs) {
        *byte = std::str::from_utf8(pair)
            .ok()
            .and_then(|pair| u8::from_str_radix(pair, 16).ok())
            .ok_or_else(|| {
                Error::new(Status::InvalidArg, format!("id is not hex: {hex:?}"))
            })?;
    }
    Ok(bytes)
}

/// A JS `bigint` timestamp as `u64`. Read from the words directly because
/// napi's own `get_u64` indexes `words[0]` unconditionally, which panics on
/// `0n` — zero carries no words.
fn unix_nano(value: &BigInt) -> Result<u64> {
    if value.sign_bit || value.words.len() > 1 {
        return Err(Error::new(
            Status::InvalidArg,
            "span timestamp must be a non-negative bigint below 2^64".to_owned(),
        ));
    }
    Ok(value.words.first().copied().unwrap_or(0))
}
