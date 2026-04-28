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

function runPlaywrightFixture(): ReturnType<typeof spawnSync> {
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
    },
    encoding: 'utf8',
  });
}

describe('integration: quarantine end-to-end', () => {
  it('absorbs the quarantined failure but still fails on the non-quarantined one', () => {
    seedStateFile(['sample.spec.ts > quarantined-fails']);
    const result = runPlaywrightFixture();

    const combined = `${result.stdout}\n${result.stderr}`;

    // The non-quarantined `fails` test still fails → overall exit 1.
    expect(result.status).toBe(1);

    // Quarantine summary shows the one caught test, no unused entries.
    expect(combined).toContain('Quarantine report');
    expect(combined).toContain('fetched: 1');
    expect(combined).toContain('caught:  1');
    expect(combined).toContain('sample.spec.ts > quarantined-fails');
    expect(combined).toContain('unused:  0');

    // 2 passed = `passes` + `quarantined-fails` (absorbed), 1 failed = `fails`.
    expect(combined).toMatch(/1 failed/);
    expect(combined).toMatch(/2 passed/);
  }, 60_000);

  it('reports every list entry as unused when nothing matches', () => {
    seedStateFile(['sample.spec.ts > does-not-exist']);
    const result = runPlaywrightFixture();

    const combined = `${result.stdout}\n${result.stderr}`;

    // Both failing tests remain failures; exit still 1, and quarantined-fails
    // now contributes to the failure count too.
    expect(result.status).toBe(1);
    expect(combined).toContain('caught:  0');
    expect(combined).toContain('unused:  1');
    expect(combined).toContain('sample.spec.ts > does-not-exist');
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
