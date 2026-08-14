import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import type { FullConfig, Suite, TestCase } from '@playwright/test/reporter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MergifyReporter } from '../src/reporter.js';
import { stateFilePath } from '../src/state-file.js';

interface FakeProject {
  name: string;
  dependencies?: string[];
  teardown?: string;
}

function fakeConfig(projects: FakeProject[] = [{ name: 'proj' }]): FullConfig {
  return {
    rootDir: '/root',
    projects: projects.map((project) => ({
      dependencies: [],
      ...project,
    })),
  } as unknown as FullConfig;
}

/** A collected test, identified the way the reporter identifies it. */
function fakeTest(project: string, file: string, title: string): TestCase {
  return {
    title,
    titlePath: () => ['', project, file, title],
    location: { file: `/root/${file}`, line: 1, column: 1 },
    retries: 0,
    parent: { project: () => ({ name: project }) },
    outcome: () => 'expected',
    annotations: [],
  } as unknown as TestCase;
}

/**
 * A root suite shaped like Playwright's: one child suite per project OF THE RUN,
 * each answering `project()` with its declaration. The reporter reads dependency
 * and teardown declarations from there rather than from the config, so the fake
 * has to carry them. Without `projects`, they are derived from the tests, which
 * is the no-dependencies case.
 */
function suiteWith(tests: TestCase[], projects?: FakeProject[]): Suite {
  const declared = (
    projects ??
    [...new Set(tests.map((t) => t.parent?.project()?.name ?? ''))].map((name) => ({ name }))
  ).map((project) => ({ dependencies: [], ...project }));
  return {
    suites: declared.map((project) => ({ project: () => project })),
    allTests: () => tests,
  } as unknown as Suite;
}

/** Records what `preprocess` removes, and mimics Playwright's readonly guard. */
function fakeTestRun(readonlyTests: TestCase[] = []) {
  const excluded: TestCase[] = [];
  return {
    excluded,
    testRun: {
      exclude(test: TestCase | Suite): void {
        if (readonlyTests.includes(test as TestCase)) {
          throw new Error(
            'TestRun.exclude() cannot be called on a setup or teardown project test; these always run in full.'
          );
        }
        excluded.push(test as TestCase);
      },
    },
  };
}

let cacheRoot: string;
let statePath: string;

beforeEach(() => {
  vi.stubEnv('GITHUB_ACTIONS', 'true');
  vi.stubEnv('GITHUB_REPOSITORY', 'test-owner/test-repo');
  vi.stubEnv('PLAYWRIGHT_MERGIFY_INCLUDE_PROJECT_IN_TEST_NAME', 'true');
  cacheRoot = mkdtempSync(join(tmpdir(), 'mergify-selection-'));
  statePath = stateFilePath(cacheRoot, 'run-1');
  mkdirSync(dirname(statePath), { recursive: true });
  process.env.MERGIFY_TEST_RUN_ID = 'run-1';
  process.env.MERGIFY_STATE_FILE = statePath;
  delete process.env.MERGIFY_RERUN_FILE;
});

