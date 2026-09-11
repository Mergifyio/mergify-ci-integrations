import { createRequire } from 'node:module';
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
  'fetchQuarantine' | 'fetchFlakyContext' | 'fetchTestSelection' | 'uploadTrace'
>;

export interface ApiClientConfig {
  apiUrl: string;
  token: string;
  /** The repository as `owner/repo`. */
  repoName: string;
  /**
   * The npm package building the client, e.g. `@mergifyio/vitest`, reported in
   * the `User-Agent`. Its version is not asked for: see [`packageVersion`].
   */
  clientName: string;
}

/**
 * The version reported in the `User-Agent`, for whichever plugin is calling.
 *
 * Read from this package's own package.json rather than the plugin's: the TS
 * packages release together under one version, and `pnpm pack` pins every
 * `workspace:*` dependency to it exactly, so `@mergifyio/vitest@X` always runs
 * on `@mergifyio/ci-core@X`. The checked-in `0.0.0` is a placeholder the release
 * stamps. `../package.json` resolves the same from `src/` and the bundled
 * `dist/` — both sit one level below the package root.
 */
function packageVersion(): string {
  try {
    const pkg = createRequire(import.meta.url)('../package.json') as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Build a client over the bundled Rust binding, or null when the platform has
 * no prebuilt binary or `repoName` is not an `owner/repo` pair. Null is the
 * fail-open path: without a client the backend features stay off rather than
 * breaking the test run.
 *
 * Returns the binding's whole surface, not the [`MergifyApiClient`] seam: the
 * factory really does build every method, and a caller that needs one outside
 * that seam should not have to widen a type the factory already satisfies.
 * Anything expecting a [`MergifyApiClient`] still accepts the result.
 */
export function createApiClient(config: ApiClientConfig): CiApiClient | null {
  return createNativeApiClient({
    apiUrl: config.apiUrl,
    token: config.token,
    repoName: config.repoName,
    clientName: config.clientName,
    clientVersion: packageVersion(),
    nodeVersion: process.versions.node,
  });
}
