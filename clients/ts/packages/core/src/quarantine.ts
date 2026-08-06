import type { MergifyApiClient } from './api.js';
import { describeError } from './utils.js';

/**
 * The quarantined test names for `branch`.
 *
 * Soft by contract: the caller gets an empty set whether quarantine is dormant
 * (no subscription) or the fetch failed outright, with the reason logged. The
 * two are deliberately indistinguishable downstream — a run is never failed
 * over quarantine being unavailable. Pagination, the `Link` header walk, and
 * cycle detection all live in the Rust client.
 */
export async function fetchQuarantineList(
  client: MergifyApiClient,
  branch: string,
  logger: (msg: string) => void
): Promise<Set<string>> {
  try {
    const names = await client.fetchQuarantine(branch);
    if (names === null) {
      logger('Quarantine not available (no subscription)');
      return new Set();
    }
    return new Set(names);
  } catch (err) {
    logger(`Failed to fetch quarantine list: ${describeError(err)}`);
    return new Set();
  }
}
