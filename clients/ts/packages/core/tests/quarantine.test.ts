import { describe, expect, it, vi } from 'vitest';
import type { MergifyApiClient } from '../src/api.js';
import { fetchQuarantineList } from '../src/quarantine.js';

// Pagination, `Link` header parsing, cycle detection and HTTP status handling
// all live in the Rust client now and are tested there. What is left here is
// the fail-open mapping: three client outcomes onto one `Set`.
function client(fetchQuarantine: MergifyApiClient['fetchQuarantine']): MergifyApiClient {
  return {
    fetchQuarantine,
    fetchFlakyContext: vi.fn(),
    uploadTrace: vi.fn(),
  };
}

describe('fetchQuarantineList', () => {
  it('collects the names the client returns', async () => {
    const logger = vi.fn();

    const list = await fetchQuarantineList(
      client(async () => ['suite > test A', 'suite > test B']),
      'main',
      logger
    );

    expect(list).toEqual(new Set(['suite > test A', 'suite > test B']));
    expect(logger).not.toHaveBeenCalled();
  });

  it('passes the branch through to the client', async () => {
    const fetchQuarantine = vi.fn().mockResolvedValue([]);

    await fetchQuarantineList(client(fetchQuarantine), 'release/1.2', vi.fn());

    expect(fetchQuarantine).toHaveBeenCalledWith('release/1.2');
  });

  it('reports an empty set when quarantine is dormant', async () => {
    const logger = vi.fn();

    const list = await fetchQuarantineList(
      client(async () => null),
      'main',
      logger
    );

    expect(list).toEqual(new Set());
    expect(logger).toHaveBeenCalledWith('Quarantine not available (no subscription)');
  });

  it('logs the failure and degrades to an empty set', async () => {
    const logger = vi.fn();

    const list = await fetchQuarantineList(
      client(async () => {
        throw new Error('Mergify API returned HTTP 500');
      }),
      'main',
      logger
    );

    expect(list).toEqual(new Set());
    expect(logger).toHaveBeenCalledWith(
      'Failed to fetch quarantine list: Mergify API returned HTTP 500'
    );
  });
});
