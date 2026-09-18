import type { SessionVerdict } from '@mergifyio/ci-native';
import type { SessionVerdictClient } from './api.js';
import type { TestCollection, TestSelectionEcho } from './test-selection.js';
import type { SpanAttributes } from './types.js';
import { describeError, wrapText } from './utils.js';

/**
 * What the session concluded about each test, folded as the framework reports
 * it, and written to Mergify by the reporter itself when the session ends.
 *
 * Test Selection answers a merge-queue rerun from its predecessor's verdict:
 * which tests failed, whether anything ran at all. Reading that off the
 * uploaded spans meant waiting for the trace ingestion queue, which stalls for
 * hours twice a day (INC-2434), during which every rerun asking was served the
 * full suite. The verdict is the same facts, written in one request before the
 * trace upload, so the answer is there seconds after the session ends.
 *
 * The fold is the one thing the engine no longer does: a test may execute
 * several times in one session (the framework's own retries), and the verdict
 * carries ONE status per test, its final one -- what the framework itself
 * concluded, so that the verdict and the exit code agree. A rerun served from
 * a verdict that disagrees with the exit code either replays tests that did
 * not gate, or -- the loss this module exists to prevent -- turns green having
 * skipped the one that did.
 */

/**
 * A test's status once the session is over. `quarantined_failed` is a failure
 * the quarantine absorbed: kept apart from `failed` because it did not gate
 * the job, and apart from `skipped` because the test did run and did fail --
 * the engine counts it as failed and lists it separately, so a rerun neither
 * replays it nor reads it as green.
 */
export type FinalStatus = 'passed' | 'failed' | 'skipped' | 'quarantined_failed';

// A later record never downgrades an earlier verdict. The same identifier can
// be recorded more than once in one session -- a Playwright test collected in
// two browser projects shares one identity when project prefixing is off --
// and a failure in one of them is a failure of the test.
const PRECEDENCE: Record<FinalStatus, number> = {
  passed: 0,
  skipped: 1,
  quarantined_failed: 2,
  failed: 3,
};

/** The per-test fold, fed one final status at a time. */
export class SessionVerdictFold {
  private final = new Map<string, FinalStatus>();
  // Every attempt's time, whatever its status: the time the job spent on its
  // tests, which is what a reduction saves.
  private runtimeMs = 0;

  record(testId: string, status: FinalStatus): void {
    const previous = this.final.get(testId);
    if (previous === undefined || PRECEDENCE[status] > PRECEDENCE[previous]) {
      this.final.set(testId, status);
    }
  }

  recordDuration(durationMs: number): void {
    if (Number.isFinite(durationMs) && durationMs > 0) this.runtimeMs += durationMs;
  }

  get totalTestRuntimeMs(): number {
    return Math.floor(this.runtimeMs);
  }

  /**
   * The counts the engine reads, under its own definitions: `executed` is
   * every distinct test that reached a final status -- a skipped test counts
   * -- and `failed` includes the quarantined failures, so that
   * `failed === failingTests.length + quarantinedFailingTests.length` holds
   * by construction.
   */
  counts(): {
    executedCount: number;
    passedCount: number;
    failedCount: number;
    skippedCount: number;
  } {
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    for (const status of this.final.values()) {
      if (status === 'passed') passed += 1;
      else if (status === 'skipped') skipped += 1;
      else failed += 1;
    }
    return {
      executedCount: this.final.size,
      passedCount: passed,
      failedCount: failed,
      skippedCount: skipped,
    };
  }

  failingTests(): string[] {
    return [...this.final].filter(([, status]) => status === 'failed').map(([id]) => id);
  }

  quarantinedFailingTests(): string[] {
    return [...this.final]
      .filter(([, status]) => status === 'quarantined_failed')
      .map(([id]) => id);
  }
}

export interface SessionVerdictInput {
  /** The session's own id, the `test.run.id` its trace carries. */
  testRunId: string;
  /** The run's resource attributes: the coordinates are read off them exactly as the selection call reads them. */
  attributes: SpanAttributes;
  collection: TestCollection;
  fold: SessionVerdictFold;
  selection: TestSelectionEcho | undefined;
}

// The largest value the engine's counters take (a signed 32-bit int).
const MAX_COUNT = 2 ** 31 - 1;

