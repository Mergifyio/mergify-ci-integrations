import { describe, expect, it, vi } from 'vitest';
import {
  buildSessionVerdict,
  formatSessionVerdictResult,
  SessionVerdictFold,
  sendSessionVerdict,
} from '../src/session-verdict.js';

// The wire encoding, the retries and the truncation live in the Rust crate
// and are tested there. What remains here is the fold -- one final status per
// test, whatever the framework reported along the way -- and the body built
// from the same values the selection call was keyed on.

const ATTRIBUTES = {
  'vcs.ref.head.name': 'mergify/merge-queue/main',
  'vcs.ref.head.revision': 'cafe1234',
  'cicd.pipeline.name': 'CI',
  'cicd.pipeline.task.name': 'e2e',
  'cicd.pipeline.run.id': 42,
  'cicd.pipeline.run.attempt': 2,
};

describe('SessionVerdictFold', () => {
  it('counts every distinct test once, by its final status', () => {
    const fold = new SessionVerdictFold();
    fold.record('a', 'passed');
    fold.record('b', 'failed');
    fold.record('c', 'skipped');
    fold.record('d', 'quarantined_failed');

    expect(fold.counts()).toEqual({
      executedCount: 4,
      passedCount: 1,
      failedCount: 2,
      skippedCount: 1,
    });
    expect(fold.failingTests()).toEqual(['b']);
    expect(fold.quarantinedFailingTests()).toEqual(['d']);
  });

  it('never downgrades a failure: the same identity in two projects is one failed test', () => {
    // Project prefixing off: chromium and firefox share one identity, and a
    // failure in either is a failure of the test -- the engine dedups the ids
    // on the wire and checks `failed_count` against their number, so the
    // count has to be per identity too.
    const fold = new SessionVerdictFold();
    fold.record('t', 'failed');
    fold.record('t', 'passed');
    fold.record('u', 'passed');
    fold.record('u', 'failed');

    expect(fold.counts()).toEqual({
      executedCount: 2,
      passedCount: 0,
      failedCount: 2,
      skippedCount: 0,
    });
    expect(fold.failingTests()).toEqual(['t', 'u']);
  });

  it('ranks a quarantined failure above a skip and below a failure', () => {
    const fold = new SessionVerdictFold();
    fold.record('t', 'skipped');
    fold.record('t', 'quarantined_failed');
    expect(fold.quarantinedFailingTests()).toEqual(['t']);
    fold.record('t', 'failed');
    expect(fold.quarantinedFailingTests()).toEqual([]);
    expect(fold.failingTests()).toEqual(['t']);
  });

  it("sums every attempt's time, and ignores what is not a duration", () => {
    const fold = new SessionVerdictFold();
    fold.recordDuration(1500.7);
    fold.recordDuration(20);
    fold.recordDuration(-5);
    fold.recordDuration(Number.NaN);

    expect(fold.totalTestRuntimeMs).toBe(1520);
  });
});

