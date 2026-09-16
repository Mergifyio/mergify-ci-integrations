import { detectNativeAttributes } from '../native.js';
import type { SpanAttributes } from '../types.js';

/**
 * The run's OTLP resource attributes: what the Rust core detected about the CI
 * environment, the framework's own identity, the language, and this run's id.
 */
export function detectResources(
  frameworkAttributes: SpanAttributes,
  testRunId: string
): SpanAttributes {
  return {
    ...(detectNativeAttributes() as SpanAttributes),
    ...frameworkAttributes,
    // Mergify takes a test's language from here when the span does not name
    // one. OpenTelemetry SDK 1.x added it from its default resource; 2.x stopped
    // merging that in, and the SDK is gone now, so nothing sets it but this.
    'telemetry.sdk.language': 'nodejs',
    'test.run.id': testRunId,
  };
}
