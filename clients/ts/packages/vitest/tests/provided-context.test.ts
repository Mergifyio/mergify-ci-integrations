import { resolve } from 'node:path';
import type { FlakyDetectionContext } from '@mergifyio/ci-core';
import { afterEach, describe, expect, it } from 'vitest';
import { createVitest, type Vitest } from 'vitest/node';
import { MergifyReporter } from '../src/reporter.js';

const fixturesDir = resolve(import.meta.dirname, 'fixtures');

const flakyContext: FlakyDetectionContext = {
  budget_ratio_for_new_tests: 0.1,
  budget_ratio_for_unhealthy_tests: 0.1,
  existing_test_names: ['math > adds numbers', 'engine/tests/test_x.py::test_y'],
  existing_tests_mean_duration_ms: 100,
  unhealthy_test_names: [],
  budget_ratio_for_test_retries: 0,
  flaky_test_names: [],
  broken_test_names: [],
  max_test_execution_count: 5,
  max_test_name_length: 255,
  min_budget_duration_ms: 1000,
  min_test_execution_count: 2,
};

const RUNNER_KEYS = [
  'mergify:quarantine',
  'mergify:selection',
  'mergify:flakyContext',
  'mergify:flakyMode',
] as const;

describe('values provided to the runner', () => {
  let vitest: Vitest | undefined;

  afterEach(async () => {
    await vitest?.close();
    vitest = undefined;
  });

  it('reach a node project and stay out of a browser one', async () => {
    const reporter = new MergifyReporter({
      quarantineList: ['math > adds numbers'],
      testSelection: ['math > adds numbers'],
      flakyContext,
      flakyMode: 'new',
    });
    vitest = await createVitest('test', {
      root: fixturesDir,
      watch: false,
      reporters: [],
      projects: [
        { test: { name: 'node', include: ['passing.test.ts'] } },
        { test: { name: 'web', include: ['passing.test.ts'] } },
      ],
    });
    // Starting a real browser needs a provider this package does not ship;
    // the flag is all the reporter reads, and all the browser tester changes
    // that matter here is that it never loads our runner.
    const web = vitest.projects.find((p) => p.name === 'web')!;
    web.config.browser.enabled = true;

    reporter.onInit(vitest);

    const node = vitest.projects.find((p) => p.name === 'node')!.getProvidedContext();
    expect(node['mergify:flakyContext']).toEqual(flakyContext);
    expect(node['mergify:flakyMode']).toBe('new');
    expect(node['mergify:quarantine']).toEqual(['math > adds numbers']);
    expect(node['mergify:selection']).toEqual(['math > adds numbers']);

    // `getProvidedContext` merges in the root project's values, which is how a
    // root-level `provide` used to land every test name of the repository in
    // each browser test file.
    const browser = web.getProvidedContext();
    for (const key of RUNNER_KEYS) expect(browser).not.toHaveProperty(key);
  });

  it('still reach a browser project that routes files to a Node pool', async () => {
    const reporter = new MergifyReporter({ quarantineList: ['math > adds numbers'] });
    vitest = await createVitest('test', {
      root: fixturesDir,
      watch: false,
      reporters: [],
      projects: [{ test: { name: 'web', include: ['passing.test.ts'] } }],
    });
    // Vitest 3's `poolMatchGlobs` wins over browser mode, so the files it
    // matches run in Node, where a `runner` set on the project loads. The
    // routing is Vitest's; what the reporter decides on is only that the
    // option is set. Vitest 4 dropped it, hence the cast.
    const web = vitest.projects[0];
    web.config.browser.enabled = true;
    (web.config as { poolMatchGlobs?: [string, string][] }).poolMatchGlobs = [
      ['**/passing.test.ts', 'forks'],
    ];

    reporter.onInit(vitest);

    expect(web.getProvidedContext()['mergify:quarantine']).toEqual(['math > adds numbers']);
  });
});