afterEach(() => {
  rmSync(cacheRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  delete process.env.MERGIFY_TEST_RUN_ID;
  delete process.env.MERGIFY_STATE_FILE;
  delete process.env.MERGIFY_RERUN_FILE;
});

function seedState(testSelection?: unknown): void {
  writeFileSync(
    statePath,
    JSON.stringify({
      version: 1,
      testRunId: 'run-1',
      createdAt: '2026-08-14T00:00:00Z',
      rootDir: '/root',
      quarantinedTests: [],
      ...(testSelection !== undefined && { testSelection }),
    })
  );
}

function reporter(): MergifyReporter {
  return new MergifyReporter({ exporter: new InMemorySpanExporter() });
}

describe('preprocess — reducing the run to the served subset', () => {
  it('excludes every collected test the subset does not name', async () => {
    seedState({
      selection: 'subset',
      reason: 'queue_rerun',
      tests: ['[proj] > a.spec.ts > kept'],
    });
    const kept = fakeTest('proj', 'a.spec.ts', 'kept');
    const dropped = fakeTest('proj', 'a.spec.ts', 'dropped');
    const alsoDropped = fakeTest('proj', 'b.spec.ts', 'other');
    const { excluded, testRun } = fakeTestRun();

    await reporter().preprocess({
      config: fakeConfig(),
      suite: suiteWith([kept, dropped, alsoDropped]),
      testRun,
    });

    expect(excluded).toEqual([dropped, alsoDropped]);
  });

  it('keeps the same logical test in every project it was collected in', async () => {
    seedState({ selection: 'subset', reason: 'queue_rerun', tests: ['a.spec.ts > kept'] });
    vi.stubEnv('PLAYWRIGHT_MERGIFY_INCLUDE_PROJECT_IN_TEST_NAME', 'false');
    const keptChromium = fakeTest('chromium', 'a.spec.ts', 'kept');
    const keptFirefox = fakeTest('firefox', 'a.spec.ts', 'kept');
    const dropped = fakeTest('chromium', 'a.spec.ts', 'dropped');
    const { excluded, testRun } = fakeTestRun();

    await reporter().preprocess({
      config: fakeConfig([{ name: 'chromium' }, { name: 'firefox' }]),
      suite: suiteWith([keptChromium, keptFirefox, dropped]),
      testRun,
    });

    expect(excluded).toEqual([dropped]);
  });

  it('reports the reduction at the end of the run', async () => {
    seedState({
      selection: 'subset',
      reason: 'queue_rerun',
      tests: ['[proj] > a.spec.ts > kept'],
    });
    const log = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const r = reporter();
    const tests = [fakeTest('proj', 'a.spec.ts', 'kept'), fakeTest('proj', 'a.spec.ts', 'dropped')];

    await r.preprocess({
      config: fakeConfig(),
      suite: suiteWith(tests),
      testRun: fakeTestRun().testRun,
    });
    r.onBegin(fakeConfig(), suiteWith(tests));
    await r.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });

    const out = log.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toContain('✂️ Test selection');
    expect(out).toContain('selection: subset (reason: queue_rerun)');
    expect(out).toContain('reduced rerun: executing 1 previously-failing test(s), 1 deselected');
  });
});

