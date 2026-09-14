import type { FlakyDetectionContext } from '@mergifyio/ci-native';
import type { MergifyApiClient } from './api.js';
import {
  computeNativeBudget,
  nativeStaticShareMs,
  shouldRunNativeFlakyDetection,
} from './native.js';
import { describeError } from './utils.js';

/**
 * The server's baseline and budget parameters. Re-exported from the binding's
 * generated types — the wire contract is defined once, in Rust, and shared
 * with pytest-mergify. The snake_case keys are the API's.
 */
export type { FlakyDetectionContext };

export type FlakyDetectionMode = 'new' | 'unhealthy';

/**
 * The flaky-detection context, or null when the feature is not usable for this
 * run.
 *
 * Null covers three cases the caller treats alike — the repository has not
 * opted in (dormant), the fetch failed (logged), or the budget engine says this
 * context and mode have nothing to do (`"new"` with an empty baseline, where
 * every test would look new and the whole suite would rerun). The run then
 * skips silently.
 */
export async function fetchFlakyDetectionContext(
  client: MergifyApiClient,
  mode: FlakyDetectionMode,
  logger: (msg: string) => void
): Promise<FlakyDetectionContext | null> {
  let context: FlakyDetectionContext | null;
  try {
    context = await client.fetchFlakyContext();
  } catch (err) {
    logger(`Failed to fetch flaky detection context: ${describeError(err)}`);
    return null;
  }

  if (context === null) return null;
  if (!shouldRunNativeFlakyDetection(context, mode)) return null;
  return context;
}

type TestMetrics = {
  outcomes: Set<string>;
  /**
   * Total number of attempts recorded for this test, including the initial
   * run. Used internally for budget checks. The public-facing "rerun count"
   * (exposed via `getRerunCount` and emitted as `cicd.test.rerun_count`)
   * excludes the initial — matching pytest-mergify and rspec-mergify.
   */
  attemptCount: number;
  initialDurationMs: number;
  tooSlow: boolean;
};

export class FlakyDetector {
  private context: FlakyDetectionContext;
  private mode: FlakyDetectionMode;
  private candidates: Set<string>;
  private budgetMs: number;
  private perTestDeadlineMs: number;
  private testMetrics: Map<string, TestMetrics> = new Map();
  private tooSlowTests: string[] = [];

  constructor(context: FlakyDetectionContext, mode: FlakyDetectionMode, allTestNames: string[]) {
    this.context = context;
    this.mode = mode;

    // Which tests this mode targets and how long the session may spend on them
    // are the shared engine's rules (`budget::plan`), so a vitest suite and a
    // pytest one facing the same context spend the same budget.
    const plan = computeNativeBudget(context, mode, allTestNames, []);

    // Over-length names are dropped here rather than by the engine, which keeps
    // them: pytest-mergify drops them later, inside its rerun loop. Same
    // session, different candidate count, so the two clients carve the budget
    // into different shares until that difference is settled.
    this.candidates = new Set(
      (plan?.testsToProcess ?? []).filter((t) => t.length <= context.max_test_name_length)
    );
    this.budgetMs = plan?.availableBudgetMs ?? 0;

    // Static per-test deadline (xdist-style)
    this.perTestDeadlineMs =
      this.candidates.size > 0 ? nativeStaticShareMs(this.budgetMs, this.candidates.size) : 0;
  }

  isCandidate(testName: string): boolean {
    return this.candidates.has(testName);
  }

  /** Returns a snapshot of the candidate set. Useful for diagnostics. */
  getCandidates(): ReadonlySet<string> {
    return this.candidates;
  }

  /**
   * Pure repeat-budget calculation. No side effects. Returns how many
   * additional runs (beyond the initial) fit in `perTestDeadlineMs` for a
   * test whose initial run took `durationMs`. Returns 0 when the test is too
   * slow to fit `min_test_execution_count` attempts.
   *
   * Suitable for orchestrators that need a global repeat-each value (e.g.
   * the Playwright subprocess that takes one `--repeat-each` for all
   * candidates) — pass the average phase-1 duration.
   */
  computeRepeatBudget(durationMs: number): number {
    if (durationMs * this.context.min_test_execution_count > this.perTestDeadlineMs) {
      return 0;
    }
    // -1 accounts for the initial run, which is part of perTestDeadlineMs.
    const maxByBudget = durationMs > 0 ? Math.floor(this.perTestDeadlineMs / durationMs) - 1 : 0;
    // -1 caps additional runs at max_test_execution_count - 1 (the initial counts).
    return Math.max(0, Math.min(maxByBudget, this.context.max_test_execution_count - 1));
  }

  /**
   * Calculate max repeats for a candidate test using its actual duration.
   * Side-effectful wrapper around `computeRepeatBudget` that records the
   * measured duration and flags the test as too-slow when applicable.
   */
  getMaxRepeats(testName: string, initialDurationMs: number): number {
    const metrics = this.getOrCreateMetrics(testName);
    metrics.initialDurationMs = initialDurationMs;
    const repeats = this.computeRepeatBudget(initialDurationMs);
    if (repeats === 0 && initialDurationMs > 0) {
      metrics.tooSlow = true;
      this.tooSlowTests.push(testName);
    }
    return repeats;
  }

  recordOutcome(testName: string, outcome: 'pass' | 'fail'): void {
    const metrics = this.getOrCreateMetrics(testName);
    metrics.outcomes.add(outcome);
    metrics.attemptCount++;
  }

  isFlaky(testName: string): boolean {
    const metrics = this.testMetrics.get(testName);
    if (!metrics) return false;
    return metrics.outcomes.has('pass') && metrics.outcomes.has('fail');
  }

  /**
   * Number of reruns beyond the initial attempt. Matches the
   * `cicd.test.rerun_count` semantics emitted by pytest-mergify and
   * rspec-mergify — the initial attempt is not counted.
   */
  getRerunCount(testName: string): number {
    const attempts = this.testMetrics.get(testName)?.attemptCount ?? 0;
    return Math.max(0, attempts - 1);
  }

  isTooSlow(testName: string): boolean {
    return this.testMetrics.get(testName)?.tooSlow ?? false;
  }

  /** Get summary data for the terminal report. */
  getSummary(): {
    mode: FlakyDetectionMode;
    budgetMs: number;
    candidateCount: number;
    rerunTests: Array<{ name: string; rerunCount: number; flaky: boolean; outcomes: string[] }>;
    tooSlowTests: string[];
  } {
    const rerunTests: Array<{
      name: string;
      rerunCount: number;
      flaky: boolean;
      outcomes: string[];
    }> = [];

    for (const [name, metrics] of this.testMetrics) {
      if (metrics.attemptCount > 0) {
        rerunTests.push({
          name,
          rerunCount: this.getRerunCount(name),
          flaky: this.isFlaky(name),
          outcomes: [...metrics.outcomes],
        });
      }
    }

    return {
      mode: this.mode,
      budgetMs: this.budgetMs,
      candidateCount: this.candidates.size,
      rerunTests,
      tooSlowTests: this.tooSlowTests,
    };
  }

  private getOrCreateMetrics(testName: string): TestMetrics {
    let metrics = this.testMetrics.get(testName);
    if (!metrics) {
      metrics = { outcomes: new Set(), attemptCount: 0, initialDurationMs: 0, tooSlow: false };
      this.testMetrics.set(testName, metrics);
    }
    return metrics;
  }
}
