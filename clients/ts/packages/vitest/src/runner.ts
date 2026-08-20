import {
  type FlakyDetectionContext,
  type FlakyDetectionMode,
  FlakyDetector,
} from '@mergifyio/ci-core';
import type { File, Suite, Task, Test } from '@vitest/runner';
import { VitestTestRunner } from 'vitest/runners';
import { buildTestKey } from './utils.js';

export default class MergifyRunner extends VitestTestRunner {
  private selectedTests: Set<string> | null;
  private quarantinedTests: Set<string>;
  private flakyDetector: FlakyDetector | null = null;
  private flakyMode: FlakyDetectionMode | null = null;
  private _flakyContext: FlakyDetectionContext | null = null;
  private _flakyInitialized = false;

  constructor(config: ConstructorParameters<typeof VitestTestRunner>[0]) {
    super(config);

    // Read the served subset from ProvidedContext. Absent means "run
    // everything": the reporter only provides it once it has resolved a
    // genuine `subset` answer, so every degraded path arrives here as null.
    const selection = this.injectValue?.('mergify:selection') as string[] | undefined;
    this.selectedTests = selection ? new Set(selection) : null;

    // Read quarantine list from ProvidedContext
    const quarantineList = this.injectValue?.('mergify:quarantine') ?? [];
    this.quarantinedTests = new Set(quarantineList);

    // Read flaky detection context from ProvidedContext
    const flakyContext = this.injectValue?.('mergify:flakyContext');
    const flakyMode = this.injectValue?.('mergify:flakyMode');

    if (flakyContext && flakyMode) {
      this.flakyMode = flakyMode;
      // We'll initialize the FlakyDetector once we know all test names
      // Store context for lazy initialization
      this._flakyContext = flakyContext;
    }
  }

  /**
   * Drop every collected test outside the served subset.
   *
   * Vitest calls this after `collectTests` — which is where `interpretTaskModes`
   * applies `--testNamePattern`, `testIds`, tag filters and `.only` — and before
   * anything executes. Narrowing here therefore lands strictly after the user's
   * own filters, and since it only ever assigns `skip` it can shrink their
   * selection but never widen it. That ordering is structural, not a convention
   * this class has to remember.
   *
   * Deselected tests are marked so the reporter can leave them out of the
   * upload entirely: a test that was never executed is not a skipped test, and
   * reporting it as one would feed the server's per-test health statistics a
   * result no run produced.
   */
  onCollected(files: File[]): void {
    if (!this.selectedTests) return;
    for (const file of files) this.deselectOutsideSubset(file);
  }

  private deselectOutsideSubset(suite: Suite): void {
    for (const task of suite.tasks) {
      if (task.type === 'suite') {
        this.deselectOutsideSubset(task);
      } else if (task.mode === 'run' && !this.selectedTests?.has(buildTestKey(task))) {
        task.mode = 'skip';
        (task.meta as Record<string, unknown>).mergifyDeselected = true;
      }
    }
  }

  private ensureFlakyDetector(test: Task): void {
    if (this._flakyInitialized || !this._flakyContext || !this.flakyMode) return;
    this._flakyInitialized = true;

    // Collect all test names from the file
    const allTestNames = this.collectTestNames(test.file!);
    this.flakyDetector = new FlakyDetector(this._flakyContext, this.flakyMode, allTestNames);
  }

  private collectTestNames(suite: Suite): string[] {
    const names: string[] = [];
    for (const task of suite.tasks) {
      if (task.type === 'test') {
        names.push(buildTestKey(task));
      } else if (task.type === 'suite') {
        names.push(...this.collectTestNames(task));
      }
    }
    return names;
  }

  async onBeforeRunTask(test: Task): Promise<void> {
    await super.onBeforeRunTask(test);

    this.ensureFlakyDetector(test);

    const name = buildTestKey(test);
    if (this.flakyDetector?.isCandidate(name)) {
      // Calculate repeats upfront using estimated duration.
      // Vitest captures test.repeats into a local const at the start of its
      // repeat loop, so adjusting it mid-loop (e.g. in onAfterTryTask) has no
      // effect. We must set the final value here before the loop begins.
      const estimatedDuration = this._flakyContext!.existing_tests_mean_duration_ms;
      const maxRepeats = this.flakyDetector.getMaxRepeats(name, estimatedDuration);
      (test as { repeats?: number }).repeats = maxRepeats;
    }
  }

  onAfterTryTask(test: Test): void {
    super.onAfterTryTask(test);

    if (!this.flakyDetector) return;

    const name = buildTestKey(test);
    if (!this.flakyDetector.isCandidate(name)) return;

    const outcome = test.result?.state === 'fail' ? 'fail' : 'pass';
    this.flakyDetector.recordOutcome(name, outcome);
  }

  onAfterRunTask(test: Task): void {
    super.onAfterRunTask(test);

    const name = buildTestKey(test);
    const originalState = test.result?.state;

    // Flaky detection: set meta attributes (before quarantine to use original state)
    if (this.flakyDetector?.isCandidate(name)) {
      const meta = test.meta as Record<string, unknown>;
      meta.flakyDetection = true;
      meta.isNew = this.flakyMode === 'new';
      meta.rerunCount = this.flakyDetector.getRerunCount(name);
      meta.flaky = this.flakyDetector.isFlaky(name);
      meta.tooSlow = this.flakyDetector.isTooSlow(name);

      // In "unhealthy" mode, absorb failures (similar to quarantine)
      if (this.flakyMode === 'unhealthy' && originalState === 'fail') {
        test.result!.state = 'pass';
        meta.absorbedFailure = true;
      }
    }

    // Quarantine: rewrite failed quarantined tests to pass
    if (originalState === 'fail' && this.quarantinedTests.has(name)) {
      test.result!.state = 'pass';
      const meta = test.meta as Record<string, unknown>;
      meta.quarantined = true;
      meta.quarantineErrors = test.result!.errors;
      test.result!.errors = undefined;
    }
  }
}
