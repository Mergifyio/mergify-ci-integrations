import { splitRepoName } from './utils.js';

export type FlakyDetectionContext = {
  budget_ratio_for_new_tests: number;
  budget_ratio_for_unhealthy_tests: number;
  existing_test_names: string[];
  existing_tests_mean_duration_ms: number;
  unhealthy_test_names: string[];
  max_test_execution_count: number;
  max_test_name_length: number;
  min_budget_duration_ms: number;
  min_test_execution_count: number;
};

export type FlakyDetectionMode = 'new' | 'unhealthy';

export type FlakyDetectionConfig = {
  apiUrl: string;
  token: string;
  repoName: string;
};

export async function fetchFlakyDetectionContext(
  config: FlakyDetectionConfig,
  logger: (msg: string) => void
): Promise<FlakyDetectionContext | null> {
  const { owner, repo } = splitRepoName(config.repoName);
  const url = `${config.apiUrl}/v1/ci/${owner}/repositories/${repo}/flaky-detection-context`;

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 402) {
      logger('Flaky detection not available (no subscription)');
      return null;
    }

    if (!response.ok) {
      logger(`Failed to fetch flaky detection context: HTTP ${response.status}`);
      return null;
    }

    return (await response.json()) as FlakyDetectionContext;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      logger('Flaky detection API request timed out');
    } else {
      logger(`Failed to fetch flaky detection context: ${err}`);
    }
    return null;
  }
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
  private existingTestsInSession: Set<string>;
  private budgetMs: number;
  private perTestDeadlineMs: number;
  private testMetrics: Map<string, TestMetrics> = new Map();
  private tooSlowTests: string[] = [];

  constructor(context: FlakyDetectionContext, mode: FlakyDetectionMode, allTestNames: string[]) {
    this.context = context;
    this.mode = mode;

    const existingSet = new Set(context.existing_test_names);
    const unhealthySet = new Set(context.unhealthy_test_names);

    // Count existing tests in this session for budget calculation
    this.existingTestsInSession = new Set(allTestNames.filter((t) => existingSet.has(t)));

    // Identify candidates based on mode
    if (mode === 'new') {
      this.candidates = new Set(
        allTestNames.filter((t) => !existingSet.has(t) && t.length <= context.max_test_name_length)
      );
    } else {
      this.candidates = new Set(
        allTestNames.filter((t) => unhealthySet.has(t) && t.length <= context.max_test_name_length)
      );
    }

    // Calculate budget
    const budgetRatio =
      mode === 'new'
        ? context.budget_ratio_for_new_tests
        : context.budget_ratio_for_unhealthy_tests;
    const totalDurationMs =
      context.existing_tests_mean_duration_ms * this.existingTestsInSession.size;
    this.budgetMs = Math.max(budgetRatio * totalDurationMs, context.min_budget_duration_ms);

    // Static per-test deadline (xdist-style)
    this.perTestDeadlineMs = this.candidates.size > 0 ? this.budgetMs / this.candidates.size : 0;
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
