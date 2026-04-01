export interface TestCaseError {
  type: string;
  message: string;
  stacktrace: string;
}

export interface TestCaseResult {
  /** Relative file path (TestModule.relativeModuleId) */
  filepath: string;
  /** Absolute file path (TestModule.moduleId) */
  absoluteFilepath: string;
  /** Test name (TestCase.name) */
  function: string;
  /** Line number in the file (requires includeTaskLocation) */
  lineno: number;
  /** Parent suite chain (derived from fullName) */
  namespace: string;

  scope: 'case';
  status: 'passed' | 'failed' | 'skipped';

  error?: TestCaseError;

  /** Duration in ms */
  duration: number;
  /** Start time in ms */
  startTime: number;
  /** Number of retries */
  retryCount: number;
  /** Whether the test passed on a retry (flaky) */
  flaky: boolean;
}

export interface TestRunSession {
  /** 16-char hex ID (8 random bytes), matching Mergify CI Insights API format */
  testRunId: string;
  scope: 'session';
  startTime: number;
  endTime?: number;
  status: 'passed' | 'failed' | 'interrupted';
  testCases: TestCaseResult[];
}
