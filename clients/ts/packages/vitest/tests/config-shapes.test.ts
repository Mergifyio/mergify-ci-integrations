import { resolve } from 'node:path';
import { type FlakyDetectionContext, InMemorySpanSink } from '@mergifyio/ci-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVitest, type TestUserConfig } from 'vitest/node';
import { MergifyReporter } from '../src/reporter.js';
import type { MergifyReporterOptions } from '../src/types.js';

const fixturesDir = resolve(import.meta.dirname, 'fixtures');

const flakyContext: FlakyDetectionContext = {
  budget_ratio_for_new_tests: 1.0,
  budget_ratio_for_unhealthy_tests: 1.0,
  existing_test_names: [],
  existing_tests_mean_duration_ms: 100,
  unhealthy_test_names: [],
  budget_ratio_for_test_retries: 0,
  flaky_test_names: [],
  broken_test_names: [],
  max_test_execution_count: 5,
  max_test_name_length: 255,
  min_budget_duration_ms: 10_000,
  min_test_execution_count: 2,
};

async function run(config: TestUserConfig, options: MergifyReporterOptions) {
  const sink = new InMemorySpanSink();
  const reporter = new MergifyReporter({ sink, ...options });
  const vitest = await createVitest('test', {
    root: fixturesDir,
    watch: false,
    reporters: [reporter],
    ...config,
  });
  const logs: string[] = [];
  vi.spyOn(vitest.logger, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.join(' '));
  });
  await vitest.start();
  await vitest.close();

  const cases = sink.getFinishedSpans().filter((s) => s.attributes['test.scope'] === 'case');
  return { status: reporter.getSession()!.status, cases, logs: logs.join('\n') };
}

/**
 * Vitest honours a custom `config.runner` only for a Node-only root config, and
 * the three features used to live in one: under `projects` or in browser mode
 * they did nothing, while the reporter still printed a quarantine report. They
 * now extend the runner Vitest builds, from a setup file every project runs.
 * Browser mode and older or newer Vitest majors are exercised by the
 * compatibility matrix (`.github/scripts/check-vitest-compat.mjs`); these cover what the package's own Vitest
 * can run here.
 */
describe('features across config shapes', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_REPOSITORY', 'test-owner/test-repo');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('absorbs a quarantined failure in every project under `projects`', async () => {
    const { status, cases } = await run(
      {
        projects: [
          { test: { name: 'a', include: ['failing.test.ts'] } },
          { test: { name: 'b', include: ['failing.test.ts'] } },
        ],
      },
      { quarantineList: ['math > fails intentionally'] }
    );

    expect(cases).toHaveLength(2);
    for (const span of cases) {
      expect(span.attributes['cicd.test.quarantined']).toBe(true);
      expect(span.attributes['test.case.result.status']).toBe('passed');
    }
    expect(status).toBe('passed');
  });

  it('reruns a new test under `projects`', async () => {
    const { cases } = await run(
      { projects: [{ test: { name: 'a', include: ['flaky.test.ts'] } }] },
      { flakyContext, flakyMode: 'new' }
    );

    expect(cases[0].attributes['cicd.test.flaky_detection']).toBe(true);
    expect(cases[0].attributes['cicd.test.rerun_count']).toBeGreaterThan(0);
  });

  it("keeps the user's own runner and still applies on top of it", async () => {
    const { status, cases } = await run(
      {
        include: ['failing.test.ts'],
        runner: resolve(fixturesDir, 'runners/extends-base.ts'),
      },
      { quarantineList: ['math > fails intentionally'] }
    );

    expect(cases[0].attributes['cicd.test.quarantined']).toBe(true);
    expect(status).toBe('passed');
  });

  it('says so when a runner of the user keeps the features out', async () => {
    const { status, cases, logs } = await run(
      {
        include: ['failing.test.ts'],
        runner: resolve(fixturesDir, 'runners/skips-super.ts'),
      },
      { quarantineList: ['math > fails intentionally'] }
    );

    // Nothing applied, so the failure fails the run — and the output says why,
    // instead of a quarantine report that reads as if it had applied.
    expect(cases[0].attributes['cicd.test.quarantined']).toBeUndefined();
    expect(status).toBe('failed');
    expect(logs).toContain('did not apply in this run');
    expect(logs).toContain('without calling `super`');
  });

  it('does not report flaky detection a runner of the user kept from running', async () => {
    const { cases, logs } = await run(
      {
        include: ['flaky.test.ts'],
        runner: resolve(fixturesDir, 'runners/skips-try-super.ts'),
      },
      { flakyContext, flakyMode: 'new' }
    );

    // No try was observed, so no outcome: claiming "checked, not flaky" would
    // be a result no run produced.
    expect(cases[0].attributes['cicd.test.flaky_detection']).toBeUndefined();
    expect(logs).toContain('Flaky detection did not run in this run');
    expect(logs).toContain('`onBeforeTryTask` without calling `super`');
  });
});
