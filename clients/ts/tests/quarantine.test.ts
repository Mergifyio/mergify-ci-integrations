import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchQuarantineList } from '../src/quarantine.js';

describe('fetchQuarantineList', () => {
  const mockFetch = vi.fn();
  const logger = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const config = {
    apiUrl: 'https://api.mergify.com',
    token: 'test-token',
    repoName: 'owner/repo',
    branch: 'main',
  };

  it('parses quarantine list from API response', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        quarantined_tests: [{ test_name: 'suite > test A' }, { test_name: 'suite > test B' }],
      }),
    });

    const list = await fetchQuarantineList(config, logger);

    expect(list).toEqual(new Set(['suite > test A', 'suite > test B']));
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.mergify.com/v1/ci/owner/repositories/repo/quarantines?branch=main',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-token' },
      })
    );
  });

  it('returns empty set on 402 (no subscription)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 402 });

    const list = await fetchQuarantineList(config, logger);
    expect(list).toEqual(new Set());
  });

  it('returns empty set and warns on other HTTP errors', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    const list = await fetchQuarantineList(config, logger);
    expect(list).toEqual(new Set());
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('HTTP 500'));
  });

  it('returns empty set and warns on network error', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const list = await fetchQuarantineList(config, logger);
    expect(list).toEqual(new Set());
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('Network error'));
  });

  it('encodes branch name in URL', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ quarantined_tests: [] }),
    });

    await fetchQuarantineList({ ...config, branch: 'feature/my branch' }, logger);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('branch=feature%2Fmy%20branch'),
      expect.anything()
    );
  });
});
