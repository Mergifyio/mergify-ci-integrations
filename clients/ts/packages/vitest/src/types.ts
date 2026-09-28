import type {
  FlakyDetectionContext,
  FlakyDetectionMode,
  MergifyApiClient,
  SessionVerdictClient,
  SpanSink,
  TestSelectionClient,
} from '@mergifyio/ci-core';

/**
 * The backend client the reporter talks to. The two test-selection calls are
 * optional so a stand-in written before they existed still satisfies the
 * type; without them, the full suite runs and no verdict is sent.
 */
export type MergifyApiClientStandIn = MergifyApiClient &
  Partial<TestSelectionClient> &
  Partial<SessionVerdictClient>;

export interface MergifyReporterOptions {
  apiUrl?: string;
  token?: string;
  /** Injected span sink — bypasses CI and token checks (for testing). */
  sink?: SpanSink;
  /**
   * Injected backend client — bypasses the bundled native one (for testing).
   * `fetchTestSelection` is optional so a stand-in written before test
   * selection existed still satisfies the type; without it, the full suite runs.
   */
  apiClient?: MergifyApiClientStandIn;
  quarantineList?: string[];
  flakyContext?: FlakyDetectionContext;
  flakyMode?: FlakyDetectionMode;
  /**
   * A served subset, bypassing the fetch (for testing). Pass the identifiers
   * exactly as this client uploads them — `describe > test`, no file path.
   */
  testSelection?: string[];
}
