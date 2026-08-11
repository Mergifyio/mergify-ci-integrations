// Backend API client
export type { ApiClientConfig, MergifyApiClient } from './api.js';
export { createApiClient } from './api.js';
export type { FlakyDetectionContext, FlakyDetectionMode } from './flaky-detection.js';
// Flaky detection
export { FlakyDetector, fetchFlakyDetectionContext } from './flaky-detection.js';
export type { CiResourceAttributes } from './native.js';
// Quarantine
export { fetchQuarantineList } from './quarantine.js';
// Resource detection
export { detectResources } from './resources/index.js';
// Span helpers
export { emitTestCaseSpan, endSessionSpan, startSessionSpan } from './spans.js';
// Tracing
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
  isInCI,
  resolveBranchFromAttributes,
  splitRepoName,
  strtobool,
} from './utils.js';
