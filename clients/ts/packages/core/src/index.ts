// Backend API client
export type { ApiClientConfig, MergifyApiClient, SessionVerdictClient } from './api.js';
export { createApiClient } from './api.js';
export type { FlakyDetectionContext, FlakyDetectionMode } from './flaky-detection.js';
// Flaky detection
export { FlakyDetector, fetchFlakyDetectionContext } from './flaky-detection.js';
export type { CiResourceAttributes } from './native.js';
export { nativeTestCollectionFingerprint } from './native.js';
// Quarantine
export { fetchQuarantineList } from './quarantine.js';
// Resource detection
export { detectResources } from './resources/index.js';
// Session verdict (what the run concluded, written before the trace upload)
export type { FinalStatus, SessionVerdictInput, SessionVerdictResult } from './session-verdict.js';
export {
  buildSessionVerdict,
  formatSessionVerdictResult,
  SessionVerdictFold,
  sendSessionVerdict,
} from './session-verdict.js';
// Span helpers
export type { SessionSpan } from './spans.js';
export { emitTestCaseSpan, endSessionSpan, startSessionSpan } from './spans.js';
// Test identifier — the one construction every server-name match goes through
export { buildTestIdentifier, TEST_NAME_SEPARATOR } from './test-identifier.js';
// Test selection (reduced merge-queue reruns)
export type {
  NotAppliedReason,
  TestCollection,
  TestSelection,
  TestSelectionAnswer,
  TestSelectionApplication,
  TestSelectionClient,
  TestSelectionClientIdentity,
  TestSelectionCoordinates,
  TestSelectionEcho,
} from './test-selection.js';
export {
  applyToCollected,
  fallbackRefusalMessage,
  fetchTestSelection,
  formatTestSelectionReport,
  isTestSelectionEnabled,
  resolveSelectionCoordinates,
  selectionEcho,
  selectionResourceAttributes,
  TEST_SELECTION_ENABLE_ENV,
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
  wrapText,
} from './utils.js';
