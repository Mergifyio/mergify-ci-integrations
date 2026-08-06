import type { CiApiClient } from '@mergifyio/ci-native';
import { createNativeApiClient } from './native.js';

/**
 * The backend surface `@mergifyio/ci-core` uses, as implemented by the bundled
 * Rust client. Structurally a subset of the binding's generated `CiApiClient`,
 * so the Rust-generated types stay the single source of truth — but named
 * separately because it is also the injection seam: plugins accept one of these
 * so tests can hand in a stand-in without a network or a `.node` binary.
 *
 * Every fetch is tri-state: the value, `null` when the server says the feature
 * is not enabled for the repository (a dormant `402`/`404`), and a rejection on
 * a genuine failure. `uploadTrace` fails loud.
 */
export type MergifyApiClient = Pick<
  CiApiClient,
  'fetchQuarantine' | 'fetchFlakyContext' | 'uploadTrace'
>;

export interface ApiClientConfig {
  apiUrl: string;
  token: string;
  /** The repository as `owner/repo`. */
  repoName: string;
  /** The npm package building the client, e.g. `@mergifyio/vitest`. */
  clientName: string;
  /** That package's version, reported in the `User-Agent`. */
  clientVersion: string;
}

/**
 * Build a client over the bundled Rust binding, or null when the platform has
 * no prebuilt binary or `repoName` is not an `owner/repo` pair. Null is the
 * fail-open path: without a client the backend features stay off rather than
 * breaking the test run.
 */
export function createApiClient(config: ApiClientConfig): MergifyApiClient | null {
  return createNativeApiClient({
    apiUrl: config.apiUrl,
    token: config.token,
    repoName: config.repoName,
    clientName: config.clientName,
    clientVersion: config.clientVersion,
    nodeVersion: process.versions.node,
  });
}
