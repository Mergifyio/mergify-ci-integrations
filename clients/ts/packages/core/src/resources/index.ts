import { detectNativeAttributes } from '../native.js';
import type { SpanAttributes } from '../types.js';

/**
 * The run's OTLP resource attributes: what the Rust core detected about the CI
 * environment, the framework's own identity, and this run's id.
 */
export function detectResources(
  frameworkAttributes: SpanAttributes,
  testRunId: string
): SpanAttributes {
  return {
    ...(detectNativeAttributes() as SpanAttributes),
    ...frameworkAttributes,
    'test.run.id': testRunId,
  };
}
