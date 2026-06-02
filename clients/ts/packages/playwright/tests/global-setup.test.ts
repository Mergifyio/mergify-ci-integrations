import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FullConfig } from '@playwright/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGlobalSetup } from '../src/global-setup.js';
import { stateFilePath } from '../src/state-file.js';

function fakeConfig(rootDir: string): FullConfig {
  return { rootDir } as unknown as FullConfig;
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
    const fetchStub = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ quarantined_tests: [{ test_name: 'tests/a.spec.ts > x' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );
    vi.stubGlobal('fetch', fetchStub);

    await runGlobalSetup(fakeConfig('/repo'), {
      cacheRoot,
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

  it('writes an empty list on HTTP 402 (no subscription)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 402 })));
    await runGlobalSetup(fakeConfig('/repo'), { cacheRoot, now: () => new Date() });

    const id = process.env.MERGIFY_TEST_RUN_ID;
    expect(id).toBeDefined();
    const state = JSON.parse(readFileSync(stateFilePath(cacheRoot, id!), 'utf8'));
    expect(state.quarantinedTests).toEqual([]);
  });

  it('writes an empty-list state file on fetch error (failure already logged by fetchQuarantineList)', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    await runGlobalSetup(fakeConfig('/repo'), { cacheRoot, now: () => new Date() });

    const id = process.env.MERGIFY_TEST_RUN_ID;
    expect(id).toBeDefined();
    const state = JSON.parse(readFileSync(stateFilePath(cacheRoot, id!), 'utf8'));
    expect(state.quarantinedTests).toEqual([]);
    // Confirm the error was surfaced to the user via the logger.
    const written = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toMatch(/Failed to fetch quarantine list/);
  });

  it('writes no file when MERGIFY_TOKEN is unset', async () => {
    vi.stubEnv('MERGIFY_TOKEN', '');
    const fetchStub = vi.fn();
    vi.stubGlobal('fetch', fetchStub);
    await runGlobalSetup(fakeConfig('/repo'), { cacheRoot, now: () => new Date() });
    expect(fetchStub).not.toHaveBeenCalled();
    expect(existsSync(stateFilePath(cacheRoot, process.env.MERGIFY_TEST_RUN_ID ?? 'x'))).toBe(
      false
    );
  });

  it('writes no file when not in CI and no enable env var', async () => {
    vi.stubEnv('GITHUB_ACTIONS', '');
    vi.stubEnv('CI', '');
    const fetchStub = vi.fn();
    vi.stubGlobal('fetch', fetchStub);
    await runGlobalSetup(fakeConfig('/repo'), { cacheRoot, now: () => new Date() });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('short-circuits without fetching when MERGIFY_RERUN_FILE is set (subprocess)', async () => {
    vi.stubEnv('MERGIFY_RERUN_FILE', '/tmp/rerun.jsonl');
    const fetchStub = vi.fn();
    vi.stubGlobal('fetch', fetchStub);

    await runGlobalSetup(fakeConfig('/repo'), { cacheRoot, now: () => new Date() });

    expect(fetchStub).not.toHaveBeenCalled();
    // Should NOT mutate env or write a state file — the parent already did.
    expect(process.env.MERGIFY_TEST_RUN_ID).toBeUndefined();
    expect(process.env.MERGIFY_STATE_FILE).toBeUndefined();
  });
});

describe('runGlobalSetup — flaky detection', () => {
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

  function fetchRouter(): ReturnType<typeof vi.fn> {
    return vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('quarantines')) {
        return new Response(JSON.stringify({ quarantined_tests: [] }), { status: 200 });
      }
      if (url.includes('flaky-detection-context')) {
        return new Response(JSON.stringify(flakyContextPayload()), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
  }

  it('writes flakyContext + flakyMode "new" when feature flag is set and base ref is present', async () => {
    vi.stubEnv('_MERGIFY_TEST_NEW_FLAKY_DETECTION', 'true');
    vi.stubEnv('GITHUB_BASE_REF', 'main');
    vi.stubGlobal('fetch', fetchRouter());

    await runGlobalSetup(fakeConfig('/repo'), { cacheRoot, now: () => new Date() });

    const id = process.env.MERGIFY_TEST_RUN_ID!;
    const state = JSON.parse(readFileSync(stateFilePath(cacheRoot, id), 'utf8'));
    expect(state.flakyMode).toBe('new');
    expect(state.flakyContext.existing_test_names).toEqual(['existing-1']);
  });

  it('writes flakyMode "unhealthy" when feature flag is set and no base ref', async () => {
    vi.stubEnv('_MERGIFY_TEST_NEW_FLAKY_DETECTION', 'true');
    vi.stubEnv('GITHUB_BASE_REF', '');
    vi.stubEnv('GITHUB_REF_NAME', 'main');
    vi.stubGlobal('fetch', fetchRouter());

    await runGlobalSetup(fakeConfig('/repo'), { cacheRoot, now: () => new Date() });

    const id = process.env.MERGIFY_TEST_RUN_ID!;
    const state = JSON.parse(readFileSync(stateFilePath(cacheRoot, id), 'utf8'));
    expect(state.flakyMode).toBe('unhealthy');
  });

  it('writes no flaky fields when the feature flag is unset', async () => {
    // No _MERGIFY_TEST_NEW_FLAKY_DETECTION stub; quarantine path still runs.
    vi.stubGlobal('fetch', fetchRouter());

    await runGlobalSetup(fakeConfig('/repo'), { cacheRoot, now: () => new Date() });

    const id = process.env.MERGIFY_TEST_RUN_ID!;
    const state = JSON.parse(readFileSync(stateFilePath(cacheRoot, id), 'utf8'));
    expect(state.flakyMode).toBeUndefined();
    expect(state.flakyContext).toBeUndefined();
  });

  it('omits flaky fields when fetchFlakyDetectionContext returns null', async () => {
    vi.stubEnv('_MERGIFY_TEST_NEW_FLAKY_DETECTION', 'true');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('quarantines')) {
          return new Response(JSON.stringify({ quarantined_tests: [] }), { status: 200 });
        }
        // Flaky context endpoint returns 5xx — fetcher returns null.
        return new Response('', { status: 503 });
      })
    );

    await runGlobalSetup(fakeConfig('/repo'), { cacheRoot, now: () => new Date() });

    const id = process.env.MERGIFY_TEST_RUN_ID!;
    const state = JSON.parse(readFileSync(stateFilePath(cacheRoot, id), 'utf8'));
    expect(state.quarantinedTests).toEqual([]); // quarantine still wrote
    expect(state.flakyContext).toBeUndefined();
    expect(state.flakyMode).toBeUndefined();
  });
});
