import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { stateFilePath } from '../../src/state-file.js';

const fixtureRoot = resolve(import.meta.dirname, '..', 'fixtures');
const fixtureTestsDir = join(fixtureRoot, 'tests');
const playwrightBin = resolve(
  import.meta.dirname,
  '..',
  '..',
  'node_modules',
  '.bin',
  'playwright'
);
const packageRoot = resolve(import.meta.dirname, '..', '..');

let cacheRoot: string;
let statePath: string;

beforeAll(() => {
  // `withMergify` in the fixture's playwright.config.ts imports from the
  // compiled dist; make sure it's up-to-date before we exec the subprocess.
  const build = spawnSync('pnpm', ['-F', '@mergifyio/playwright', 'build'], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
  if (build.status !== 0) {
    throw new Error(`Package build failed:\n${build.stdout}\n${build.stderr}`);
  }
}, 60_000);

beforeEach(() => {
  cacheRoot = mkdtempSync(join(tmpdir(), 'mergify-integration-'));
  statePath = stateFilePath(cacheRoot, 'integration-test-run');
});

afterEach(() => {
  rmSync(cacheRoot, { recursive: true, force: true });
});

function seedStateFile(quarantinedTests: string[]): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        version: 1,
        testRunId: 'integration-test-run',
        createdAt: '2026-04-22T10:00:00Z',
        rootDir: fixtureTestsDir,
        quarantinedTests,
      },
      null,
      2
    )}\n`
  );
}

function runPlaywrightFixture(
  envOverrides: Record<string, string> = {}
): ReturnType<typeof spawnSync> {
  return spawnSync(playwrightBin, ['test', '--config', join(fixtureRoot, 'playwright.config.ts')], {
    cwd: fixtureRoot,
    env: {
      ...process.env,
      // Bypass globalSetup's fetch path by leaving the token empty; it will
      // still run but hit the early return.
      MERGIFY_TOKEN: '',
      // Pre-set run id and state path so the reporter + fixture find our
      // seeded state file instead of whatever globalSetup would have generated.
      MERGIFY_TEST_RUN_ID: 'integration-test-run',
      MERGIFY_STATE_FILE: statePath,
      // Force CI mode so globalSetup gets past its first guard (not strictly
      // necessary for the fixture/reporter behaviour, but keeps the path
      // consistent with real CI runs).
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: 'acme/repo',
      // Prefixing is opt-in (default off); enable it so these runs exercise the
      // [node] > … identities the seeds below assert.
      PLAYWRIGHT_MERGIFY_INCLUDE_PROJECT_IN_TEST_NAME: 'true',
      ...envOverrides,
    },
    encoding: 'utf8',
  });
}

describe('integration: quarantine end-to-end', () => {
  it('absorbs the quarantined failure but still fails on the non-quarantined one', () => {
    seedStateFile(['[node] > sample.spec.ts > quarantined-fails']);
    const result = runPlaywrightFixture();

    const combined = `${result.stdout}\n${result.stderr}`;

    // The non-quarantined `fails` test still fails → overall exit 1.
    expect(result.status).toBe(1);

    // Quarantine summary shows the one caught test, no unused entries.
    expect(combined).toContain('Quarantine report');
    expect(combined).toContain('fetched: 1');
    expect(combined).toContain('caught:  1');
    expect(combined).toContain('[node] > sample.spec.ts > quarantined-fails');
    expect(combined).toContain('unused:  0');

    // 2 passed = `passes` + `quarantined-fails` (absorbed), 1 failed = `fails`.
    expect(combined).toMatch(/1 failed/);
    expect(combined).toMatch(/2 passed/);
  }, 60_000);

  it('still catches the absorbed quarantined failure when retries > 0 (MRGFY-7767)', () => {
    seedStateFile(['[node] > sample.spec.ts > quarantined-fails']);
    // retries: 2 — the absorbed quarantined test is reconciled as expected and
    // never retried (stays at retry 0), so the reporter must not gate it behind
    // the retry-count check. Before the fix this reported caught: 0, no span.
    const result = runPlaywrightFixture({ PW_FIXTURE_RETRIES: '2' });

    const combined = `${result.stdout}\n${result.stderr}`;

    // The non-quarantined `fails` test exhausts its retries and still fails → exit 1.
    expect(result.status).toBe(1);

    // Quarantine summary still shows the one caught test despite retries > 0.
    expect(combined).toContain('Quarantine report');
    expect(combined).toContain('fetched: 1');
    expect(combined).toContain('caught:  1');
    expect(combined).toContain('[node] > sample.spec.ts > quarantined-fails');
    expect(combined).toContain('unused:  0');
  }, 60_000);

  it('reports every list entry as unused when nothing matches', () => {
    seedStateFile(['[node] > sample.spec.ts > does-not-exist']);
    const result = runPlaywrightFixture();

    const combined = `${result.stdout}\n${result.stderr}`;

    // Both failing tests remain failures; exit still 1, and quarantined-fails
    // now contributes to the failure count too.
    expect(result.status).toBe(1);
    expect(combined).toContain('caught:  0');
    expect(combined).toContain('unused:  1');
    expect(combined).toContain('[node] > sample.spec.ts > does-not-exist');
  }, 60_000);

  it('matches unprefixed names when PLAYWRIGHT_MERGIFY_INCLUDE_PROJECT_IN_TEST_NAME=false', () => {
    seedStateFile(['sample.spec.ts > quarantined-fails']);
    const result = spawnSync(
      playwrightBin,
      ['test', '--config', join(fixtureRoot, 'playwright.config.ts')],
      {
        cwd: fixtureRoot,
        env: {
          ...process.env,
          MERGIFY_TOKEN: '',
          MERGIFY_TEST_RUN_ID: 'integration-test-run',
          MERGIFY_STATE_FILE: statePath,
          CI: 'true',
          GITHUB_ACTIONS: 'true',
          GITHUB_REPOSITORY: 'acme/repo',
          PLAYWRIGHT_MERGIFY_INCLUDE_PROJECT_IN_TEST_NAME: 'false',
        },
        encoding: 'utf8',
      }
    );

    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined).toContain('caught:  1');
    expect(combined).toContain('    - sample.spec.ts > quarantined-fails');
    expect(combined).toContain('unused:  0');
  }, 60_000);

  it('emits no summary when the state file is absent (V1 reporter-only parity)', () => {
    // Don't seed; point MERGIFY_STATE_FILE at a missing path instead.
    const missing = join(cacheRoot, 'missing.json');
    const result = spawnSync(
      playwrightBin,
      ['test', '--config', join(fixtureRoot, 'playwright.config.ts')],
      {
        cwd: fixtureRoot,
        env: {
          ...process.env,
          MERGIFY_TOKEN: '',
          MERGIFY_TEST_RUN_ID: 'integration-test-run',
          MERGIFY_STATE_FILE: missing,
          CI: 'true',
          GITHUB_ACTIONS: 'true',
          GITHUB_REPOSITORY: 'acme/repo',
        },
        encoding: 'utf8',
      }
    );

    const combined = `${result.stdout}\n${result.stderr}`;
    expect(result.status).toBe(1); // both failing tests count
    expect(combined).not.toContain('Quarantine report');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Flaky detection integration tests.
// ---------------------------------------------------------------------------

function seedFlakyState(opts: {
  mode: 'new' | 'unhealthy';
  rootDir: string;
  unhealthyTestNames?: string[];
  existingTestNames?: string[];
}): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        version: 1,
        testRunId: 'integration-test-run',
        createdAt: '2026-04-29T00:00:00Z',
        rootDir: opts.rootDir,
        quarantinedTests: [],
        flakyMode: opts.mode,
        flakyContext: {
          budget_ratio_for_new_tests: 0.5,
          budget_ratio_for_unhealthy_tests: 0.5,
          existing_test_names: opts.existingTestNames ?? [],
          existing_tests_mean_duration_ms: 100,
          unhealthy_test_names: opts.unhealthyTestNames ?? [],
          max_test_execution_count: 5,
          max_test_name_length: 200,
          min_budget_duration_ms: 1_000,
          min_test_execution_count: 3,
        },
      },
      null,
      2
    )}\n`
  );
}

