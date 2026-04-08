import type { Task } from '@vitest/runner';
import { VitestTestRunner } from 'vitest/runners';

export default class MergifyRunner extends VitestTestRunner {
  private quarantinedTests: Set<string>;

  constructor(config: ConstructorParameters<typeof VitestTestRunner>[0]) {
    super(config);
    const list = this.injectValue?.('mergify:quarantine') ?? [];
    this.quarantinedTests = new Set(list);
  }

  onAfterRunTask(test: Task): void {
    super.onAfterRunTask(test);

    if (test.result?.state === 'fail' && this.isQuarantined(test)) {
      test.result.state = 'pass';
      const meta = test.meta as Record<string, unknown>;
      meta.quarantined = true;
      meta.quarantineErrors = test.result.errors;
      test.result.errors = undefined;
    }
  }

  private isQuarantined(test: Task): boolean {
    return this.quarantinedTests.has(test.fullName);
  }
}
