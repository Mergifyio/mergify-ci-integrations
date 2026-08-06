import type {
  FlakyDetectionContext,
  FlakyDetectionMode,
  MergifyApiClient,
} from '@mergifyio/ci-core';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';

export interface MergifyReporterOptions {
  apiUrl?: string;
  token?: string;
  exporter?: SpanExporter;
  /** Injected backend client — bypasses the bundled native one (for testing). */
  apiClient?: MergifyApiClient;
  quarantineList?: string[];
  flakyContext?: FlakyDetectionContext;
  flakyMode?: FlakyDetectionMode;
}
