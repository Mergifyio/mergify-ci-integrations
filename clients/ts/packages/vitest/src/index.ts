export type { TestCaseError, TestCaseResult, TestRunSession } from '@mergifyio/ci-core';
export { MergifyReporter, MergifyReporter as default } from './reporter.js';
export type { MergifyReporterOptions } from './types.js';
// The one way to name a test in this client. Anything that has to line up with
// what CI Insights stored — quarantine, flaky detection, test selection — must
// build its identifier here rather than reconstruct one; a second construction
// is exactly what let quarantine match a name the reporter never uploaded.
export { buildTestKey, type TestNameNode } from './utils.js';
