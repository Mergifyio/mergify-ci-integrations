// Tracing

export type {
  FlakyDetectionConfig,
  FlakyDetectionContext,
  FlakyDetectionMode,
} from './flaky-detection.js';
// Flaky detection
export { FlakyDetector, fetchFlakyDetectionContext } from './flaky-detection.js';
export type { QuarantineConfig } from './quarantine.js';

// Quarantine
export { fetchQuarantineList } from './quarantine.js';
// Resource detection
export { detectResources } from './resources/index.js';
// Span helpers
export { emitTestCaseSpan, endSessionSpan, startSessionSpan } from './spans.js';
export type { TracingConfig, TracingContext } from './tracing.js';
export { createTracing, SynchronousBatchSpanProcessor } from './tracing.js';

// Types
export type {
  TestCaseError,
  TestCaseFlakyDetection,
  TestCaseResult,
  TestRunSession,
} from './types.js';
export type { CIProvider } from './utils.js';
// Utilities
export {
  envToBool,
  generateTestRunId,
  getCIProvider,
  getRepoName,
  getRepositoryNameFromUrl,
  git,
  isInCI,
  resolveBranchFromAttributes,
  splitRepoName,
  strtobool,
} from './utils.js';
