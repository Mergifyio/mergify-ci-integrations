//! Shared Mergify backend API client for test-client integrations.
//!
//! One implementation of the small, parity-critical surface every test client
//! (pytest / rspec / vitest / playwright) currently reimplements: the
//! quarantine, flaky-detection, and test-selection calls, the flaky budget
//! engine, and trace upload. Per-framework span *construction* stays in each
//! client; everything else lives here and is exposed through the language
//! bindings.
//!
//! So far:
//!
//! - [`ApiConfig`]: the typed request configuration (base URL, token, and the
//!   `owner`/`repo` path segments), and [`ClientInfo`], the calling
//!   integration's identity, sent as the `User-Agent`.
//! - [`models`]: the response wire types ([`QuarantinePage`],
//!   [`FlakyDetectionContext`]).
//! - [`Outcome`]: the tri-state every backend fetch resolves to.
//! - [`Client`]: the async client — fail-open quarantine/flaky fetches
//!   (resolving to an [`Outcome`]) plus fail-loud trace upload
//!   ([`Client::upload_trace`]).
//! - [`budget`]: the flaky-detection budget engine — the pure arithmetic
//!   (test selection, budget, per-test time shares) ported for cross-client
//!   parity.
//! - [`SpanData`] / [`AttrValue`]: the plain span data handed in for OTLP
//!   trace export (no live `OpenTelemetry` objects cross the boundary).
//!
//! The language bindings land in a later slice.

pub mod budget;

mod client;
mod config;
mod models;
mod outcome;
mod trace;

pub use budget::{BudgetPlan, Mode};
pub use client::Client;
pub use config::{ApiConfig, ClientInfo, DEFAULT_API_URL, split_full_name};
pub use models::{FlakyDetectionContext, QuarantinePage, QuarantinedTest, TestSelection};
pub use outcome::Outcome;
pub use trace::{AttrValue, MAX_GZIPPED_UPLOAD_BYTES, SpanData, SpanStatus, UploadError};
