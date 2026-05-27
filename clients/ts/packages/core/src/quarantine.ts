import { splitRepoName } from './utils.js';

export interface QuarantineConfig {
  apiUrl: string;
  token: string;
  repoName: string;
  branch: string;
}

interface QuarantineResponse {
  quarantined_tests: Array<{ test_name: string }>;
}

// Matches one RFC 8288 Link header value: `<url>; ...parameters`.
const LINK_VALUE_PATTERN = /^<([^>]+)>\s*;\s*(.+)$/;
// Matches `rel="..."` or `rel=token`, case-insensitive.
const REL_PARAMETER_PATTERN = /rel\s*=\s*(?:"([^"]+)"|([^\s;,]+))/i;

function parseNextLink(linkHeader: string | null, baseUrl: string): string | null {
  if (linkHeader === null || linkHeader.length === 0) {
    return null;
  }
  for (const part of linkHeader.split(',')) {
    const match = part.trim().match(LINK_VALUE_PATTERN);
    if (!match) continue;
    const relMatch = match[2].match(REL_PARAMETER_PATTERN);
    if (!relMatch) continue;
    // RFC 8288 allows space-separated rel-types: `rel="next prev"`. Rel-types
    // are case-insensitive, so normalize before comparing.
    const relValue = (relMatch[1] ?? relMatch[2]).toLowerCase();
    if (relValue.split(/\s+/).includes('next')) {
      // Resolve against the request URL so relative `next` links work.
      return new URL(match[1], baseUrl).toString();
    }
  }
  return null;
}

function buildInitialUrl(config: QuarantineConfig): string {
  const { owner, repo } = splitRepoName(config.repoName);
  // Build the query string manually so spaces stay `%20` (encodeURIComponent),
  // matching the encoding the API expected before pagination was added.
  const base = `${config.apiUrl}/v1/ci/${owner}/repositories/${repo}/quarantines`;
  return `${base}?branch=${encodeURIComponent(config.branch)}&per_page=100`;
}

export async function fetchQuarantineList(
  config: QuarantineConfig,
  logger: (msg: string) => void
): Promise<Set<string>> {
  const collected = new Set<string>();
  const seen = new Set<string>();
  let url: string | null = buildInitialUrl(config);

  try {
    while (url !== null) {
      if (seen.has(url)) {
        logger('Quarantine API returned a cyclic `next` link, aborting');
        return new Set();
      }
      seen.add(url);

      // Pages must be walked sequentially: each request needs the prior page's
      // `next` link, so the awaits inside the loop are intentional.
      // eslint-disable-next-line no-await-in-loop
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${config.token}` },
        signal: AbortSignal.timeout(10_000),
      });

      if (response.status === 402) {
        logger('Quarantine not available (no subscription)');
        return new Set();
      }

      if (!response.ok) {
        logger(`Failed to fetch quarantine list: HTTP ${response.status}`);
        return new Set();
      }

      // eslint-disable-next-line no-await-in-loop
      const data = (await response.json()) as QuarantineResponse;
      for (const t of data.quarantined_tests) {
        collected.add(t.test_name);
      }

      url = parseNextLink(response.headers.get('link'), url);
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      logger('Quarantine API request timed out');
    } else {
      logger(`Failed to fetch quarantine list: ${err}`);
    }
    return new Set();
  }

  return collected;
}
