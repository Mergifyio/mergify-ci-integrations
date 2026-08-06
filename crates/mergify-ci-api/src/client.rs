//! Async client for the Mergify backend API.

use std::collections::HashSet;
use std::time::Duration;

use reqwest::StatusCode;
use reqwest::header::LINK;

use crate::config::{ApiConfig, ClientInfo};
use crate::models::{FlakyDetectionContext, QuarantinePage, TestSelection};
use crate::outcome::Outcome;
use crate::trace::{self, AttrValue, MAX_GZIPPED_UPLOAD_BYTES, SpanData, UploadError};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(30);

/// Trace-upload retry schedule: one initial attempt plus `max_attempts - 1`
/// retries, each backing off `base_delay` doubled per retry. The default
/// approximates the OTLP exporter pytest-mergify used — six attempts with
/// 1s/2s/4s/8s/16s backoff (~31s total) — so a briefly-degraded backend is
/// ridden out rather than failing the run fast. Tests shrink `base_delay`.
#[derive(Clone, Copy)]
struct RetryPolicy {
    max_attempts: u32,
    base_delay: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self { max_attempts: 6, base_delay: Duration::from_secs(1) }
    }
}

/// Async client for a single repository's Mergify backend API.
///
/// Fetches are *fail-open*: a `404` (feature not enabled), and for quarantine
/// and test-selection a `402` (no subscription), resolve to
/// [`Outcome::Dormant`]; any other failure to [`Outcome::Failed`] with a
/// message. (The flaky-detection context surfaces a `402` instead, matching
/// pytest-mergify's flaky detector, which raised on everything but a `404`.) A
/// fetch never panics or returns an `Err` to the caller — degradation is the
/// contract.
pub struct Client {
    config: ApiConfig,
    http: reqwest::Client,
    retry: RetryPolicy,
}

