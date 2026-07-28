//! OTLP trace export — plain span data to a gzipped `ExportTraceServiceRequest`.
//!
//! Encodes spans to OTLP protobuf and gzips them by hand, without the
//! `OpenTelemetry` SDK (ports mergify-cli's `junit_process::upload`). Clients
//! pass span *data* — never live `OpenTelemetry` span objects — so this
//! boundary is binding-friendly. The upload itself lives on [`crate::Client`].

use std::io::Write as _;

use flate2::Compression;
use flate2::write::GzEncoder;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::common::v1::any_value::Value as AnyValueOneof;
use opentelemetry_proto::tonic::common::v1::{AnyValue, KeyValue};
use opentelemetry_proto::tonic::resource::v1::Resource;
use opentelemetry_proto::tonic::trace::v1::span::SpanKind;
use opentelemetry_proto::tonic::trace::v1::status::StatusCode;
use opentelemetry_proto::tonic::trace::v1::{ResourceSpans, ScopeSpans, Span, Status};
use prost::Message as _;

/// Soft cap on a single gzipped upload (20 MiB). Larger traces are split into
/// several uploads under the cap; the server hard-caps the compressed body
/// above this, so the headroom avoids rejections.
pub const MAX_GZIPPED_UPLOAD_BYTES: usize = 20 * 1024 * 1024;

/// An `OpenTelemetry` attribute value.
#[derive(Debug, Clone, PartialEq)]
pub enum AttrValue {
    /// A string attribute.
    Str(String),
    /// A 64-bit integer attribute.
    Int(i64),
    /// A double attribute.
    Double(f64),
    /// A boolean attribute.
    Bool(bool),
}

impl From<&str> for AttrValue {
    fn from(value: &str) -> Self {
        AttrValue::Str(value.to_owned())
    }
}
impl From<String> for AttrValue {
    fn from(value: String) -> Self {
        AttrValue::Str(value)
    }
}
impl From<i64> for AttrValue {
    fn from(value: i64) -> Self {
        AttrValue::Int(value)
    }
}
impl From<f64> for AttrValue {
    fn from(value: f64) -> Self {
        AttrValue::Double(value)
    }
}
impl From<bool> for AttrValue {
    fn from(value: bool) -> Self {
        AttrValue::Bool(value)
    }
}

/// A span's completion status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpanStatus {
    /// No explicit status.
    Unset,
    /// The operation completed successfully.
    Ok,
    /// The operation failed; the string is the error message.
    Error(String),
}

/// One span, as plain data handed across the binding boundary.
#[derive(Debug, Clone, PartialEq)]
pub struct SpanData {
    /// Span name.
    pub name: String,
    /// 16-byte trace id.
    pub trace_id: [u8; 16],
    /// 8-byte span id.
    pub span_id: [u8; 8],
    /// Parent span id, or `None` for a root span.
    pub parent_span_id: Option<[u8; 8]>,
    /// Start time, nanoseconds since the Unix epoch.
    pub start_unix_nano: u64,
    /// End time, nanoseconds since the Unix epoch.
    pub end_unix_nano: u64,
    /// Span attributes.
    pub attributes: Vec<(String, AttrValue)>,
    /// Completion status.
    pub status: SpanStatus,
}

/// A trace-upload failure. Trace export fails *loud* (unlike the fail-open
/// fetches), so callers see the status and message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadError {
    /// HTTP status, when the server responded; `None` for transport/encode
    /// failures.
    pub status: Option<u16>,
    /// A human-readable message (the response body, or the local error).
    pub message: String,
}

impl UploadError {
    /// Whether the server understood the request and refused it — a permanent
    /// `4xx` rejection (except `408`/`429`) that no retry fixes. Mirrors OTLP
    /// retryability semantics.
    #[must_use]
    pub fn is_rejection(&self) -> bool {
        match self.status {
            Some(status) => (400..500).contains(&status) && status != 408 && status != 429,
            None => false,
        }
    }
}

impl std::fmt::Display for UploadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.status {
            Some(status) => write!(f, "trace upload failed (HTTP {status}): {}", self.message),
            None => write!(f, "trace upload failed: {}", self.message),
        }
    }
}

impl std::error::Error for UploadError {}

fn any_value(value: &AttrValue) -> AnyValue {
    let inner = match value {
        AttrValue::Str(value) => AnyValueOneof::StringValue(value.clone()),
        AttrValue::Int(value) => AnyValueOneof::IntValue(*value),
        AttrValue::Double(value) => AnyValueOneof::DoubleValue(*value),
        AttrValue::Bool(value) => AnyValueOneof::BoolValue(*value),
    };
    AnyValue { value: Some(inner) }
}

