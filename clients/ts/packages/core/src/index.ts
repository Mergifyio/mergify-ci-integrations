// Tracing
export { createTracing, SynchronousBatchSpanProcessor } from './tracing.js';
export type { TracingConfig, TracingContext } from './tracing.js';

// Resource detection
export { detectResources } from './resources/index.js';

// Quarantine
export { fetchQuarantineList } from './quarantine.js';
export type { QuarantineConfig } from './quarantine.js';

// Flaky detection
export { FlakyDetector, fetchFlakyDetectionContext } from './flaky-detection.js';
export type {
  FlakyDetectionConfig,
  FlakyDetectionContext,
  FlakyDetectionMode,
} from './flaky-detection.js';

// Types
export type { TestCaseError, TestCaseResult, TestRunSession } from './types.js';

// Utilities
export {
  envToBool,
  extractNamespace,
  generateTestRunId,
  getCIProvider,
  getRepositoryNameFromUrl,
  git,
  isInCI,
  splitRepoName,
  strtobool,
} from './utils.js';
export type { CIProvider } from './utils.js';