describe('buildSessionVerdict', () => {
  const fold = () => {
    const f = new SessionVerdictFold();
    f.record('a', 'passed');
    f.record('b', 'failed');
    f.recordDuration(100);
    return f;
  };

  it('builds the body from the run identity, the collection and the fold', () => {
    const verdict = buildSessionVerdict({
      testRunId: '0123456789abcdef',
      attributes: ATTRIBUTES,
      collection: { fingerprint: 'f1', count: 2 },
      fold: fold(),
      selection: { answer: 'subset', reason: 'queue_rerun', kept_count: 2 },
    });

    expect(verdict).toEqual({
      testRunId: '0123456789abcdef',
      headSha: 'cafe1234',
      headBranch: 'mergify/merge-queue/main',
      pipelineName: 'CI',
      jobName: 'e2e',
      runId: '42',
      runAttempt: 2,
      collectionFingerprint: 'f1',
      collectionCount: 2,
      executedCount: 2,
      passedCount: 1,
      failedCount: 1,
      skippedCount: 0,
      totalTestRuntimeMs: 100,
      failingTests: ['b'],
      quarantinedFailingTests: [],
      selection: { answer: 'subset', reason: 'queue_rerun', keptCount: 2 },
    });
  });

  it('prefers the operator-set job name, as the selection call does', () => {
    const verdict = buildSessionVerdict({
      testRunId: '0123456789abcdef',
      attributes: { ...ATTRIBUTES, 'mergify.test.job.name': 'e2e-1' },
      collection: { fingerprint: 'f1', count: 2 },
      fold: fold(),
      selection: undefined,
    });

    expect(verdict?.jobName).toBe('e2e-1');
    expect(verdict?.selection).toBeUndefined();
  });

  it('carries the not-applied reason on the echo', () => {
    const verdict = buildSessionVerdict({
      testRunId: '0123456789abcdef',
      attributes: ATTRIBUTES,
      collection: { fingerprint: 'f1', count: 2 },
      fold: fold(),
      selection: {
        answer: 'subset',
        reason: 'queue_rerun',
        kept_count: 2,
        not_applied_reason: 'subset_partly_absent_from_collection',
      },
    });

    expect(verdict?.selection).toEqual({
      answer: 'subset',
      reason: 'queue_rerun',
      keptCount: 2,
      notAppliedReason: 'subset_partly_absent_from_collection',
    });
  });

  it('sends no attempt without a run id, and no run id when the provider has none', () => {
    const {
      'cicd.pipeline.run.id': _id,
      'cicd.pipeline.run.attempt': _attempt,
      ...bare
    } = ATTRIBUTES;
    const verdict = buildSessionVerdict({
      testRunId: '0123456789abcdef',
      attributes: bare,
      collection: { fingerprint: 'f1', count: 2 },
      fold: fold(),
      selection: undefined,
    });

    expect(verdict?.runId).toBeUndefined();
    expect(verdict?.runAttempt).toBeUndefined();
  });

  it('builds nothing when the run identity is incomplete', () => {
    const { 'cicd.pipeline.name': _pipeline, ...bare } = ATTRIBUTES;

    expect(
      buildSessionVerdict({
        testRunId: '0123456789abcdef',
        attributes: bare,
        collection: { fingerprint: 'f1', count: 2 },
        fold: fold(),
        selection: undefined,
      })
    ).toBeNull();
  });
});

describe('sendSessionVerdict', () => {
  const verdict = buildSessionVerdict({
    testRunId: '0123456789abcdef',
    attributes: ATTRIBUTES,
    collection: { fingerprint: 'f1', count: 0 },
    fold: new SessionVerdictFold(),
    selection: undefined,
  })!;

  it('reports a landed verdict, with the engine receipt', async () => {
    const send = vi.fn().mockResolvedValue({ truncated: true });

    expect(await sendSessionVerdict({ sendSessionVerdict: send }, verdict)).toEqual({
      sent: true,
      truncated: true,
    });
    expect(send).toHaveBeenCalledWith(verdict);
  });

  it('reports a dormant repository as nothing sent', async () => {
    expect(
      await sendSessionVerdict({ sendSessionVerdict: vi.fn().mockResolvedValue(null) }, verdict)
    ).toEqual({ sent: false, truncated: false });
  });

  it('never throws: a failed request is reported, not raised', async () => {
    const send = vi.fn().mockRejectedValue(new Error('Mergify API returned HTTP 503'));

    expect(await sendSessionVerdict({ sendSessionVerdict: send }, verdict)).toEqual({
      sent: false,
      truncated: false,
      error: 'Mergify API returned HTTP 503',
    });
  });

  it('sends nothing through a client that predates the verdict', async () => {
    expect(await sendSessionVerdict({}, verdict)).toEqual({ sent: false, truncated: false });
  });
});

// Wording validated by Alexandre on 2026-09-15 (MRGFY-9313); copied from
// pytest-mergify, not derived.
describe('formatSessionVerdictResult', () => {
  it('says nothing on success', () => {
    expect(formatSessionVerdictResult({ sent: true, truncated: false })).toBeUndefined();
    expect(formatSessionVerdictResult({ sent: false, truncated: false })).toBeUndefined();
  });

  it('says the reduction is lost when the verdict did not land, with the error for support', () => {
    expect(formatSessionVerdictResult({ sent: false, truncated: false, error: 'HTTP 503' })).toBe(
      "Mergify couldn't record this run's results. If this merge-queue batch is\n" +
        'retried, this job will run its full test suite.\n' +
        'Error: HTTP 503\n'
    );
  });

  it('says the ids were withheld when the verdict was truncated', () => {
    expect(formatSessionVerdictResult({ sent: true, truncated: true })).toBe(
      "Mergify recorded this run's counts but not its failing tests. If this\n" +
        'merge-queue batch is retried, this job will run its full test suite.\n'
    );
  });
});
