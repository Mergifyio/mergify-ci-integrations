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

export async function fetchQuarantineList(
  config: QuarantineConfig,
  logger: (msg: string) => void
): Promise<Set<string>> {
  const { owner, repo } = splitRepoName(config.repoName);
  const url = `${config.apiUrl}/v1/ci/${owner}/repositories/${repo}/quarantines?branch=${encodeURIComponent(config.branch)}`;

  try {
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

    const data = (await response.json()) as QuarantineResponse;
    return new Set(data.quarantined_tests.map((t) => t.test_name));
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      logger('Quarantine API request timed out');
    } else {
      logger(`Failed to fetch quarantine list: ${err}`);
    }
    return new Set();
  }
}
