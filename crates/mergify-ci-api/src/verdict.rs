//! The session verdict — what a test session concluded, written to Mergify by
//! the client itself when the session ends.
//!
//! Test Selection answers a merge-queue rerun from its predecessor's verdict.
//! It used to read that off the ingested spans, which sit at the end of the
//! trace ingestion queue — a queue that stalls for hours twice a day, during
//! which every rerun asking was told its predecessor did not exist and ran the
//! whole suite (INC-2434). The verdict is the same facts, sent in one request
//! on its own path, before the trace upload, so the selection can read them
//! seconds after the session ended whatever the queue is doing.
//!
//! The document is complete by construction: the client folds its own
//! in-session retries and sends the ids whose FINAL status is failed, and
//! there is no chunking. What it costs is proportional to the failures, never
//! to the size of the suite — a green session's verdict is a few hundred
//! bytes.

use flate2::Compression;
use flate2::write::GzEncoder;
use serde::Serialize;

/// Hard cap on a gzipped verdict body, on the wire. The engine's own bound for
/// the route (32 MiB; `CI_TEST_SESSION_VERDICT_MAX_CONTENT_SIZE` in
/// mergify-engine), which is what the client compares against before sending:
/// past it, the verdict goes out with its counts and no ids
/// ([`SessionVerdict::truncate`]). Deliberately NOT
/// [`crate::MAX_GZIPPED_UPLOAD_BYTES`]: that one is the trace upload's chunk
/// size, this one is the largest verdict a real session produces — 2 M sorted
/// failing ids gzip to 21.6 MB (real pytest ids, the engine's measurement) and
/// to 24.3 MB on synthetic ids carrying 48 random bits each (this crate's
/// benchmark, MRGFY-9313), both under the bound.
pub const MAX_GZIPPED_VERDICT_BYTES: usize = 32 * 1024 * 1024;

/// What the session was served when it asked for a selection, and whether it
/// could act on it. Echoed by the client: the selection endpoint keeps no
/// record of its answers, and only the client knows whether the answer it got
/// is one it applied.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SessionVerdictSelection {
    /// The answer as Mergify served it — `full`, `subset`, `empty` or
    /// `refused` — verbatim, even when the client could not act on it: what
    /// it did instead is `not_applied_reason`, never a rewrite of this.
    pub answer: String,
    /// Mergify's own word for the answer, forwarded verbatim.
    pub reason: String,
    /// How many tests the selection left the run to run.
    pub kept_count: u32,
    /// The client's own account of why it could not apply the served answer
    /// and ran the whole suite instead. `None` when the answer was honoured.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub not_applied_reason: Option<String>,
}

/// The request body of `POST …/test-session-verdicts`.
///
/// The field names are the wire contract with the engine; keep them in step
/// with `SessionVerdict` in mergify-engine's `test_selection/verdicts.py`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SessionVerdict {
    /// The session's own id, the `test.run.id` its trace upload carries:
    /// sixteen hex digits. The idempotency key of the write, so a retry after
    /// a timeout repeats it rather than duplicating the verdict.
    pub test_run_id: String,
    /// Where the session ran: the same coordinates the selection call names,
    /// so the verdict is found by exactly what the asking run knows.
    pub head_sha: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_branch: Option<String>,
    pub pipeline_name: String,
    pub job_name: String,
    /// The provider's identity for ONE execution of the job, when it reports
    /// one. A string on the wire whatever the provider's type (GitHub's is an
    /// integer). `run_attempt` needs it: the engine refuses an attempt with
    /// nothing to be an attempt of.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_attempt: Option<u32>,
    /// The identity of what the session collected
    /// (`mergify_ci_core::test_collection_fingerprint`) and how many tests
    /// that collection holds.
    pub collection_fingerprint: String,
    pub collection_count: u32,
    /// Per test, by its FINAL status in the session, after the client's own
    /// retries. `executed_count` is what decides "did this session run
    /// anything"; `failed_count` counts the quarantined failures too. A
    /// session stopped early (`-x`, `--maxfail`) simply counts less than it
    /// kept: the verdict makes no completeness claim of its own.
    pub executed_count: u32,
    pub passed_count: u32,
    pub failed_count: u32,
    pub skipped_count: u32,
    pub total_test_runtime_ms: u64,
    /// The ids whose final status is failed, split by whether the failure was
    /// quarantined. Only the first list gates a rerun; the second is what a
    /// rerun must not replay. Sorted and deduplicated on the way out
    /// ([`SessionVerdict::compress`]).
    pub failing_tests: Vec<String>,
    pub quarantined_failing_tests: Vec<String>,
    /// The lists outgrew [`MAX_GZIPPED_VERDICT_BYTES`], so the counts were sent
    /// and no ids; the engine then serves the full suite under its own reason.
    pub failing_tests_truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection: Option<SessionVerdictSelection>,
}

impl SessionVerdict {
    /// Drop the ids and keep the counts: what goes out when the ids do not
    /// fit the bound. In place, because the only caller has just found out
    /// the ids cannot be sent and has no further use for two million of them.
    pub fn truncate(&mut self) {
        self.failing_tests = Vec::new();
        self.quarantined_failing_tests = Vec::new();
        self.failing_tests_truncated = true;
    }