impl Client {
    /// Build a client for `config`, announcing itself as `client_info`.
    pub fn new(config: ApiConfig, client_info: &ClientInfo) -> reqwest::Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            // Every request — fetches and trace uploads alike — carries it, so
            // the backend can count who runs which version of which client.
            .user_agent(client_info.to_string())
            .build()?;
        Ok(Self { config, http, retry: RetryPolicy::default() })
    }

    fn endpoint(&self, suffix: &str) -> String {
        format!(
            "{}/v1/ci/{}/repositories/{}/{}",
            self.config.api_url, self.config.owner, self.config.repo, suffix
        )
    }

    /// Fetch the quarantined test names for `branch`, following `Link`
    /// pagination. `402` → dormant; any other non-success — including a
    /// pagination cycle (a `next` link back to a fetched page) — → failed.
    pub async fn fetch_quarantine(&self, branch: &str) -> Outcome<Vec<String>> {
        let mut names = Vec::new();
        let mut seen = HashSet::new();
        let mut next: Option<String> = None;

        loop {
            let request = match &next {
                None => self
                    .http
                    .get(self.endpoint("quarantines"))
                    .query(&[("branch", branch), ("per_page", "100")]),
                Some(url) => {
                    if !seen.insert(url.clone()) {
                        // A `next` link back to a page already fetched is a
                        // pagination cycle: surface it (pytest-mergify did)
                        // rather than returning a partial list.
                        return Outcome::Failed(
                            "Mergify API quarantine pagination cycled back to a fetched page"
                                .to_owned(),
                        );
                    }
                    self.http.get(url)
                }
            };

            let response = match request.bearer_auth(&self.config.token).send().await {
                Ok(response) => response,
                Err(error) => return Outcome::Failed(describe_error(&error)),
            };

            let status = response.status();
            if status == StatusCode::PAYMENT_REQUIRED {
                return Outcome::Dormant;
            }
            if !status.is_success() {
                return Outcome::Failed(http_status_message(status));
            }

            let next_link = response
                .headers()
                .get(LINK)
                .and_then(|value| value.to_str().ok())
                .and_then(parse_next_link);

            let page: QuarantinePage = match response.json().await {
                Ok(page) => page,
                Err(error) => return Outcome::Failed(describe_error(&error)),
            };
            names.extend(page.quarantined_tests.into_iter().map(|test| test.test_name));

            match next_link {
                Some(url) => next = Some(url),
                None => break,
            }
        }

        Outcome::Ready(names)
    }

    /// Fetch the flaky-detection context. Only `404` (feature not enabled) →
    /// dormant; a `402` and any other non-success → failed, matching
    /// pytest-mergify's flaky detector (which raised on all but a `404`).
    pub async fn fetch_flaky_context(&self) -> Outcome<FlakyDetectionContext> {
        let response = match self
            .http
            .get(self.endpoint("flaky-detection-context"))
            .bearer_auth(&self.config.token)
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => return Outcome::Failed(describe_error(&error)),
        };

        let status = response.status();
        // Only 404 (feature not enabled) is dormant here; unlike quarantine and
        // test-selection, a 402 surfaces as a failure so the plugin reports that
        // flaky detection could not be enabled (pytest-mergify parity).
        if status == StatusCode::NOT_FOUND {
            return Outcome::Dormant;
        }
        if !status.is_success() {
            return Outcome::Failed(http_status_message(status));
        }

        match response.json().await {
            Ok(context) => Outcome::Ready(context),
            Err(error) => Outcome::Failed(describe_error(&error)),
        }
    }

    /// Fetch the test selection for a run, identified by its own `branch`,
    /// `head_sha`, and job coordinates. `402`/`404` → dormant (run everything);
    /// any other non-success → failed, as is a `subset` answer missing its
    /// `tests` list (a protocol break). The `full`/`subset` normalisation is
    /// left to the caller, which alone can match a subset against the collection.
    pub async fn fetch_test_selection(
        &self,
        branch: &str,
        head_sha: &str,
        pipeline_name: &str,
        job_name: &str,
    ) -> Outcome<TestSelection> {
        let response = match self
            .http
            .get(self.endpoint("test-selection"))
            .query(&[
                ("branch", branch),
                ("head_sha", head_sha),
                ("pipeline_name", pipeline_name),
                ("job_name", job_name),
            ])
            .bearer_auth(&self.config.token)
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => return Outcome::Failed(describe_error(&error)),
        };

        let status = response.status();
        if status == StatusCode::NOT_FOUND || status == StatusCode::PAYMENT_REQUIRED {
            return Outcome::Dormant;
        }
        if !status.is_success() {
            return Outcome::Failed(http_status_message(status));
        }

        let selection: TestSelection = match response.json().await {
            Ok(selection) => selection,
            Err(error) => return Outcome::Failed(describe_error(&error)),
        };
        // A `subset` answer must carry a `tests` list. A *missing* one is a
        // protocol break, surfaced (pytest-mergify raised a KeyError here)
        // rather than silently running the full suite; a *present* empty list is
        // a legitimate "subset matched nothing", left for the caller to
        // normalise.
        if selection.selection == "subset" && selection.tests.is_none() {
            return Outcome::Failed(
                "Mergify API returned a `subset` test-selection with no `tests` list".to_owned(),
            );
        }
        Outcome::Ready(selection)
    }

    /// Encode `spans` (under `resource_attributes`) and upload them to the
    /// traces endpoint as gzipped OTLP/protobuf, splitting oversized traces
    /// into several uploads under [`MAX_GZIPPED_UPLOAD_BYTES`].
    ///
    /// Unlike the fetches, trace export fails *loud*: an `Err` is returned, not
    /// swallowed. An empty span list is a no-op (no request).
    pub async fn upload_trace(
        &self,
        resource_attributes: &[(String, AttrValue)],
        spans: &[SpanData],
    ) -> Result<(), UploadError> {
        self.upload_with_cap(resource_attributes, spans, MAX_GZIPPED_UPLOAD_BYTES)
            .await
    }

    async fn upload_with_cap(
        &self,
        resource_attributes: &[(String, AttrValue)],
        spans: &[SpanData],
        cap: usize,
    ) -> Result<(), UploadError> {
        if spans.is_empty() {
            return Ok(());
        }
        let url = self.endpoint("traces");
        // Recursively halve any batch whose gzipped body exceeds the cap; a
        // single span that still exceeds it is sent anyway (nothing to split).
        let mut pending: Vec<&[SpanData]> = vec![spans];
        while let Some(batch) = pending.pop() {
            let compressed =
                trace::compress_batch(resource_attributes, batch).map_err(|error| UploadError {
                    status: None,
                    message: format!("failed to gzip OTLP payload: {error}"),
                })?;
            if compressed.len() <= cap || batch.len() <= 1 {
                self.post_trace(&url, compressed).await?;
            } else {
                let mid = batch.len() / 2;
                pending.push(&batch[..mid]);
                pending.push(&batch[mid..]);
            }
        }
        Ok(())
    }

    async fn post_trace(&self, url: &str, compressed: Vec<u8>) -> Result<(), UploadError> {
        // Retry transient failures (connection blips, request timeout, any 5xx)
        // with exponential backoff before failing loud, restoring the behavior
        // of the OTLP exporter this replaced. A permanent status (4xx other than
        // 408) surfaces immediately.
        let mut attempt: u32 = 1;
        loop {
            let last_attempt = attempt >= self.retry.max_attempts;
            match self
                .http
                .post(url)
                .timeout(UPLOAD_TIMEOUT)
                .bearer_auth(&self.config.token)
                .header("Content-Type", "application/x-protobuf")
                .header("Content-Encoding", "gzip")
                .body(compressed.clone())
                .send()
                .await
            {
                Ok(response) if response.status().is_success() => return Ok(()),
                Ok(response) if is_retryable_status(response.status()) && !last_attempt => {}
                Ok(response) => {
                    let status = response.status().as_u16();
                    let body = response.text().await.unwrap_or_else(|error| {
                        format!("<could not read response body: {error}>")
                    });
                    return Err(UploadError { status: Some(status), message: body });
                }
                Err(_error) if !last_attempt => {}
                Err(error) => return Err(UploadError { status: None, message: error.to_string() }),
            }
            tokio::time::sleep(self.retry.base_delay * 2u32.pow(attempt - 1)).await;
            attempt += 1;
        }
    }
}