function runFlakyFixture(envOverrides: Record<string, string>): ReturnType<typeof spawnSync> {
  return spawnSync(playwrightBin, ['test', '--config', join(fixtureRoot, 'playwright.config.ts')], {
    cwd: fixtureRoot,
    env: {
      ...process.env,
      MERGIFY_TOKEN: '',
      MERGIFY_TEST_RUN_ID: 'integration-test-run',
      MERGIFY_STATE_FILE: statePath,
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: 'acme/repo',
      // Prefixing is opt-in (default off); enable it so the [node] > … seeds
      // below match. A test may still override via envOverrides.
      PLAYWRIGHT_MERGIFY_INCLUDE_PROJECT_IN_TEST_NAME: 'true',
      ...envOverrides,
    },
    encoding: 'utf8',
  });
}

describe('integration: flaky detection — unhealthy mode', () => {
  it('absorbs the deterministic-flaky failure and exits 0', () => {
    const counterPath = join(cacheRoot, 'flaky-counter');
    seedFlakyState({
      mode: 'unhealthy',
      rootDir: join(fixtureRoot, 'tests-unhealthy'),
      unhealthyTestNames: ['[node] > sample.spec.ts > flaky-test'],
    });

    const result = runFlakyFixture({
      PW_FIXTURE_DIR: './tests-unhealthy',
      FLAKY_COUNTER_PATH: counterPath,
    });

    const combined = `${result.stdout}\n${result.stderr}`;
    expect(result.status).toBe(0);
    expect(combined).toContain('Flaky detection report');
    expect(combined).toContain('mode: unhealthy');
    expect(combined).toContain('Tests rerun: 1');
    expect(combined).toContain('Flaky tests detected: 1');
    expect(combined).toContain('[node] > sample.spec.ts > flaky-test');
  }, 90_000);
});

describe('integration: flaky detection — new mode', () => {
  it('detects the flake via subprocess reruns even though phase 1 failed (exit 1)', () => {
    const counterPath = join(cacheRoot, 'flaky-counter-new');
    seedFlakyState({
      mode: 'new',
      rootDir: join(fixtureRoot, 'tests-unhealthy'),
      existingTestNames: ['[node] > sample.spec.ts > passes'],
    });

    const result = runFlakyFixture({
      PW_FIXTURE_DIR: './tests-unhealthy',
      FLAKY_COUNTER_PATH: counterPath,
    });

    const combined = `${result.stdout}\n${result.stderr}`;
    // mode=new doesn't absorb → phase-1 failure stands → exit 1
    expect(result.status).toBe(1);
    expect(combined).toContain('Flaky detection report');
    expect(combined).toContain('mode: new');
    expect(combined).toContain('Flaky tests detected: 1');
    expect(combined).toContain('[node] > sample.spec.ts > flaky-test');
  }, 90_000);
});
