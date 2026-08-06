import type { MergifyApiClient } from '@mergifyio/ci-core';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';

export interface MergifyReporterOptions {
  apiUrl?: string;
  token?: string;
  /** Injected exporter — bypasses CI and token checks (for testing). */
  exporter?: SpanExporter;
  /** Injected backend client — bypasses the bundled native one (for testing). */
  apiClient?: MergifyApiClient;
}