/**
 * The request body, from the same values the selection call was keyed on, or
 * null when the run's identity is incomplete -- a verdict the asking run could
 * not find by what it knows is not worth a request.
 */
export function buildSessionVerdict(input: SessionVerdictInput): SessionVerdict | null {
  const { attributes } = input;
  const text = (key: string): string | undefined => {
    const value = attributes[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };
  const headSha = text('vcs.ref.head.revision');
  const pipelineName = text('cicd.pipeline.name');
  const jobName = text('mergify.test.job.name') ?? text('cicd.pipeline.task.name');
  if (!headSha || !pipelineName || !jobName) return null;

  const counts = input.fold.counts();
  const verdict: SessionVerdict = {
    testRunId: input.testRunId,
    headSha,
    pipelineName,
    jobName,
    collectionFingerprint: input.collection.fingerprint,
    collectionCount: input.collection.count,
    executedCount: counts.executedCount,
    passedCount: counts.passedCount,
    failedCount: counts.failedCount,
    skippedCount: counts.skippedCount,
    totalTestRuntimeMs: input.fold.totalTestRuntimeMs,
    failingTests: input.fold.failingTests(),
    quarantinedFailingTests: input.fold.quarantinedFailingTests(),
  };
  const headBranch = text('vcs.ref.head.name');
  if (headBranch) verdict.headBranch = headBranch;
  // `run_attempt` only next to a `run_id`: the engine refuses an attempt of
  // nothing, and a provider that reports no run id reports no attempt either.
  const runId = attributes['cicd.pipeline.run.id'];
  if (runId !== undefined && runId !== '') {
    verdict.runId = String(runId);
    const runAttempt = attributes['cicd.pipeline.run.attempt'];
    if (
      typeof runAttempt === 'number' &&
      Number.isInteger(runAttempt) &&
      runAttempt >= 0 &&
      runAttempt <= MAX_COUNT
    ) {
      verdict.runAttempt = runAttempt;
    }
  }
  if (input.selection) {
    verdict.selection = {
      answer: input.selection.answer,
      reason: input.selection.reason,
      keptCount: input.selection.kept_count,
      ...(input.selection.not_applied_reason && {
        notAppliedReason: input.selection.not_applied_reason,
      }),
    };
  }
  return verdict;
}

/**
 * How sending the verdict went, for the terminal. `sent` is false both when
 * nothing was sent because nothing had to be (the feature is not enabled for
 * the repository, the binding predates the call) and when the request failed
 * -- `error` tells the two apart.
 */
export interface SessionVerdictResult {
  sent: boolean;
  /** The ids did not fit the request bound, so the counts went out alone. */
  truncated: boolean;
  error?: string;
}

/**
 * Write what this session concluded to Mergify. Never throws: a verdict that
 * did not land costs the next rerun its reduction and is reported in the
 * terminal; it never fails the run.
 */
export async function sendSessionVerdict(
  client: Partial<SessionVerdictClient>,
  verdict: SessionVerdict
): Promise<SessionVerdictResult> {
  // A stand-in, or a binding, predating the verdict: nothing to send it with.
  if (typeof client.sendSessionVerdict !== 'function') return { sent: false, truncated: false };
  try {
    const receipt = await client.sendSessionVerdict(verdict);
    // Dormant: the feature is not enabled for this repository.
    if (receipt === null) return { sent: false, truncated: false };
    return { sent: true, truncated: receipt.truncated };
  } catch (err) {
    return { sent: false, truncated: false, error: describeError(err) };
  }
}

/**
 * What the terminal says when the verdict did not reach Mergify whole.
 * Nothing on success: the selection block already describes the run, and the
 * verdict is how a retry of this batch gets its reduction. Wording validated
 * by Alexandre on 2026-09-15 (MRGFY-9313); a change here is a product
 * decision.
 */
export function formatSessionVerdictResult(result: SessionVerdictResult): string | undefined {
  if (result.error !== undefined) {
    return `${wrapText(
      "Mergify couldn't record this run's results. If this merge-queue batch is retried," +
        ' this job will run its full test suite.',
      80
    )}\nError: ${result.error}\n`;
  }
  if (result.truncated) {
    return `${wrapText(
      "Mergify recorded this run's counts but not its failing tests. If this merge-queue" +
        ' batch is retried, this job will run its full test suite.',
      80
    )}\n`;
  }
  return undefined;
}
