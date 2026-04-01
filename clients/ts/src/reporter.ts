import type { Reporter, TestCase, TestModule, Vitest } from 'vitest/node';
import type { TestCaseResult, TestRunSession } from './types.js';
import { extractNamespace, generateTestRunId } from './utils.js';

export class MergifyReporter implements Reporter {
  private vitest: Vitest | undefined;
  private session: TestRunSession | undefined;

  onInit(vitest: Vitest): void {
    this.vitest = vitest;
    vitest.config.includeTaskLocation = true;
  }

  onTestRunStart(): void {
    this.session = {
      testRunId: generateTestRunId(),
      scope: 'session',
      startTime: Date.now(),
      status: 'passed',
      testCases: [],
    };
  }

  onTestCaseResult(testCase: TestCase): void {
    if (!this.session) return;

    const result = testCase.result();
    if (result.state === 'pending') return;

    const diagnostic = testCase.diagnostic();
    const module = testCase.module;

    const testCaseResult: TestCaseResult = {
      filepath: module.relativeModuleId,
      absoluteFilepath: module.moduleId,
      function: testCase.name,
      lineno: testCase.location?.line ?? 0,
      namespace: extractNamespace(testCase.fullName, testCase.name),
      scope: 'case',
      status: result.state,
      duration: diagnostic?.duration ?? 0,
      startTime: diagnostic?.startTime ?? 0,
      retryCount: diagnostic?.retryCount ?? 0,
      flaky: diagnostic?.flaky ?? false,
    };

    if (result.state === 'failed' && result.errors?.length) {
      const firstError = result.errors[0];
      testCaseResult.error = {
        type: firstError.name ?? 'Error',
        message: firstError.message ?? '',
        stacktrace: firstError.stack ?? '',
      };
    }

    this.session.testCases.push(testCaseResult);
  }

  onTestRunEnd(
    _testModules: ReadonlyArray<TestModule>,
    _unhandledErrors: ReadonlyArray<unknown>,
    reason: 'passed' | 'failed' | 'interrupted'
  ): void {
    if (!this.session) return;

    this.session.endTime = Date.now();
    this.session.status = reason;
  }

  getSession(): TestRunSession | undefined {
    return this.session;
  }
}
