export interface TestCaseError {
  type: string;
  message: string;
  stacktrace: string;
}

export interface TestCaseFlakyDetection {
  new: boolean;
  flaky: boolean;
  rerunCount: number;
}

export interface TestCaseResult {
  /** Relative file path (e.g. Vitest TestModule.relativeModuleId) */
  filepath: string;
  /** Absolute file path (e.g. Vitest TestModule.moduleId) */
  absoluteFilepath: string;
  /** Test name (e.g. Vitest TestCase.name) */
  function: string;
  /** Line number in the file (Vitest requires includeTaskLocation) */
  lineno: number;
  /** Parent suite chain (e.g. derived from Vitest fullName) */
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
  /** Whether the test passed on a retry (native framework flaky) */
  flaky: boolean;

  /** Framework sub-identity (Playwright project name). Optional. */
  project?: string;
  /** Whether the test is quarantined. Set by Vitest runner when the quarantine feature is active. */
  quarantined?: boolean;
  /** Flaky-detection metadata. Set by Vitest runner when flaky detection is active. */
  flakyDetection?: TestCaseFlakyDetection;
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
