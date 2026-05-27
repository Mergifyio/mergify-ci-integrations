import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchQuarantineList } from '../src/quarantine.js';

describe('fetchQuarantineList', () => {
  const mockFetch = vi.fn();
  const logger = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    logger.mockReset();
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

  function singlePageResponse(testNames: string[]) {
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        quarantined_tests: testNames.map((name) => ({ test_name: name })),
      }),
    };
  }

  function pageResponse(testNames: string[], nextUrl: string) {
    return {
      ok: true,
      status: 200,
      headers: new Headers({ Link: `<${nextUrl}>; rel="next"` }),
      json: async () => ({
        quarantined_tests: testNames.map((name) => ({ test_name: name })),
      }),
    };
  }

  it('parses quarantine list from API response', async () => {
    mockFetch.mockResolvedValue(singlePageResponse(['suite > test A', 'suite > test B']));

    const list = await fetchQuarantineList(config, logger);

    expect(list).toEqual(new Set(['suite > test A', 'suite > test B']));
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.mergify.com/v1/ci/owner/repositories/repo/quarantines?branch=main&per_page=100',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-token' },
      })
    );
  });

  it('walks paginated pages until the next link is exhausted', async () => {
    const base = 'https://api.mergify.com/v1/ci/owner/repositories/repo/quarantines';
    mockFetch
      .mockResolvedValueOnce(pageResponse(['a', 'b'], `${base}?cursor=PAGE2&per_page=100`))
      .mockResolvedValueOnce(pageResponse(['c'], `${base}?cursor=PAGE3&per_page=100`))
      .mockResolvedValueOnce(singlePageResponse(['d']));

    const list = await fetchQuarantineList(config, logger);

    expect(list).toEqual(new Set(['a', 'b', 'c', 'd']));
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      `${base}?branch=main&per_page=100`,
      expect.anything()
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      `${base}?cursor=PAGE2&per_page=100`,
      expect.anything()
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      3,
      `${base}?cursor=PAGE3&per_page=100`,
      expect.anything()
    );
  });

  it('does not leak partial results when a later page fails', async () => {
    const base = 'https://api.mergify.com/v1/ci/owner/repositories/repo/quarantines';
    mockFetch
      .mockResolvedValueOnce(pageResponse(['a'], `${base}?cursor=PAGE2&per_page=100`))
      .mockResolvedValueOnce({ ok: false, status: 500, headers: new Headers() });

    const list = await fetchQuarantineList(config, logger);

    expect(list).toEqual(new Set());
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('HTTP 500'));
  });

  it('returns empty set on 402 (no subscription)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 402, headers: new Headers() });

    const list = await fetchQuarantineList(config, logger);
    expect(list).toEqual(new Set());
  });

  it('returns empty set and warns on other HTTP errors', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, headers: new Headers() });

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

  it('encodes branch name in URL with %20 for spaces', async () => {
    mockFetch.mockResolvedValue(singlePageResponse([]));

    await fetchQuarantineList({ ...config, branch: 'feature/my branch' }, logger);

    // encodeURIComponent: `/` → %2F, ` ` → %20. Matches the API contract that
    // existed before pagination was added.
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('branch=feature%2Fmy%20branch'),
      expect.anything()
    );
  });

  it('aborts and warns when the next link cycles back', async () => {
    const base = 'https://api.mergify.com/v1/ci/owner/repositories/repo/quarantines';
    // Page 2 advertises itself as the next link, forming a cycle.
    const cyclingUrl = `${base}?cursor=LOOP&per_page=100`;
    mockFetch
      .mockResolvedValueOnce(pageResponse(['a'], cyclingUrl))
      .mockResolvedValueOnce(pageResponse(['b'], cyclingUrl));

    const list = await fetchQuarantineList(config, logger);

    expect(list).toEqual(new Set());
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('cyclic'));
    // Third fetch must not happen — cycle is detected before issuing the call.
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['unquoted token form', 'rel=next'],
    ['multi-rel quoted form', 'rel="next prev"'],
    ['uppercase rel', 'REL="NEXT"'],
  ])('follows RFC 8288 %s', async (_label, relAttribute) => {
    const base = 'https://api.mergify.com/v1/ci/owner/repositories/repo/quarantines';
    const page2Url = `${base}?cursor=PAGE2&per_page=100`;
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ Link: `<${page2Url}>; ${relAttribute}` }),
        json: async () => ({ quarantined_tests: [{ test_name: 'a' }] }),
      })
      .mockResolvedValueOnce(singlePageResponse(['b']));

    const list = await fetchQuarantineList(config, logger);

    expect(list).toEqual(new Set(['a', 'b']));
  });

  it('resolves relative next links against the request URL', async () => {
    const base = 'https://api.mergify.com/v1/ci/owner/repositories/repo/quarantines';
    // Defensive: the server should send absolute URLs, but RFC 8288 permits
    // relative ones. Make sure we resolve them rather than treating the
    // path-only string as the next host.
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({
          Link: '</v1/ci/owner/repositories/repo/quarantines?cursor=PAGE2&per_page=100>; rel="next"',
        }),
        json: async () => ({ quarantined_tests: [{ test_name: 'a' }] }),
      })
      .mockResolvedValueOnce(singlePageResponse(['b']));

    const list = await fetchQuarantineList(config, logger);

    expect(list).toEqual(new Set(['a', 'b']));
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      `${base}?cursor=PAGE2&per_page=100`,
      expect.anything()
    );
  });
});