describe('preprocess — the guards that keep the full suite running', () => {
  it('runs everything when no name in the subset is in the collection', async () => {
    // The stale-set filet: every served name was renamed since the previous
    // attempt. Excluding on that basis would leave a green run with 0 tests.
    seedState({
      selection: 'subset',
      reason: 'queue_rerun',
      tests: ['[proj] > a.spec.ts > renamed-away'],
    });
    const tests = [fakeTest('proj', 'a.spec.ts', 'one'), fakeTest('proj', 'a.spec.ts', 'two')];
    const { excluded, testRun } = fakeTestRun();

    await reporter().preprocess({ config: fakeConfig(), suite: suiteWith(tests), testRun });

    expect(excluded).toEqual([]);
  });

  it('says why the full suite ran when the subset matched nothing', async () => {
    seedState({ selection: 'subset', reason: 'queue_rerun', tests: ['[proj] > gone'] });
    const log = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const r = reporter();
    const tests = [fakeTest('proj', 'a.spec.ts', 'one')];

    await r.preprocess({
      config: fakeConfig(),
      suite: suiteWith(tests),
      testRun: fakeTestRun().testRun,
    });
    r.onBegin(fakeConfig(), suiteWith(tests));
    await r.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });

    const out = log.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toContain('selection: full (reason: subset_matched_no_collected_test)');
  });

  it('excludes nothing on a `full` selection', async () => {
    seedState({ selection: 'full', reason: 'not_a_rerun', tests: [] });
    const { excluded, testRun } = fakeTestRun();

    await reporter().preprocess({
      config: fakeConfig(),
      suite: suiteWith([fakeTest('proj', 'a.spec.ts', 'one')]),
      testRun,
    });

    expect(excluded).toEqual([]);
  });

  it('excludes nothing when globalSetup never wrote a selection', async () => {
    seedState();
    const { excluded, testRun } = fakeTestRun();

    await reporter().preprocess({
      config: fakeConfig(),
      suite: suiteWith([fakeTest('proj', 'a.spec.ts', 'one')]),
      testRun,
    });

    expect(excluded).toEqual([]);
  });

  it('excludes nothing when the state file is absent', async () => {
    delete process.env.MERGIFY_STATE_FILE;
    const { excluded, testRun } = fakeTestRun();

    await reporter().preprocess({
      config: fakeConfig(),
      suite: suiteWith([fakeTest('proj', 'a.spec.ts', 'one')]),
      testRun,
    });

    expect(excluded).toEqual([]);
  });

  it('excludes nothing when the persisted selection is malformed', async () => {
    seedState({ selection: 'subset', reason: 'queue_rerun', tests: 'not-an-array' });
    const { excluded, testRun } = fakeTestRun();

    await reporter().preprocess({
      config: fakeConfig(),
      suite: suiteWith([fakeTest('proj', 'a.spec.ts', 'one')]),
      testRun,
    });

    expect(excluded).toEqual([]);
  });

  it('excludes nothing in the flaky-detection rerun subprocess', async () => {
    // That subprocess already runs a `--test-list` narrowed to phase 1's
    // tests; filtering again could only drop reruns.
    process.env.MERGIFY_RERUN_FILE = join(cacheRoot, 'rerun.jsonl');
    seedState({ selection: 'subset', reason: 'queue_rerun', tests: ['[proj] > a.spec.ts > kept'] });
    const { excluded, testRun } = fakeTestRun();

    await reporter().preprocess({
      config: fakeConfig(),
      suite: suiteWith([
        fakeTest('proj', 'a.spec.ts', 'kept'),
        fakeTest('proj', 'a.spec.ts', 'dropped'),
      ]),
      testRun,
    });

    expect(excluded).toEqual([]);
  });

  it('never throws, whatever the suite hands back', async () => {
    seedState({ selection: 'subset', reason: 'queue_rerun', tests: ['[proj] > a.spec.ts > kept'] });
    const log = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exploding = {
      allTests: () => {
        throw new Error('suite blew up');
      },
    } as unknown as Suite;

    await expect(
      reporter().preprocess({
        config: fakeConfig(),
        suite: exploding,
        testRun: fakeTestRun().testRun,
      })
    ).resolves.toBeUndefined();

    const out = log.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toContain('test selection could not be applied');
  });
});

