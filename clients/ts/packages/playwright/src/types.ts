import type { SpanExporter } from '@opentelemetry/sdk-trace-base';

export interface MergifyReporterOptions {
  apiUrl?: string;
  token?: string;
  /** Injected exporter — bypasses CI and token checks (for testing). */
  exporter?: SpanExporter;
}
