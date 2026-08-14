import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MergifyApiClient } from '@mergifyio/ci-core';
import type { FullConfig } from '@playwright/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGlobalSetup } from '../src/global-setup.js';
import { stateFilePath } from '../src/state-file.js';

function fakeConfig(rootDir: string): FullConfig {
  return { rootDir } as unknown as FullConfig;
}

function flakyContextPayload() {
  return {
    budget_ratio_for_new_tests: 0.5,
    budget_ratio_for_unhealthy_tests: 0.5,
    existing_test_names: ['existing-1'],
    existing_tests_mean_duration_ms: 100,
    unhealthy_test_names: [],
    max_test_execution_count: 5,
    max_test_name_length: 200,
    min_budget_duration_ms: 1_000,
    min_test_execution_count: 3,
  };
}

/**
 * A stand-in for the bundled Rust client. HTTP statuses are the client's
 * business and are covered by its own tests; what the seam expresses is the
 * outcome globalSetup sees — a value, `null` for dormant, or a rejection.
 */
function stubClient(overrides: Partial<MergifyApiClient> = {}): MergifyApiClient {
  return {
    fetchQuarantine: vi.fn().mockResolvedValue([]),
    fetchFlakyContext: vi.fn().mockResolvedValue(null),
    fetchTestSelection: vi.fn().mockResolvedValue(null),
    uploadTrace: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** Deps with an injected client, plus the spy that hands it over. */
function depsWith(client: MergifyApiClient | null, cacheRoot: string) {
  const createClient = vi.fn().mockReturnValue(client);
  return { deps: { cacheRoot, now: () => new Date(), createClient }, createClient };
}

let cacheRoot: string;
beforeEach(() => {
  cacheRoot = mkdtempSync(join(tmpdir(), 'mergify-cache-'));
  vi.stubEnv('CI', 'true');
  vi.stubEnv('GITHUB_ACTIONS', 'true');
  vi.stubEnv('GITHUB_REPOSITORY', 'acme/repo');
  // Clear GITHUB_BASE_REF and GITHUB_HEAD_REF so getBranch() falls through to
  // GITHUB_REF_NAME; otherwise on a real PR run (especially stacked PRs) the
  // ambient env var leaks into the assertion.
  vi.stubEnv('GITHUB_BASE_REF', '');
  vi.stubEnv('GITHUB_HEAD_REF', '');
  vi.stubEnv('GITHUB_REF_NAME', 'main');
  vi.stubEnv('MERGIFY_TOKEN', 't0ken');
  delete process.env.MERGIFY_TEST_RUN_ID;
  delete process.env.MERGIFY_STATE_FILE;
});
afterEach(() => {
  rmSync(cacheRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.MERGIFY_TEST_RUN_ID;
  delete process.env.MERGIFY_STATE_FILE;
});

describe('runGlobalSetup', () => {
  it('fetches list, writes state file, sets MERGIFY_TEST_RUN_ID and MERGIFY_STATE_FILE', async () => {
    const client = stubClient({
      fetchQuarantine: vi.fn().mockResolvedValue(['tests/a.spec.ts > x']),
    });
    const { deps } = depsWith(client, cacheRoot);

    await runGlobalSetup(fakeConfig('/repo'), {
      ...deps,
      now: () => new Date('2026-04-21T16:07:42Z'),
    });

    const id = process.env.MERGIFY_TEST_RUN_ID;
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    const path = stateFilePath(cacheRoot, id!);
    expect(existsSync(path)).toBe(true);
    expect(process.env.MERGIFY_STATE_FILE).toBe(path);
    const state = JSON.parse(readFileSync(path, 'utf8'));
    expect(state.quarantinedTests).toEqual(['tests/a.spec.ts > x']);
    expect(state.rootDir).toBe('/repo');
    expect(state.testRunId).toBe(id);
    expect(state.createdAt).toBe('2026-04-21T16:07:42.000Z');
    expect(state.version).toBe(1);
  });

  it('builds the client for the detected repository and branch', async () => {
    const client = stubClient();
    const { deps, createClient } = depsWith(client, cacheRoot);

    await runGlobalSetup(fakeConfig('/repo'), deps);

    expect(createClient).toHaveBeenCalledWith({
      apiUrl: 'https://api.mergify.com',
      token: 't0ken',
      repoName: 'acme/repo',
    });
    expect(client.fetchQuarantine).toHaveBeenCalledWith('main');
  });

  it('writes an empty list when quarantine is dormant (no subscription)', async () => {
    const client = stubClient({ fetchQuarantine: vi.fn().mockResolvedValue(null) });
    const { deps } = depsWith(client, cacheRoot);

    await runGlobalSetup(fakeConfig('/repo'), deps);

    const id = process.env.MERGIFY_TEST_RUN_ID;
    expect(id).toBeDefined();
    const state = JSON.parse(readFileSync(stateFilePath(cacheRoot, id!), 'utf8'));
    expect(state.quarantinedTests).toEqual([]);
  });

  it('writes an empty-list state file on fetch error (failure already logged by fetchQuarantineList)', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const client = stubClient({
      fetchQuarantine: vi.fn().mockRejectedValue(new Error('Mergify API request failed')),
    });
    const { deps } = depsWith(client, cacheRoot);

    await runGlobalSetup(fakeConfig('/repo'), deps);

    const id = process.env.MERGIFY_TEST_RUN_ID;
    expect(id).toBeDefined();
    const state = JSON.parse(readFileSync(stateFilePath(cacheRoot, id!), 'utf8'));
    expect(state.quarantinedTests).toEqual([]);
    // Confirm the error was surfaced to the user via the logger.
    const written = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toMatch(/Failed to fetch quarantine list/);
  });

  it('writes no file when the platform has no native client', async () => {
    const { deps, createClient } = depsWith(null, cacheRoot);

    await runGlobalSetup(fakeConfig('/repo'), deps);

    expect(createClient).toHaveBeenCalled();
    expect(existsSync(stateFilePath(cacheRoot, process.env.MERGIFY_TEST_RUN_ID ?? 'x'))).toBe(
      false
    );
  });

  it('writes no file when MERGIFY_TOKEN is unset', async () => {
    vi.stubEnv('MERGIFY_TOKEN', '');
    const { deps, createClient } = depsWith(stubClient(), cacheRoot);

    await runGlobalSetup(fakeConfig('/repo'), deps);

    expect(createClient).not.toHaveBeenCalled();
    expect(existsSync(stateFilePath(cacheRoot, process.env.MERGIFY_TEST_RUN_ID ?? 'x'))).toBe(
      false
    );
  });

  it('writes no file when not in CI and no enable env var', async () => {
    vi.stubEnv('GITHUB_ACTIONS', '');
    vi.stubEnv('CI', '');
    const { deps, createClient } = depsWith(stubClient(), cacheRoot);

    await runGlobalSetup(fakeConfig('/repo'), deps);

    expect(createClient).not.toHaveBeenCalled();
  });

  it('short-circuits without fetching when MERGIFY_RERUN_FILE is set (subprocess)', async () => {
    vi.stubEnv('MERGIFY_RERUN_FILE', '/tmp/rerun.jsonl');
    const { deps, createClient } = depsWith(stubClient(), cacheRoot);

    await runGlobalSetup(fakeConfig('/repo'), deps);

    expect(createClient).not.toHaveBeenCalled();
    // Should NOT mutate env or write a state file — the parent already did.
    expect(process.env.MERGIFY_TEST_RUN_ID).toBeUndefined();
    expect(process.env.MERGIFY_STATE_FILE).toBeUndefined();
  });
});

describe('runGlobalSetup — flaky detection', () => {
  it('writes flakyContext + flakyMode "new" when opted in and base ref is present', async () => {
    vi.stubEnv('GITHUB_BASE_REF', 'main');
    const client = stubClient({
      fetchFlakyContext: vi.fn().mockResolvedValue(flakyContextPayload()),
    });
    const { deps } = depsWith(client, cacheRoot);

    await runGlobalSetup(fakeConfig('/repo'), deps);

    const id = process.env.MERGIFY_TEST_RUN_ID!;
    const state = JSON.parse(readFileSync(stateFilePath(cacheRoot, id), 'utf8'));
    expect(state.flakyMode).toBe('new');
    expect(state.flakyContext.existing_test_names).toEqual(['existing-1']);
  });

  it('writes flakyMode "unhealthy" when opted in and no base ref', async () => {
    vi.stubEnv('GITHUB_BASE_REF', '');
    vi.stubEnv('GITHUB_REF_NAME', 'main');
    const client = stubClient({
      fetchFlakyContext: vi.fn().mockResolvedValue(flakyContextPayload()),
    });
    const { deps } = depsWith(client, cacheRoot);

    await runGlobalSetup(fakeConfig('/repo'), deps);

    const id = process.env.MERGIFY_TEST_RUN_ID!;
    const state = JSON.parse(readFileSync(stateFilePath(cacheRoot, id), 'utf8'));
    expect(state.flakyMode).toBe('unhealthy');
  });

  it('writes no flaky fields and stays silent when the repository has not opted in', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // Dormant: the client resolves null rather than rejecting.
    const { deps } = depsWith(stubClient(), cacheRoot);

    await runGlobalSetup(fakeConfig('/repo'), deps);

    const id = process.env.MERGIFY_TEST_RUN_ID!;
    const state = JSON.parse(readFileSync(stateFilePath(cacheRoot, id), 'utf8'));
    expect(state.quarantinedTests).toEqual([]); // quarantine still wrote
    expect(state.flakyMode).toBeUndefined();
    expect(state.flakyContext).toBeUndefined();
    // Opting out is the expected default, so nothing is logged about flaky.
    const written = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(written).not.toMatch(/flaky detection/i);
  });

  it('omits flaky fields when the flaky-context fetch fails', async () => {
    const client = stubClient({
      fetchFlakyContext: vi.fn().mockRejectedValue(new Error('Mergify API returned HTTP 503')),
    });
    const { deps } = depsWith(client, cacheRoot);

    await runGlobalSetup(fakeConfig('/repo'), deps);

    const id = process.env.MERGIFY_TEST_RUN_ID!;
    const state = JSON.parse(readFileSync(stateFilePath(cacheRoot, id), 'utf8'));
    expect(state.quarantinedTests).toEqual([]); // quarantine still wrote
    expect(state.flakyContext).toBeUndefined();
    expect(state.flakyMode).toBeUndefined();
  });
});
