import type {
  FlakyDetectionContext,
  FlakyDetectionMode,
  MergifyApiClient,
  SpanSink,
} from '@mergifyio/ci-core';

export interface MergifyReporterOptions {
  apiUrl?: string;
  token?: string;
  /** Injected span sink — bypasses CI and token checks (for testing). */
  sink?: SpanSink;
  /** Injected backend client — bypasses the bundled native one (for testing). */
  apiClient?: MergifyApiClient;
  quarantineList?: string[];
  flakyContext?: FlakyDetectionContext;
  flakyMode?: FlakyDetectionMode;
}