describe('preprocess — setup and teardown projects', () => {
  it('never excludes a dependency-project test', async () => {
    // Playwright throws on those: "these always run in full". Excluding one
    // would abort the whole run.
    seedState({ selection: 'subset', reason: 'queue_rerun', tests: ['[proj] > a.spec.ts > kept'] });
    const setupTest = fakeTest('setup', 'auth.setup.ts', 'authenticate');
    const kept = fakeTest('proj', 'a.spec.ts', 'kept');
    const dropped = fakeTest('proj', 'a.spec.ts', 'dropped');
    const { excluded, testRun } = fakeTestRun([setupTest]);

    await reporter().preprocess({
      config: fakeConfig([{ name: 'setup' }, { name: 'proj', dependencies: ['setup'] }]),
      suite: suiteWith(
        [setupTest, kept, dropped],
        [{ name: 'setup' }, { name: 'proj', dependencies: ['setup'] }]
      ),
      testRun,
    });

    expect(excluded).toEqual([dropped]);
  });

  it('never excludes a teardown-project test', async () => {
    seedState({ selection: 'subset', reason: 'queue_rerun', tests: ['[proj] > a.spec.ts > kept'] });
    const teardownTest = fakeTest('cleanup', 'cleanup.ts', 'wipe');
    const kept = fakeTest('proj', 'a.spec.ts', 'kept');
    const dropped = fakeTest('proj', 'a.spec.ts', 'dropped');
    const { excluded, testRun } = fakeTestRun([teardownTest]);

    await reporter().preprocess({
      config: fakeConfig([{ name: 'cleanup' }, { name: 'proj', teardown: 'cleanup' }]),
      suite: suiteWith(
        [teardownTest, kept, dropped],
        [{ name: 'cleanup' }, { name: 'proj', teardown: 'cleanup' }]
      ),
      testRun,
    });

    expect(excluded).toEqual([dropped]);
  });

  it('protects a whole dependency chain, including a setup project own teardown', async () => {
    seedState({ selection: 'subset', reason: 'queue_rerun', tests: ['[proj] > a.spec.ts > kept'] });
    const root = fakeTest('root-setup', 'root.setup.ts', 'boot');
    const mid = fakeTest('setup', 'auth.setup.ts', 'authenticate');
    const cleanup = fakeTest('setup-cleanup', 'cleanup.ts', 'wipe');
    const kept = fakeTest('proj', 'a.spec.ts', 'kept');
    const dropped = fakeTest('proj', 'a.spec.ts', 'dropped');
    const { excluded, testRun } = fakeTestRun([root, mid, cleanup]);

    await reporter().preprocess({
      config: fakeConfig([
        { name: 'root-setup' },
        { name: 'setup-cleanup' },
        // Reachable only through `setup`, which is itself only a dependency.
        { name: 'setup', dependencies: ['root-setup'], teardown: 'setup-cleanup' },
        { name: 'proj', dependencies: ['setup'] },
      ]),
      suite: suiteWith(
        [root, mid, cleanup, kept, dropped],
        [
          { name: 'root-setup' },
          { name: 'setup-cleanup' },
          { name: 'setup', dependencies: ['root-setup'], teardown: 'setup-cleanup' },
          { name: 'proj', dependencies: ['setup'] },
        ]
      ),
      testRun,
    });

    expect(excluded).toEqual([dropped]);
  });

  it('runs the full suite when only a dependency-project test would have matched', async () => {
    // A setup test can never be "the one previously-failing test we replay":
    // it always runs anyway. Counting it as a hit would let a stale subset
    // deselect every real test.
    seedState({
      selection: 'subset',
      reason: 'queue_rerun',
      tests: ['[setup] > auth.setup.ts > authenticate'],
    });
    const setupTest = fakeTest('setup', 'auth.setup.ts', 'authenticate');
    const one = fakeTest('proj', 'a.spec.ts', 'one');
    const { excluded, testRun } = fakeTestRun([setupTest]);

    await reporter().preprocess({
      config: fakeConfig([{ name: 'setup' }, { name: 'proj', dependencies: ['setup'] }]),
      suite: suiteWith(
        [setupTest, one],
        [{ name: 'setup' }, { name: 'proj', dependencies: ['setup'] }]
      ),
      testRun,
    });

    expect(excluded).toEqual([]);
  });
});

describe('preprocess — an older Playwright that never calls it', () => {
  it('tells the user the served subset went unused', async () => {
    seedState({ selection: 'subset', reason: 'queue_rerun', tests: ['[proj] > a.spec.ts > kept'] });
    const log = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const r = reporter();

    // No preprocess call at all — a pre-1.62 runner.
    r.onBegin(fakeConfig(), suiteWith([]));
    await r.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });

    const out = log.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toContain('does not support Reporter.preprocess()');
  });

  it('reports a served `full`, which is not the same as never being served', async () => {
    seedState({ selection: 'full', reason: 'not_a_rerun', tests: [] });
    const log = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const r = reporter();

    r.onBegin(fakeConfig(), suiteWith([]));
    await r.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });

    const out = log.mock.calls.map((c) => String(c[0])).join('');
    expect(out).not.toContain('Reporter.preprocess()');
  });

  it('stays quiet when nothing was ever served', async () => {
    seedState();
    const log = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const r = reporter();

    r.onBegin(fakeConfig(), suiteWith([]));
    await r.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });

    const out = log.mock.calls.map((c) => String(c[0])).join('');
    expect(out).not.toContain('Test selection');
  });
});
