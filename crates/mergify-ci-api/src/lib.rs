//! Shared Mergify backend API client for test-client integrations.
//!
//! One implementation of the small, parity-critical surface every test client
//! (pytest / rspec / vitest / playwright) currently reimplements: the
//! quarantine and flaky-detection calls, the flaky budget engine, and trace
//! upload. Per-framework span *construction* stays in each client; everything
//! else lives here and is exposed through the language bindings.
//!
//! So far:
//!
//! - [`ApiConfig`]: the typed request configuration (base URL, token, and the
//!   `owner`/`repo` path segments).
//! - [`models`]: the response wire types ([`QuarantinePage`],
//!   [`FlakyDetectionContext`]).
//! - [`Outcome`]: the tri-state every backend fetch resolves to.
//! - [`Client`]: the async client for the quarantine and flaky-detection
//!   fetches — fail-open, resolving to an [`Outcome`].
//! - [`budget`]: the flaky-detection budget engine — the pure arithmetic
//!   (test selection, budget, per-test time shares) ported for cross-client
//!   parity.
//!
//! Trace export lands in a later slice.

pub mod budget;

mod client;
mod config;
mod models;
mod outcome;

pub use budget::{BudgetPlan, Mode};
pub use client::Client;
pub use config::{ApiConfig, DEFAULT_API_URL, split_full_name};
pub use models::{FlakyDetectionContext, QuarantinePage, QuarantinedTest};
pub use outcome::Outcome;
