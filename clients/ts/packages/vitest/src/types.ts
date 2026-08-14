import type {
  FlakyDetectionContext,
  FlakyDetectionMode,
  MergifyApiClient,
  TestSelectionClient,
} from '@mergifyio/ci-core';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';

export interface MergifyReporterOptions {
  apiUrl?: string;
  token?: string;
  exporter?: SpanExporter;
  /**
   * Injected backend client — bypasses the bundled native one (for testing).
   * `fetchTestSelection` is optional so a stand-in written before test
   * selection existed still satisfies the type; without it, the full suite runs.
   */
  apiClient?: MergifyApiClient & Partial<TestSelectionClient>;
  quarantineList?: string[];
  flakyContext?: FlakyDetectionContext;
  flakyMode?: FlakyDetectionMode;
  /**
   * A served subset, bypassing the fetch (for testing). Pass the identifiers
   * exactly as this client uploads them — `describe > test`, no file path.
   */
  testSelection?: string[];
}
