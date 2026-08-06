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
export type { SessionSpan } from './spans.js';
export { emitTestCaseSpan, endSessionSpan, startSessionSpan } from './spans.js';
// Test identifier — the one construction every server-name match goes through
export { buildTestIdentifier, TEST_NAME_SEPARATOR } from './test-identifier.js';
// Test selection (reduced merge-queue reruns)
export type {
  TestSelection,
  TestSelectionApplication,
  TestSelectionClient,
  TestSelectionCoordinates,
} from './test-selection.js';
export {
  applyToCollected,
  fetchTestSelection,
  formatTestSelectionReport,
  isTestSelectionDisabled,
  resolveSelectionCoordinates,
  toTestSelection,
} from './test-selection.js';
// Trace context
export { msToUnixNano, newSpanId, newTraceId, parseTraceparent } from './trace-context.js';
// Tracing
export type { CapturedSpan, SpanSink, TracingConfig, TracingContext } from './tracing.js';
export {
  ClientSpanSink,
  ConsoleSpanSink,
  createTracing,
  InMemorySpanSink,
  toAttributeList,
} from './tracing.js';

// Types
export type {
  SpanAttributes,
  SpanAttributeValue,
  SpanStatus,
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
  strtobool,
} from './utils.js';
