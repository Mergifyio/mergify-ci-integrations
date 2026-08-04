import type { FlakyDetectionContext, FlakyDetectionMode } from '@mergifyio/ci-core';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';

export interface MergifyReporterOptions {
  apiUrl?: string;
  token?: string;
  exporter?: SpanExporter;
  quarantineList?: string[];
  flakyContext?: FlakyDetectionContext;
  flakyMode?: FlakyDetectionMode;
}