/// Whether an HTTP status is worth retrying: request timeout or any 5xx — the
/// statuses the previous OTLP exporter treated as transient. Other 4xx are
/// permanent and surface immediately.
fn is_retryable_status(status: StatusCode) -> bool {
    status == StatusCode::REQUEST_TIMEOUT || status.is_server_error()
}

/// Parse an RFC 8288 `Link` header, returning the `rel="next"` URL if present.
fn parse_next_link(header: &str) -> Option<String> {
    for entry in header.split(',') {
        let mut parts = entry.split(';');
        let url = parts.next()?.trim();
        let url = url.strip_prefix('<')?.strip_suffix('>')?;
        for param in parts {
            if let Some(rel) = param.trim().strip_prefix("rel=")
                && rel.trim_matches('"') == "next"
            {
                return Some(url.to_owned());
            }
        }
    }
    None
}

fn http_status_message(status: StatusCode) -> String {
    format!("Mergify API returned HTTP {}", status.as_u16())
}

fn describe_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "Mergify API request timed out".to_owned()
    } else {
        format!("Mergify API request failed: {error}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trace::SpanStatus;
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn config(uri: &str) -> ApiConfig {
        ApiConfig::new(uri, "tok", "o", "r")
    }

    fn build_client(uri: &str) -> Client {
        Client::new(config(uri), &ClientInfo::new("test-client", "1.2.3")).unwrap()
    }

    fn span(id: u8) -> SpanData {
        SpanData {
            name: format!("test_{id}"),
            trace_id: [1; 16],
            span_id: [id; 8],
            parent_span_id: None,
            start_unix_nano: 0,
            end_unix_nano: 1,
            attributes: Vec::new(),
            status: SpanStatus::Ok,
        }
    }

    fn flaky_body() -> serde_json::Value {
        serde_json::json!({
            "budget_ratio_for_new_tests": 0.1,
            "budget_ratio_for_unhealthy_tests": 0.2,
            "existing_test_names": ["a"],
            "existing_tests_mean_duration_ms": 100,
            "unhealthy_test_names": [],
            "max_test_execution_count": 10,
            "max_test_name_length": 256,
            "min_budget_duration_ms": 5000,
            "min_test_execution_count": 3
        })
    }

    #[tokio::test]
    async fn requests_carry_the_client_user_agent() {
        let server = MockServer::start().await;
        let info =
            ClientInfo::new("pytest-mergify", "2026.8.5.3").with_runtime("python", "3.12.1");
        // The mock only answers a request bearing the expected User-Agent, so a
        // client built without one falls through to wiremock's 404 (dormant).
        Mock::given(method("GET"))
            .and(path("/v1/ci/o/repositories/r/flaky-detection-context"))
            .and(header("user-agent", info.to_string().as_str()))
            .respond_with(ResponseTemplate::new(200).set_body_json(flaky_body()))
            .mount(&server)
            .await;
        let client = Client::new(config(&server.uri()), &info).unwrap();
        assert!(client.fetch_flaky_context().await.into_ready().is_some());
    }

    #[tokio::test]
    async fn flaky_context_ready() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/ci/o/repositories/r/flaky-detection-context"))
            .respond_with(ResponseTemplate::new(200).set_body_json(flaky_body()))
            .mount(&server)
            .await;
        let client = build_client(&server.uri());
        let ctx = client.fetch_flaky_context().await.into_ready().expect("ready");
        assert_eq!(ctx.existing_test_names, ["a"]);
        assert_eq!(ctx.max_test_execution_count, 10);
    }

    #[tokio::test]
    async fn flaky_context_dormant_on_404() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/ci/o/repositories/r/flaky-detection-context"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        let client = build_client(&server.uri());
        assert!(client.fetch_flaky_context().await.is_dormant());
    }

    #[tokio::test]
    async fn flaky_context_surfaces_402() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/ci/o/repositories/r/flaky-detection-context"))
            .respond_with(ResponseTemplate::new(402))
            .mount(&server)
            .await;
        let client = build_client(&server.uri());
        // Unlike quarantine/test-selection, a 402 is surfaced here, not dormant.
        let outcome = client.fetch_flaky_context().await;
        assert_eq!(outcome.failure(), Some("Mergify API returned HTTP 402"));
    }

    #[tokio::test]
    async fn flaky_context_failed_on_500() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/ci/o/repositories/r/flaky-detection-context"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        let client = build_client(&server.uri());
        let outcome = client.fetch_flaky_context().await;
        assert_eq!(outcome.failure(), Some("Mergify API returned HTTP 500"));
    }

    #[tokio::test]
    async fn quarantine_paginates_and_aggregates() {
        let server = MockServer::start().await;
        let next = format!("{}/v1/ci/o/repositories/r/quarantines?cursor=next1", server.uri());
        Mock::given(method("GET"))
            .and(path("/v1/ci/o/repositories/r/quarantines"))
            .and(query_param("per_page", "100"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("link", format!("<{next}>; rel=\"next\"").as_str())
                    .set_body_json(serde_json::json!({"quarantined_tests": [{"test_name": "a"}]})),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/ci/o/repositories/r/quarantines"))
            .and(query_param("cursor", "next1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                serde_json::json!({"quarantined_tests": [{"test_name": "b"}]}),
            ))
            .mount(&server)
            .await;
        let client = build_client(&server.uri());
        let names = client.fetch_quarantine("main").await.into_ready().expect("ready");
        assert_eq!(names, ["a", "b"]);
    }

    #[tokio::test]
    async fn quarantine_dormant_on_402() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/ci/o/repositories/r/quarantines"))
            .respond_with(ResponseTemplate::new(402))
            .mount(&server)
            .await;
        let client = build_client(&server.uri());
        assert!(client.fetch_quarantine("main").await.is_dormant());
    }

    #[test]
    fn parses_next_link() {
        let value = r#"<https://api/x?cursor=2>; rel="next", <https://api/x?cursor=0>; rel="prev""#;
        assert_eq!(parse_next_link(value).as_deref(), Some("https://api/x?cursor=2"));
        assert_eq!(parse_next_link(r#"<https://api/x>; rel="prev""#), None);
        assert_eq!(
            parse_next_link("<https://api/x>; rel=next").as_deref(),
            Some("https://api/x"),
        );
    }

    #[tokio::test]
    async fn test_selection_subset_ready() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/ci/o/repositories/r/test-selection"))
            .and(query_param("branch", "queue/main"))
            .and(query_param("head_sha", "cafe"))
            .and(query_param("pipeline_name", "CI"))
            .and(query_param("job_name", "unit"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "selection": "subset",
                "reason": "queue_rerun",
                "tests": ["t::a", "t::b"],
            })))
            .mount(&server)
            .await;
        let client = build_client(&server.uri());
        let selection = client
            .fetch_test_selection("queue/main", "cafe", "CI", "unit")
            .await
            .into_ready()
            .expect("ready");
        assert_eq!(selection.selection, "subset");
        assert_eq!(selection.tests.unwrap(), ["t::a", "t::b"]);
    }

    #[tokio::test]
    async fn test_selection_subset_without_tests_is_a_contract_error() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/ci/o/repositories/r/test-selection"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "selection": "subset",
                "reason": "queue_rerun",
            })))
            .mount(&server)
            .await;
        let client = build_client(&server.uri());
        // A subset with no `tests` list is a protocol break: surfaced, not run
        // as a silent full suite.
        let outcome = client.fetch_test_selection("queue/main", "cafe", "CI", "unit").await;
        assert!(outcome.failure().is_some());
    }

    #[tokio::test]
    async fn test_selection_subset_with_empty_tests_is_ready() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/ci/o/repositories/r/test-selection"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "selection": "subset",
                "reason": "queue_rerun",
                "tests": [],
            })))
            .mount(&server)
            .await;
        let client = build_client(&server.uri());
        // A *present* empty list is legitimate (subset matched nothing), left
        // for the caller to normalise — not a contract error.
        let selection = client
            .fetch_test_selection("queue/main", "cafe", "CI", "unit")
            .await
            .into_ready()
            .expect("ready");
        assert_eq!(selection.tests, Some(Vec::new()));
    }

    #[tokio::test]
    async fn test_selection_dormant_on_404() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/ci/o/repositories/r/test-selection"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        let client = build_client(&server.uri());
        assert!(
            client
                .fetch_test_selection("main", "cafe", "CI", "unit")
                .await
                .is_dormant()
        );
    }

    #[tokio::test]
    async fn upload_posts_gzipped_protobuf_to_traces_endpoint() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/ci/o/repositories/r/traces"))
            .and(header("content-type", "application/x-protobuf"))
            .and(header("content-encoding", "gzip"))
            .and(header("authorization", "Bearer tok"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;
        let client = build_client(&server.uri());
        client
            .upload_trace(&[("test.run.id".to_owned(), "x".into())], &[span(1)])
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn upload_empty_is_a_noop() {
        // No server: an empty span list must never touch the network.
        let client = build_client("http://127.0.0.1:1");
        client.upload_trace(&[], &[]).await.unwrap();
    }

    #[tokio::test]
    async fn upload_splits_batches_over_the_cap() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/ci/o/repositories/r/traces"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;
        let client = build_client(&server.uri());
        let spans = vec![span(1), span(2), span(3)];
        // A 1-byte cap forces splitting down to one span per upload.
        client.upload_with_cap(&[], &spans, 1).await.unwrap();
        assert_eq!(server.received_requests().await.unwrap().len(), 3);
    }

    #[tokio::test]
    async fn upload_surfaces_permanent_error_status_and_body() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/ci/o/repositories/r/traces"))
            .respond_with(ResponseTemplate::new(400).set_body_string("nope"))
            .mount(&server)
            .await;
        let client = build_client(&server.uri());
        let error = client.upload_trace(&[], &[span(1)]).await.unwrap_err();
        assert_eq!(error.status, Some(400));
        assert!(error.message.contains("nope"));
        // A permanent status is not retried.
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn upload_retries_transient_failures_then_succeeds() {
        let server = MockServer::start().await;
        // The first attempt gets a 503; the retry gets a 200.
        Mock::given(method("POST"))
            .and(path("/v1/ci/o/repositories/r/traces"))
            .respond_with(ResponseTemplate::new(503))
            .up_to_n_times(1)
            .with_priority(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/ci/o/repositories/r/traces"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;
        let mut client = build_client(&server.uri());
        // Keep the backoff imperceptible so the test doesn't sleep for seconds.
        client.retry.base_delay = Duration::from_millis(1);
        client.upload_trace(&[], &[span(1)]).await.unwrap();
        assert_eq!(server.received_requests().await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn upload_fails_loud_after_exhausting_retries_on_5xx() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/ci/o/repositories/r/traces"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;
        let mut client = build_client(&server.uri());
        client.retry.base_delay = Duration::from_millis(1);
        let error = client.upload_trace(&[], &[span(1)]).await.unwrap_err();
        assert_eq!(error.status, Some(503));
        // One initial attempt plus five retries (the default `max_attempts`).
        assert_eq!(server.received_requests().await.unwrap().len(), 6);
    }

    #[tokio::test]
    async fn quarantine_pagination_cycle_is_surfaced() {
        let server = MockServer::start().await;
        let loop_url =
            format!("{}/v1/ci/o/repositories/r/quarantines?cursor=loop", server.uri());
        // First page points to `loop_url`...
        Mock::given(method("GET"))
            .and(path("/v1/ci/o/repositories/r/quarantines"))
            .and(query_param("per_page", "100"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("link", format!("<{loop_url}>; rel=\"next\"").as_str())
                    .set_body_json(serde_json::json!({"quarantined_tests": [{"test_name": "a"}]})),
            )
            .mount(&server)
            .await;
        // ...which points back at itself: a cycle.
        Mock::given(method("GET"))
            .and(path("/v1/ci/o/repositories/r/quarantines"))
            .and(query_param("cursor", "loop"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("link", format!("<{loop_url}>; rel=\"next\"").as_str())
                    .set_body_json(serde_json::json!({"quarantined_tests": [{"test_name": "b"}]})),
            )
            .mount(&server)
            .await;
        let client = build_client(&server.uri());
        // A cycle is surfaced as a failure, not a silent partial list.
        let outcome = client.fetch_quarantine("main").await;
        assert!(outcome.failure().is_some());
    }
}
