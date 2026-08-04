import {
  type FlakyDetectionContext,
  type FlakyDetectionMode,
  FlakyDetector,
} from '@mergifyio/ci-core';
import type { Suite, Task, Test } from '@vitest/runner';
import { VitestTestRunner } from 'vitest/runners';

export default class MergifyRunner extends VitestTestRunner {
  private quarantinedTests: Set<string>;
  private flakyDetector: FlakyDetector | null = null;
  private flakyMode: FlakyDetectionMode | null = null;
  private _flakyContext: FlakyDetectionContext | null = null;
  private _flakyInitialized = false;

  constructor(config: ConstructorParameters<typeof VitestTestRunner>[0]) {
    super(config);

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
        names.push(task.fullName);
      } else if (task.type === 'suite') {
        names.push(...this.collectTestNames(task));
      }
    }
    return names;
  }

  async onBeforeRunTask(test: Task): Promise<void> {
    await super.onBeforeRunTask(test);

    this.ensureFlakyDetector(test);

    if (this.flakyDetector?.isCandidate(test.fullName)) {
      // Calculate repeats upfront using estimated duration.
      // Vitest captures test.repeats into a local const at the start of its
      // repeat loop, so adjusting it mid-loop (e.g. in onAfterTryTask) has no
      // effect. We must set the final value here before the loop begins.
      const estimatedDuration = this._flakyContext!.existing_tests_mean_duration_ms;
      const maxRepeats = this.flakyDetector.getMaxRepeats(test.fullName, estimatedDuration);
      (test as { repeats?: number }).repeats = maxRepeats;
    }
  }

  onAfterTryTask(test: Test): void {
    super.onAfterTryTask(test);

    if (!this.flakyDetector) return;

    const fullName = test.fullName;
    if (!this.flakyDetector.isCandidate(fullName)) return;

    const outcome = test.result?.state === 'fail' ? 'fail' : 'pass';
    this.flakyDetector.recordOutcome(fullName, outcome);
  }

  onAfterRunTask(test: Task): void {
    super.onAfterRunTask(test);

    const fullName = test.fullName;
    const originalState = test.result?.state;

    // Flaky detection: set meta attributes (before quarantine to use original state)
    if (this.flakyDetector?.isCandidate(fullName)) {
      const meta = test.meta as Record<string, unknown>;
      meta.flakyDetection = true;
      meta.isNew = this.flakyMode === 'new';
      meta.rerunCount = this.flakyDetector.getRerunCount(fullName);
      meta.flaky = this.flakyDetector.isFlaky(fullName);
      meta.tooSlow = this.flakyDetector.isTooSlow(fullName);

      // In "unhealthy" mode, absorb failures (similar to quarantine)
      if (this.flakyMode === 'unhealthy' && originalState === 'fail') {
        test.result!.state = 'pass';
        meta.absorbedFailure = true;
      }
    }

    // Quarantine: rewrite failed quarantined tests to pass
    if (originalState === 'fail' && this.isQuarantined(test)) {
      test.result!.state = 'pass';
      const meta = test.meta as Record<string, unknown>;
      meta.quarantined = true;
      meta.quarantineErrors = test.result!.errors;
      test.result!.errors = undefined;
    }
  }

  private isQuarantined(test: Task): boolean {
    return this.quarantinedTests.has(test.fullName);
  }
}
