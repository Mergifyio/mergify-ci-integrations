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
export type { TracingConfig, TracingContext } from './tracing.js';
export { createTracing, SynchronousBatchSpanProcessor } from './tracing.js';

// Types
export type { TestCaseError, TestCaseResult, TestRunSession } from './types.js';
export type { CIProvider } from './utils.js';
// Utilities
export {
  envToBool,
  extractNamespace,
  generateTestRunId,
  getCIProvider,
  getRepoName,
  getRepositoryNameFromUrl,
  git,
  isInCI,
  splitRepoName,
  strtobool,
} from './utils.js';