fn key_values(attributes: &[(String, AttrValue)]) -> Vec<KeyValue> {
    attributes
        .iter()
        .map(|(key, value)| KeyValue {
            key: key.clone(),
            value: Some(any_value(value)),
            ..KeyValue::default()
        })
        .collect()
}

fn to_status(status: &SpanStatus) -> Status {
    let (code, message) = match status {
        SpanStatus::Unset => (StatusCode::Unset, String::new()),
        SpanStatus::Ok => (StatusCode::Ok, String::new()),
        SpanStatus::Error(message) => (StatusCode::Error, message.clone()),
    };
    Status { message, code: code as i32 }
}

fn to_span(span: &SpanData) -> Span {
    Span {
        trace_id: span.trace_id.to_vec(),
        span_id: span.span_id.to_vec(),
        parent_span_id: span.parent_span_id.map_or_else(Vec::new, |id| id.to_vec()),
        name: span.name.clone(),
        kind: SpanKind::Internal as i32,
        start_time_unix_nano: span.start_unix_nano,
        end_time_unix_nano: span.end_unix_nano,
        attributes: key_values(&span.attributes),
        status: Some(to_status(&span.status)),
        ..Span::default()
    }
}

fn build_request(
    resource_attributes: &[(String, AttrValue)],
    spans: &[SpanData],
) -> ExportTraceServiceRequest {
    ExportTraceServiceRequest {
        resource_spans: vec![ResourceSpans {
            resource: Some(Resource {
                attributes: key_values(resource_attributes),
                ..Resource::default()
            }),
            scope_spans: vec![ScopeSpans {
                scope: None,
                spans: spans.iter().map(to_span).collect(),
                schema_url: String::new(),
            }],
            schema_url: String::new(),
        }],
    }
}

fn gzip(bytes: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(bytes)?;
    encoder.finish()
}

/// Encode `spans` (under `resource_attributes`) to OTLP protobuf and gzip it,
/// returning the exact bytes to put on the wire.
pub(crate) fn compress_batch(
    resource_attributes: &[(String, AttrValue)],
    spans: &[SpanData],
) -> std::io::Result<Vec<u8>> {
    gzip(&build_request(resource_attributes, spans).encode_to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::read::GzDecoder;
    use std::io::Read as _;

    fn decode(compressed: &[u8]) -> ExportTraceServiceRequest {
        let mut unzipped = Vec::new();
        GzDecoder::new(compressed).read_to_end(&mut unzipped).unwrap();
        ExportTraceServiceRequest::decode(unzipped.as_slice()).unwrap()
    }

    #[test]
    fn round_trips_spans_and_attributes() {
        let spans = vec![SpanData {
            name: "test_x".to_owned(),
            trace_id: [1; 16],
            span_id: [2; 8],
            parent_span_id: Some([3; 8]),
            start_unix_nano: 10,
            end_unix_nano: 20,
            attributes: vec![
                ("cicd.test.flaky".to_owned(), AttrValue::Bool(true)),
                ("cicd.test.rerun_count".to_owned(), AttrValue::Int(3)),
                ("test.case.result.status".to_owned(), "passed".into()),
            ],
            status: SpanStatus::Error("boom".to_owned()),
        }];
        let resource = vec![("test.run.id".to_owned(), "deadbeef".into())];

        let request = decode(&compress_batch(&resource, &spans).unwrap());
        let resource_spans = &request.resource_spans[0];
        assert_eq!(resource_spans.resource.as_ref().unwrap().attributes.len(), 1);
        let proto_spans = &resource_spans.scope_spans[0].spans;
        assert_eq!(proto_spans.len(), 1);
        let span = &proto_spans[0];
        assert_eq!(span.name, "test_x");
        assert_eq!(span.trace_id, vec![1; 16]);
        assert_eq!(span.parent_span_id, vec![3; 8]);
        assert_eq!(span.attributes.len(), 3);
        assert_eq!(span.status.as_ref().unwrap().code, StatusCode::Error as i32);
        assert_eq!(span.status.as_ref().unwrap().message, "boom");
    }

    #[test]
    fn is_rejection_follows_otlp_semantics() {
        let err = |status| UploadError { status, message: String::new() };
        assert!(err(Some(401)).is_rejection());
        assert!(err(Some(404)).is_rejection());
        assert!(!err(Some(408)).is_rejection());
        assert!(!err(Some(429)).is_rejection());
        assert!(!err(Some(500)).is_rejection());
        assert!(!err(None).is_rejection());
    }
}
