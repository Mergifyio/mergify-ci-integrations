//! Async client for the Mergify backend API.

use std::collections::HashSet;
use std::time::Duration;

use reqwest::StatusCode;
use reqwest::header::LINK;

use crate::config::ApiConfig;
use crate::models::{FlakyDetectionContext, QuarantinePage};
use crate::outcome::Outcome;
use crate::trace::{self, AttrValue, MAX_GZIPPED_UPLOAD_BYTES, SpanData, UploadError};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(30);

/// Async client for a single repository's Mergify backend API.
///
/// Fetches are *fail-open*: a `402` (no subscription) or `404` (feature not
/// enabled) resolves to [`Outcome::Dormant`]; any other failure to
/// [`Outcome::Failed`] with a message. A fetch never panics or returns an
/// `Err` to the caller — degradation is the contract.
pub struct Client {
    config: ApiConfig,
    http: reqwest::Client,
}

impl Client {
    /// Build a client for `config`.
    pub fn new(config: ApiConfig) -> reqwest::Result<Self> {
        let http = reqwest::Client::builder().timeout(REQUEST_TIMEOUT).build()?;
        Ok(Self { config, http })
    }

    fn endpoint(&self, suffix: &str) -> String {
        format!(
            "{}/v1/ci/{}/repositories/{}/{}",
            self.config.api_url, self.config.owner, self.config.repo, suffix
        )
    }

    /// Fetch the quarantined test names for `branch`, following `Link`
    /// pagination (with a cycle guard). `402` → dormant; any other non-success
    /// → failed.
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
                        break; // the server pointed us back at a seen page
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

    /// Fetch the flaky-detection context. `402`/`404` → dormant; any other
    /// non-success → failed.
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
        if status == StatusCode::NOT_FOUND || status == StatusCode::PAYMENT_REQUIRED {
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
        let response = self
            .http
            .post(url)
            .timeout(UPLOAD_TIMEOUT)
            .bearer_auth(&self.config.token)
            .header("Content-Type", "application/x-protobuf")
            .header("Content-Encoding", "gzip")
            .body(compressed)
            .send()
            .await
            .map_err(|error| UploadError { status: None, message: error.to_string() })?;

        if response.status().is_success() {
            return Ok(());
        }
        let status = response.status().as_u16();
        let body = response
            .text()
            .await
            .unwrap_or_else(|error| format!("<could not read response body: {error}>"));
        Err(UploadError { status: Some(status), message: body })
    }
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
    async fn flaky_context_ready() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/ci/o/repositories/r/flaky-detection-context"))
            .respond_with(ResponseTemplate::new(200).set_body_json(flaky_body()))
            .mount(&server)
            .await;
        let client = Client::new(config(&server.uri())).unwrap();
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
        let client = Client::new(config(&server.uri())).unwrap();
        assert!(client.fetch_flaky_context().await.is_dormant());
    }

    #[tokio::test]
    async fn flaky_context_failed_on_500() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/ci/o/repositories/r/flaky-detection-context"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        let client = Client::new(config(&server.uri())).unwrap();
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
        let client = Client::new(config(&server.uri())).unwrap();
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
        let client = Client::new(config(&server.uri())).unwrap();
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
        let client = Client::new(config(&server.uri())).unwrap();
        client
            .upload_trace(&[("test.run.id".to_owned(), "x".into())], &[span(1)])
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn upload_empty_is_a_noop() {
        // No server: an empty span list must never touch the network.
        let client = Client::new(config("http://127.0.0.1:1")).unwrap();
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
        let client = Client::new(config(&server.uri())).unwrap();
        let spans = vec![span(1), span(2), span(3)];
        // A 1-byte cap forces splitting down to one span per upload.
        client.upload_with_cap(&[], &spans, 1).await.unwrap();
        assert_eq!(server.received_requests().await.unwrap().len(), 3);
    }

    #[tokio::test]
    async fn upload_surfaces_error_status_and_body() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/ci/o/repositories/r/traces"))
            .respond_with(ResponseTemplate::new(500).set_body_string("nope"))
            .mount(&server)
            .await;
        let client = Client::new(config(&server.uri())).unwrap();
        let error = client.upload_trace(&[], &[span(1)]).await.unwrap_err();
        assert_eq!(error.status, Some(500));
        assert!(error.message.contains("nope"));
    }
}