    /// The exact bytes to put on the wire: the body as gzipped JSON.
    ///
    /// The id lists are sorted (and deduplicated) first: sorted ids share
    /// their prefixes — the module path, the class — with their neighbours,
    /// which is what gzip's window is made of. Measured on 2 M real pytest
    /// node ids: 21.6 MB sorted against 28 MB in collection order, for 150 MB
    /// of JSON either way.
    pub fn compress(&mut self) -> std::io::Result<Vec<u8>> {
        for ids in [&mut self.failing_tests, &mut self.quarantined_failing_tests] {
            ids.sort_unstable();
            ids.dedup();
        }
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        serde_json::to_writer(&mut encoder, self)?;
        encoder.finish()
    }
}

/// The engine's receipt for a verdict that landed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionVerdictReceipt {
    /// Whether the verdict went out with its counts and no ids, because the
    /// ids did not fit the bound. The next rerun of this job is then served
    /// the full suite, and the client should say so in its report.
    pub truncated: bool,
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use flate2::read::GzDecoder;
    use std::io::Read as _;

    pub(crate) fn decode(compressed: &[u8]) -> serde_json::Value {
        let mut unzipped = Vec::new();
        GzDecoder::new(compressed).read_to_end(&mut unzipped).unwrap();
        serde_json::from_slice(&unzipped).unwrap()
    }

    pub(crate) fn verdict() -> SessionVerdict {
        SessionVerdict {
            test_run_id: "0123456789abcdef".to_owned(),
            head_sha: "cafe".to_owned(),
            head_branch: Some("mergify/merge-queue/main".to_owned()),
            pipeline_name: "CI".to_owned(),
            job_name: "unit".to_owned(),
            run_id: Some("42".to_owned()),
            run_attempt: Some(2),
            collection_fingerprint: "f1".to_owned(),
            collection_count: 3,
            executed_count: 3,
            passed_count: 1,
            failed_count: 2,
            skipped_count: 0,
            total_test_runtime_ms: 1500,
            failing_tests: vec!["t::b".to_owned()],
            quarantined_failing_tests: vec!["t::q".to_owned()],
            failing_tests_truncated: false,
            selection: Some(SessionVerdictSelection {
                answer: "subset".to_owned(),
                reason: "queue_rerun".to_owned(),
                kept_count: 3,
                not_applied_reason: None,
            }),
        }
    }

    #[test]
    fn serialises_the_wire_contract() {
        let body = decode(&verdict().compress().unwrap());
        assert_eq!(body["test_run_id"], "0123456789abcdef");
        assert_eq!(body["head_sha"], "cafe");
        assert_eq!(body["head_branch"], "mergify/merge-queue/main");
        assert_eq!(body["pipeline_name"], "CI");
        assert_eq!(body["job_name"], "unit");
        // A string on the wire, whatever the provider's type.
        assert_eq!(body["run_id"], "42");
        assert_eq!(body["run_attempt"], 2);
        assert_eq!(body["collection_fingerprint"], "f1");
        assert_eq!(body["collection_count"], 3);
        assert_eq!(body["executed_count"], 3);
        assert_eq!(body["passed_count"], 1);
        assert_eq!(body["failed_count"], 2);
        assert_eq!(body["skipped_count"], 0);
        assert_eq!(body["total_test_runtime_ms"], 1500);
        assert_eq!(body["failing_tests"], serde_json::json!(["t::b"]));
        assert_eq!(body["quarantined_failing_tests"], serde_json::json!(["t::q"]));
        assert_eq!(body["failing_tests_truncated"], false);
        assert_eq!(body["selection"]["answer"], "subset");
        assert_eq!(body["selection"]["reason"], "queue_rerun");
        assert_eq!(body["selection"]["kept_count"], 3);
        // Absent, not null: the engine reads a missing key as "applied".
        assert!(body["selection"].get("not_applied_reason").is_none());
    }

    #[test]
    fn omits_the_optional_coordinates_rather_than_sending_null() {
        let mut verdict = verdict();
        verdict.head_branch = None;
        verdict.run_id = None;
        verdict.run_attempt = None;
        verdict.selection = None;
        let body = decode(&verdict.compress().unwrap());
        for key in ["head_branch", "run_id", "run_attempt", "selection"] {
            assert!(body.get(key).is_none(), "{key} should be absent");
        }
    }

    #[test]
    fn sorts_and_deduplicates_the_ids_on_the_wire() {
        let mut verdict = verdict();
        verdict.failing_tests =
            vec!["t::c".to_owned(), "t::a".to_owned(), "t::c".to_owned(), "t::b".to_owned()];
        let body = decode(&verdict.compress().unwrap());
        assert_eq!(body["failing_tests"], serde_json::json!(["t::a", "t::b", "t::c"]));
    }

    #[test]
    fn a_truncated_verdict_keeps_its_counts_and_drops_its_ids() {
        let mut truncated = verdict();
        truncated.truncate();
        assert!(truncated.failing_tests.is_empty());
        assert!(truncated.quarantined_failing_tests.is_empty());
        assert!(truncated.failing_tests_truncated);
        assert_eq!(truncated.failed_count, 2);
        assert_eq!(truncated.selection, verdict().selection);
    }
}
