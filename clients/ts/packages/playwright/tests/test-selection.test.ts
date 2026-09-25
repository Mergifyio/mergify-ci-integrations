import {
  InMemorySpanSink,
  nativeTestCollectionFingerprint,
  type SpanSink,
} from '@mergifyio/ci-core';
import type {
  FullConfig,
  FullResult,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The slice comes from Playwright itself, through a subprocess the reporter
// spawns. These tests stand in for that answer; that the real one is
// Playwright's own, test for test, is proven against the real runner in
// `tests/integration/sharding.test.ts`.
vi.mock('../src/shard.js', () => ({ listPlaywrightSlice: vi.fn() }));

import { MergifyReporter } from '../src/reporter.js';
import { listPlaywrightSlice } from '../src/shard.js';

interface FakeProject {
  name: string;
  dependencies?: string[];
  teardown?: string;
}

function fakeConfig(
  projects: FakeProject[] = [{ name: 'proj' }],
  extra: Partial<Pick<FullConfig, 'shard' | 'failOnFlakyTests'>> = {}
): FullConfig {
  return {
    rootDir: '/root',
    shard: null,
    failOnFlakyTests: false,
    projects: projects.map((project) => ({
      dependencies: [],
      ...project,
    })),
    ...extra,
  } as unknown as FullConfig;
}

type Outcome = ReturnType<TestCase['outcome']>;

function fakeResult(
  status: TestResult['status'],
  options: { retry?: number; duration?: number } = {}
): TestResult {
  return {
    status,
    retry: options.retry ?? 0,
    duration: options.duration ?? 10,
    startTime: new Date('2026-09-16T10:00:00Z'),
    errors: [],
  } as unknown as TestResult;
}

/** The attempts Playwright would hold for an outcome, when the test does not say. */
function resultsFor(outcome: Outcome): TestResult[] {
  switch (outcome) {
    case 'expected':
      return [fakeResult('passed')];
    case 'unexpected':
      return [fakeResult('failed')];
    case 'flaky':
      return [fakeResult('failed'), fakeResult('passed', { retry: 1 })];
    case 'skipped':
      return [fakeResult('skipped')];
  }
}

/**
 * A collected test, identified the way the reporter identifies it, holding
 * the attempts and the verdict Playwright would hold for it at the end of the
 * run (`outcome()` and `ok()` are Playwright's own rules).
 */
function fakeTest(
  project: string,
  file: string,
  title: string,
  options: {
    outcome?: Outcome;
    retries?: number;
    repeatEachIndex?: number;
    expectedStatus?: TestCase['expectedStatus'];
    results?: TestResult[];
  } = {}
): TestCase {
  const outcome = options.outcome ?? 'expected';
  return {
    // Playwright gives every test an id, unique per project and repeat index;
    // it is what a listed slice is matched on.
    id: `${project}|${file}|${title}|${options.repeatEachIndex ?? 0}`,
    title,
    titlePath: () => ['', project, file, title],
    location: { file: `/root/${file}`, line: 1, column: 1 },
    retries: options.retries ?? 0,
    repeatEachIndex: options.repeatEachIndex ?? 0,
    expectedStatus: options.expectedStatus ?? (outcome === 'skipped' ? 'skipped' : 'passed'),
    results: options.results ?? resultsFor(outcome),
    parent: { project: () => ({ name: project }) },
    outcome: () => outcome,
    ok: () => outcome !== 'unexpected',
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
function fakeTestRun(options: { readonlyTests?: TestCase[]; skipSharding?: boolean } = {}) {
  const excluded: TestCase[] = [];
  const skipSharding = vi.fn();
  const testRun = {
    exclude(test: TestCase | Suite): void {
      if (options.readonlyTests?.includes(test as TestCase)) {
        throw new Error(
          'TestRun.exclude() cannot be called on a setup or teardown project test; these always run in full.'
        );
      }
      excluded.push(test as TestCase);
    },
    ...(options.skipSharding !== false && { skipSharding }),
  };
  return { excluded, skipSharding, testRun };
}

type Answer = { selection: string; reason: string; tests?: string[]; message?: string };

/**
 * The backend as the reporter sees it: one answer for the selection, one
 * receipt for the verdict, and a log of which went out first.
 */
function fakeClient(
  answer: Answer | null | Error = { selection: 'full', reason: 'no_predecessor' },
  receipt: { truncated: boolean } | null | Error = { truncated: false }
) {
  const calls: string[] = [];
  const client = {
    fetchQuarantine: vi.fn().mockResolvedValue(null),
    fetchFlakyContext: vi.fn().mockResolvedValue(null),
    fetchTestSelection: vi.fn().mockImplementation(async () => {
      calls.push('fetchTestSelection');
      if (answer instanceof Error) throw answer;
      return answer;
    }),
    sendSessionVerdict: vi.fn().mockImplementation(async () => {
      calls.push('sendSessionVerdict');
      if (receipt instanceof Error) throw receipt;
      return receipt;
    }),
    uploadTrace: vi.fn().mockResolvedValue(undefined),
  };
  return { client, calls };
}

class OrderedSink extends InMemorySpanSink {
  constructor(private calls: string[]) {
    super();
  }
  override export(...args: Parameters<SpanSink['export']>): Promise<void> {
    this.calls.push('export');
    return super.export(...args);
  }
}

function harness(answer?: Answer | null | Error, receipt?: { truncated: boolean } | null | Error) {
  const { client, calls } = fakeClient(answer, receipt);
  const sink = new OrderedSink(calls);
  const reporter = new MergifyReporter({ sink, apiClient: client });
  return { reporter, client, calls, sink };
}

const RUN: FullResult = { status: 'passed', startTime: new Date(), duration: 1 };

let stderr: { mock: { calls: unknown[][] } };
function output(): string {
  return stderr.mock.calls.map((c) => String(c[0])).join('');
}

beforeEach(() => {
  // The coordinates the answer is keyed on: on a `pull_request` event the core
  // reads the head SHA from the event payload, so the event name is neutralised
  // for the stubbed SHA below to be the one detected.
  vi.stubEnv('GITHUB_ACTIONS', 'true');
  vi.stubEnv('GITHUB_REPOSITORY', 'test-owner/test-repo');
  vi.stubEnv('GITHUB_EVENT_NAME', 'push');
  // Our own CI runs this suite inside a pull request, where the core reads the
  // head branch from GITHUB_HEAD_REF; clear it so the stubbed ref name wins.
  vi.stubEnv('GITHUB_HEAD_REF', '');
  vi.stubEnv('GITHUB_BASE_REF', '');
  // Pinned for the same reason: the verdict carries the run id and attempt.
  vi.stubEnv('GITHUB_RUN_ID', '42');
  vi.stubEnv('GITHUB_RUN_ATTEMPT', '1');
  vi.stubEnv('GITHUB_SHA', 'cafecafe');
  vi.stubEnv('GITHUB_WORKFLOW', 'CI');
  vi.stubEnv('GITHUB_JOB', 'e2e');
  vi.stubEnv('GITHUB_REF_NAME', 'queue/main/42');
  vi.stubEnv('MERGIFY_TEST_SELECTION_ENABLE', 'true');
  vi.stubEnv('PLAYWRIGHT_MERGIFY_INCLUDE_PROJECT_IN_TEST_NAME', 'true');
  vi.stubEnv('MERGIFY_TEST_RUN_ID', '0123456789abcdef');
  vi.stubEnv('MERGIFY_RERUN_FILE', '');
  delete process.env.MERGIFY_RERUN_FILE;
  delete process.env.MERGIFY_STATE_FILE;
  delete process.env.MERGIFY_CI_DEBUG;
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const a1 = () => fakeTest('proj', 'a.spec.ts', 'one');
const a2 = () => fakeTest('proj', 'a.spec.ts', 'two');
const b1 = () => fakeTest('proj', 'b.spec.ts', 'one');

describe('preprocess — asking with what this run collected', () => {
  it('asks with the run coordinates and the fingerprint of the collected identities', async () => {
    const { reporter, client } = harness();
    const tests = [a1(), a2(), b1()];

    await reporter.preprocess({
      config: fakeConfig(),
      suite: suiteWith(tests),
      testRun: fakeTestRun().testRun,
    });

    expect(client.fetchTestSelection).toHaveBeenCalledWith(
      'queue/main/42',
      'cafecafe',
      'CI',
      'e2e',
      nativeTestCollectionFingerprint([
        '[proj] > a.spec.ts > one',
        '[proj] > a.spec.ts > two',
        '[proj] > b.spec.ts > one',
      ])
    );
    expect(reporter.getTestSelection().collection).toEqual({
      fingerprint: nativeTestCollectionFingerprint([
        '[proj] > a.spec.ts > one',
        '[proj] > a.spec.ts > two',
        '[proj] > b.spec.ts > one',
      ]),
      count: 3,
    });
  });

  it('asks under the operator-set job name when there is one', async () => {
    vi.stubEnv('MERGIFY_TEST_JOB_NAME', 'e2e-1');
    const { reporter, client } = harness();

    await reporter.preprocess({
      config: fakeConfig(),
      suite: suiteWith([a1()]),
      testRun: fakeTestRun().testRun,
    });

    expect(client.fetchTestSelection.mock.calls[0]?.[3]).toBe('e2e-1');
  });

  it('counts a test collected in two projects once when project prefixing is off', async () => {
    // One identity the engine stores once is one entry of the collection.
    vi.stubEnv('PLAYWRIGHT_MERGIFY_INCLUDE_PROJECT_IN_TEST_NAME', 'false');
    const { reporter, client } = harness();
    const tests = [
      fakeTest('chromium', 'a.spec.ts', 'one'),
      fakeTest('firefox', 'a.spec.ts', 'one'),
    ];

    await reporter.preprocess({
      config: fakeConfig([{ name: 'chromium' }, { name: 'firefox' }]),
      suite: suiteWith(tests),
      testRun: fakeTestRun().testRun,
    });

    expect(client.fetchTestSelection.mock.calls[0]?.[4]).toBe(
      nativeTestCollectionFingerprint(['a.spec.ts > one'])
    );
    expect(reporter.getTestSelection().collection?.count).toBe(1);
  });

  it('leaves setup and teardown project tests out of the collection', async () => {
    const { reporter, client } = harness();
    const setup = fakeTest('setup', 'setup.ts', 'login');
    const test = fakeTest('e2e', 'a.spec.ts', 'one');

    await reporter.preprocess({
      config: fakeConfig(),
      suite: suiteWith(
        [setup, test],
        [{ name: 'setup' }, { name: 'e2e', dependencies: ['setup'] }]
      ),
      testRun: fakeTestRun({ readonlyTests: [setup] }).testRun,
    });

    expect(client.fetchTestSelection.mock.calls[0]?.[4]).toBe(
      nativeTestCollectionFingerprint(['[e2e] > a.spec.ts > one'])
    );
    expect(reporter.getTestSelection().collection?.count).toBe(1);
  });

  it('asks for nothing when the job did not opt in', async () => {
    vi.stubEnv('MERGIFY_TEST_SELECTION_ENABLE', '');
    const { reporter, client } = harness();
    const { testRun, skipSharding } = fakeTestRun();

    await reporter.preprocess({
      config: fakeConfig([{ name: 'proj' }], { shard: { current: 1, total: 2 } }),
      suite: suiteWith([a1(), b1()]),
      testRun,
    });

    expect(client.fetchTestSelection).not.toHaveBeenCalled();
    expect(skipSharding).not.toHaveBeenCalled();
    expect(reporter.getTestSelection().collection).toBeUndefined();
  });

  it('asks for nothing in the flaky-detection rerun subprocess', async () => {
    vi.stubEnv('MERGIFY_RERUN_FILE', '/tmp/rerun.jsonl');
    const { reporter, client } = harness();

    await reporter.preprocess({
      config: fakeConfig(),
      suite: suiteWith([a1()]),
      testRun: fakeTestRun().testRun,
    });

    expect(client.fetchTestSelection).not.toHaveBeenCalled();
  });

  it('never throws, whatever the suite hands back', async () => {
    const { reporter } = harness({ selection: 'subset', reason: 'queue_rerun', tests: ['x'] });
    const broken = {
      suites: [],
      allTests: () => {
        throw new Error('suite exploded');
      },
    } as unknown as Suite;

    await expect(
      reporter.preprocess({ config: fakeConfig(), suite: broken, testRun: fakeTestRun().testRun })
    ).resolves.toBeUndefined();
    expect(output()).toContain('test selection could not be applied');
  });
});

describe('preprocess — acting on the answer', () => {
  it('excludes every collected test a subset does not name', async () => {
    const { reporter } = harness({
      selection: 'subset',
      reason: 'queue_rerun',
      tests: ['[proj] > a.spec.ts > one'],
    });
    const [kept, dropped, alsoDropped] = [a1(), a2(), b1()];
    const { excluded, testRun } = fakeTestRun();

    await reporter.preprocess({
      config: fakeConfig(),
      suite: suiteWith([kept, dropped, alsoDropped]),
      testRun,
    });

    expect(excluded).toEqual([dropped, alsoDropped]);
    expect(reporter.getTestSelection().application?.outcome).toBe('subset');
  });

  it('keeps the same logical test in every project it was collected in', async () => {
    vi.stubEnv('PLAYWRIGHT_MERGIFY_INCLUDE_PROJECT_IN_TEST_NAME', 'false');
    const { reporter } = harness({
      selection: 'subset',
      reason: 'queue_rerun',
      tests: ['a.spec.ts > one'],
    });
    const keptChromium = fakeTest('chromium', 'a.spec.ts', 'one');
    const keptFirefox = fakeTest('firefox', 'a.spec.ts', 'one');
    const dropped = fakeTest('chromium', 'a.spec.ts', 'two');
    const { excluded, testRun } = fakeTestRun();

    await reporter.preprocess({
      config: fakeConfig([{ name: 'chromium' }, { name: 'firefox' }]),
      suite: suiteWith([keptChromium, keptFirefox, dropped]),
      testRun,
    });

    expect(excluded).toEqual([dropped]);
  });

  it('runs everything when a served name is not in this collection', async () => {
    // All or nothing: the intersection would be a reduced run over an
    // arbitrary part of what was asked for.
    const { reporter } = harness({
      selection: 'subset',
      reason: 'queue_rerun',
      tests: ['[proj] > a.spec.ts > one', '[proj] > a.spec.ts > renamed'],
    });
    const { excluded, testRun } = fakeTestRun();

    await reporter.preprocess({ config: fakeConfig(), suite: suiteWith([a1(), a2()]), testRun });

    expect(excluded).toEqual([]);
    expect(reporter.getTestSelection().application?.notAppliedReason).toBe(
      'subset_partly_absent_from_collection'
    );
  });

  it('excludes nothing on a full answer', async () => {
    const { reporter } = harness({ selection: 'full', reason: 'no_predecessor' });
    const { excluded, testRun } = fakeTestRun();

    await reporter.preprocess({ config: fakeConfig(), suite: suiteWith([a1(), a2()]), testRun });

    expect(excluded).toEqual([]);
    expect(reporter.getTestSelection().application?.outcome).toBe('full');
  });

  it('excludes nothing when the request failed, and still records that it asked', async () => {
    const { reporter } = harness(new Error('Mergify API returned HTTP 500'));
    const { excluded, testRun } = fakeTestRun();

    await reporter.preprocess({ config: fakeConfig(), suite: suiteWith([a1()]), testRun });

    expect(excluded).toEqual([]);
    expect(reporter.getTestSelection().collection).toBeDefined();
    expect(reporter.getTestSelection().application?.selection.fetchError).toBe(
      'Mergify API returned HTTP 500'
    );
  });

  it('excludes every collected test on an `empty` answer, readonly ones aside', async () => {
    const { reporter } = harness({ selection: 'empty', reason: 'queue_rerun' });
    const setup = fakeTest('setup', 'setup.ts', 'login');
    const tests = [fakeTest('e2e', 'a.spec.ts', 'one'), fakeTest('e2e', 'b.spec.ts', 'one')];
    const { excluded, testRun } = fakeTestRun({ readonlyTests: [setup] });

    await reporter.preprocess({
      config: fakeConfig(),
      suite: suiteWith(
        [setup, ...tests],
        [{ name: 'setup' }, { name: 'e2e', dependencies: ['setup'] }]
      ),
      testRun,
    });

    expect(excluded).toEqual(tests);
    expect(reporter.getTestSelection().application?.outcome).toBe('empty');
  });

  it('prints the server message and excludes everything on a refusal', async () => {
    const { reporter } = harness({
      selection: 'refused',
      reason: 'ambiguous_test_sessions',
      message: 'Several runs of `e2e` reported the same tests.',
    });
    const tests = [a1(), a2()];
    const { excluded, testRun } = fakeTestRun();

    await reporter.preprocess({ config: fakeConfig(), suite: suiteWith(tests), testRun });

    expect(excluded).toEqual(tests);
    expect(output()).toContain('Several runs of `e2e` reported the same tests.\n');
  });

  it('falls back to its own wording when the refusal carries no message', async () => {
    const { reporter } = harness({ selection: 'refused', reason: 'ambiguous_test_sessions' });

    await reporter.preprocess({
      config: fakeConfig(),
      suite: suiteWith([a1()]),
      testRun: fakeTestRun().testRun,
    });

    expect(output()).toContain('Mergify Test Selection stopped this run.');
    expect(output()).toContain('https://docs.mergify.com/ci-insights/test-frameworks/playwright/');
  });
});

describe("preprocess — a sharded run is this leg's own", () => {
  // `vi.fn()` mocks are not touched by `restoreAllMocks`, so without this a
  // test that forgets to arm the listing silently inherits its neighbour's --
  // and `collection()` mints the same ids every time, so it would match.
  beforeEach(() => {
    vi.mocked(listPlaywrightSlice).mockReset();
  });

  const sharded = (current: number, total = 2) =>
    fakeConfig([{ name: 'proj' }], { shard: { current, total } });
  const collection = () => [a1(), a2(), b1(), fakeTest('proj', 'c.spec.ts', 'one')];
  // The listing always reports the whole corpus it saw plus this leg's slice;
  // the reporter refuses anything whose corpus is not, as a set, what it
  // collected itself.
  const listed = (corpus: TestCase[], ...slice: TestCase[]) =>
    vi.mocked(listPlaywrightSlice).mockReturnValue({
      corpus: corpus.map((test) => test.id),
      slice: slice.map((test) => test.id),
    });

  it('takes sharding over and fingerprints the slice Playwright gave it', async () => {
    const { reporter, client } = harness();
    const tests = collection();
    const { excluded, testRun, skipSharding } = fakeTestRun();
    listed(tests, tests[0], tests[1]);

    await reporter.preprocess({ config: sharded(1), suite: suiteWith(tests), testRun });

    expect(skipSharding).toHaveBeenCalledOnce();
    expect(excluded).toEqual([tests[2], tests[3]]);
    expect(client.fetchTestSelection.mock.calls[0]?.[4]).toBe(
      nativeTestCollectionFingerprint(['[proj] > a.spec.ts > one', '[proj] > a.spec.ts > two'])
    );
    expect(reporter.getTestSelection().collection?.count).toBe(2);
  });

  it('takes the complement on the other leg, whatever Playwright decided', async () => {
    const { reporter, client } = harness();
    const tests = collection();
    const { excluded, testRun } = fakeTestRun();
    listed(tests, tests[2], tests[3]);

    await reporter.preprocess({ config: sharded(2), suite: suiteWith(tests), testRun });

    expect(excluded).toEqual([tests[0], tests[1]]);
    expect(client.fetchTestSelection.mock.calls[0]?.[4]).toBe(
      nativeTestCollectionFingerprint(['[proj] > b.spec.ts > one', '[proj] > c.spec.ts > one'])
    );
  });

  it('runs exactly the served subset on the leg, without a second split', async () => {
    const { reporter } = harness({
      selection: 'subset',
      reason: 'queue_rerun',
      tests: ['[proj] > a.spec.ts > two'],
    });
    const tests = collection();
    const { excluded, testRun, skipSharding } = fakeTestRun();
    listed(tests, tests[0], tests[1]);

    await reporter.preprocess({ config: sharded(1), suite: suiteWith(tests), testRun });

    expect(skipSharding).toHaveBeenCalledOnce();
    expect([...excluded].sort((x, y) => x.id.localeCompare(y.id))).toEqual([
      tests[0],
      tests[2],
      tests[3],
    ]);
  });

  // Whatever goes wrong with the listing, the leg has to end up running what
  // Playwright would have given it -- never a slice the reporter guessed, and
  // never a green leg that executed nothing.
  describe('when Playwright cannot say which tests this leg owns', () => {
    it('leaves sharding to Playwright and asks Mergify nothing', async () => {
      const { reporter, client } = harness();
      const { excluded, testRun, skipSharding } = fakeTestRun();
      vi.mocked(listPlaywrightSlice).mockReturnValue(null);

      await reporter.preprocess({ config: sharded(1), suite: suiteWith(collection()), testRun });

      expect(skipSharding).not.toHaveBeenCalled();
      expect(excluded).toEqual([]);
      expect(client.fetchTestSelection).not.toHaveBeenCalled();
    });

    it('says so in the block, so an unreduced shard is explained', async () => {
      const { reporter } = harness();
      vi.mocked(listPlaywrightSlice).mockReturnValue(null);
      const config = sharded(1);
      const suite = suiteWith(collection());

      await reporter.preprocess({ config, suite, testRun: fakeTestRun().testRun });
      reporter.onBegin(config, suite);
      await reporter.onEnd({ ...RUN, status: 'passed' });

      expect(output()).toContain(
        "Mergify couldn't tell which tests this shard owns, so the shard ran in full."
      );
    });

    it('keeps its own slice, and only that, when the request to Mergify failed', async () => {
      // The shard exclusion has already happened when the answer fails to
      // arrive, and it must stand: a leg that fell back to the whole corpus
      // would run what every other leg is also running, N times over.
      const { reporter } = harness(new Error('Mergify API returned HTTP 500'));
      const tests = collection();
      const { excluded, testRun } = fakeTestRun();
      listed(tests, tests[0], tests[1]);

      await reporter.preprocess({ config: sharded(1), suite: suiteWith(tests), testRun });

      expect(excluded).toEqual([tests[2], tests[3]]);
      expect(reporter.getTestSelection().application?.selection.fetchError).toBe(
        'Mergify API returned HTTP 500'
      );
    });

    // The two directions are not symmetric in their consequence. A surplus
    // fingerprints tests the leg never runs; a DEFICIT excludes tests the leg
    // owns, on every leg, and the job goes green having skipped them. Only the
    // second one loses tests, and it is the one a count-based guard missed.
    it('refuses a listing that names a test this run does not have', async () => {
      const { reporter, client } = harness();
      const tests = collection();
      const { excluded, testRun, skipSharding } = fakeTestRun();
      vi.mocked(listPlaywrightSlice).mockReturnValue({
        corpus: [...tests.map((test) => test.id), 'a-test-from-elsewhere'],
        slice: [tests[0].id],
      });

      await reporter.preprocess({ config: sharded(1), suite: suiteWith(tests), testRun });

      expect(skipSharding).not.toHaveBeenCalled();
      expect(excluded).toEqual([]);
      expect(client.fetchTestSelection).not.toHaveBeenCalled();
    });

    it('refuses a listing that MISSED a test this run has', async () => {
      const { reporter, client } = harness();
      const tests = collection();
      const { excluded, testRun, skipSharding } = fakeTestRun();
      // Playwright's JSON reporter used to collapse a spec shared by several
      // projects into one id. Both sides then shrank together, a count-based
      // guard saw nothing, and the tests it omitted ran on no leg at all.
      listed(tests.slice(0, 2), tests[0]);

      await reporter.preprocess({ config: sharded(1), suite: suiteWith(tests), testRun });

      expect(skipSharding).not.toHaveBeenCalled();
      expect(excluded).toEqual([]);
      expect(client.fetchTestSelection).not.toHaveBeenCalled();
    });

    it('refuses a slice holding something outside the corpus it listed', async () => {
      const { reporter, client } = harness();
      const tests = collection();
      const { excluded, testRun, skipSharding } = fakeTestRun();
      vi.mocked(listPlaywrightSlice).mockReturnValue({
        corpus: tests.map((test) => test.id),
        slice: [tests[0].id, 'a-test-from-elsewhere'],
      });

      await reporter.preprocess({ config: sharded(1), suite: suiteWith(tests), testRun });

      expect(skipSharding).not.toHaveBeenCalled();
      expect(excluded).toEqual([]);
      expect(client.fetchTestSelection).not.toHaveBeenCalled();
    });
  });

  it('never hands sharding over on a Playwright that cannot take it back', async () => {
    const { reporter, client } = harness();
    const { excluded, testRun } = fakeTestRun({ skipSharding: false });

    await reporter.preprocess({ config: sharded(1), suite: suiteWith(collection()), testRun });

    expect(client.fetchTestSelection).not.toHaveBeenCalled();
    expect(excluded).toEqual([]);
    expect(output()).toContain('cannot hand sharding to a reporter');
  });
});

describe('the session verdict', () => {
  async function run(
    reporter: MergifyReporter,
    tests: TestCase[],
    results: Array<[TestCase, TestResult]>,
    config = fakeConfig(),
    result = RUN
  ) {
    const suite = suiteWith(tests);
    await reporter.preprocess({ config, suite, testRun: fakeTestRun().testRun });
    reporter.onBegin(config, suite);
    for (const [test, testResult] of results) reporter.onTestEnd(test, testResult);
    return reporter.onEnd(result);
  }

  it('is sent before the trace, from what Playwright concluded of every test', async () => {
    const { reporter, client, calls } = harness({ selection: 'full', reason: 'no_predecessor' });
    const passed = fakeTest('proj', 'a.spec.ts', 'one', {
      results: [fakeResult('passed', { duration: 100 })],
    });
    const failed = fakeTest('proj', 'a.spec.ts', 'two', {
      outcome: 'unexpected',
      retries: 1,
      results: [
        fakeResult('failed', { duration: 50 }),
        fakeResult('failed', { retry: 1, duration: 50 }),
      ],
    });
    const flaky = fakeTest('proj', 'b.spec.ts', 'one', {
      outcome: 'flaky',
      retries: 1,
      results: [
        fakeResult('failed', { duration: 10 }),
        fakeResult('passed', { retry: 1, duration: 10 }),
      ],
    });
    // A `test.fail()` that failed as announced: Playwright's exit code is
    // green on it, so the verdict is too.
    const expectedFailure = fakeTest('proj', 'b.spec.ts', 'two', {
      expectedStatus: 'failed',
      results: [fakeResult('failed', { duration: 5 })],
    });
    const skipped = fakeTest('proj', 'b.spec.ts', 'three', {
      outcome: 'skipped',
      results: [fakeResult('skipped', { duration: 0 })],
    });
    const tests = [passed, failed, flaky, expectedFailure, skipped];

    await run(
      reporter,
      tests,
      tests.flatMap((test) =>
        test.results.map((result) => [test, result] as [TestCase, TestResult])
      ),
      fakeConfig(),
      { ...RUN, status: 'failed' }
    );

    expect(calls).toEqual(['fetchTestSelection', 'sendSessionVerdict', 'export']);
    expect(client.sendSessionVerdict).toHaveBeenCalledWith({
      testRunId: '0123456789abcdef',
      headSha: 'cafecafe',
      headBranch: 'queue/main/42',
      pipelineName: 'CI',
      jobName: 'e2e',
      runId: '42',
      runAttempt: 1,
      collectionFingerprint: nativeTestCollectionFingerprint([
        '[proj] > a.spec.ts > one',
        '[proj] > a.spec.ts > two',
        '[proj] > b.spec.ts > one',
        '[proj] > b.spec.ts > two',
        '[proj] > b.spec.ts > three',
      ]),
      collectionCount: 5,
      executedCount: 5,
      passedCount: 3,
      failedCount: 1,
      skippedCount: 1,
      totalTestRuntimeMs: 225,
      failingTests: ['[proj] > a.spec.ts > two'],
      quarantinedFailingTests: [],
      selection: { answer: 'full', reason: 'no_predecessor', keptCount: 5 },
    });
  });

  it('replays a test that did not run because something before it failed', async () => {
    // Playwright reports the rest of a file after a `beforeAll` threw, the
    // followers of a serial group and the remainder of a crashed worker as
    // `skipped` without having asked for it. They never ran on this commit:
    // read as "already passed", a rerun would go green over them.
    const { reporter, client } = harness();
    const culprit = fakeTest('proj', 'c.spec.ts', 'first', { outcome: 'unexpected' });
    const follower = fakeTest('proj', 'c.spec.ts', 'second', {
      outcome: 'skipped',
      expectedStatus: 'passed',
      results: [fakeResult('skipped')],
    });
    const asked = fakeTest('proj', 'c.spec.ts', 'third', { outcome: 'skipped' });

    await run(reporter, [culprit, follower, asked], []);

    expect(client.sendSessionVerdict.mock.calls[0]?.[0]).toMatchObject({
      executedCount: 3,
      failedCount: 2,
      skippedCount: 1,
      failingTests: ['[proj] > c.spec.ts > first', '[proj] > c.spec.ts > second'],
    });
  });

  it('does not count a test that never started, so the session reads as incomplete', async () => {
    // The dependents of a failed setup project: no attempt at all.
    const { reporter, client } = harness();
    const setup = fakeTest('setup', 'setup.ts', 'login', { outcome: 'unexpected' });
    const dependent = fakeTest('e2e', 'a.spec.ts', 'one', { results: [] });
    const config = fakeConfig();
    const suite = suiteWith(
      [setup, dependent],
      [{ name: 'setup' }, { name: 'e2e', dependencies: ['setup'] }]
    );
    await reporter.preprocess({
      config,
      suite,
      testRun: fakeTestRun({ readonlyTests: [setup] }).testRun,
    });
    reporter.onBegin(config, suite);
    await reporter.onEnd({ ...RUN, status: 'failed' });

    expect(client.sendSessionVerdict.mock.calls[0]?.[0]).toMatchObject({
      collectionCount: 1,
      executedCount: 0,
      failingTests: [],
    });
  });

  it('reads a retried test off its last word, not off every attempt', async () => {
    // A `test.fail()` that passed once and then failed as announced is flaky
    // to Playwright, and the job is green: the verdict must not keep the
    // first attempt's failure.
    const { reporter, client } = harness();
    const healed = fakeTest('proj', 'a.spec.ts', 'one', {
      outcome: 'flaky',
      expectedStatus: 'failed',
      retries: 1,
      results: [fakeResult('passed'), fakeResult('failed', { retry: 1 })],
    });

    await run(reporter, [healed], []);

    expect(client.sendSessionVerdict.mock.calls[0]?.[0]).toMatchObject({
      passedCount: 1,
      failedCount: 0,
      failingTests: [],
    });
  });

  it('counts a flaky test as failed when the run is configured to fail on it', async () => {
    const { reporter, client } = harness();
    const flaky = fakeTest('proj', 'a.spec.ts', 'one', { outcome: 'flaky', retries: 1 });

    await run(reporter, [flaky], [], fakeConfig([{ name: 'proj' }], { failOnFlakyTests: true }));

    expect(client.sendSessionVerdict.mock.calls[0]?.[0]).toMatchObject({
      failingTests: ['[proj] > a.spec.ts > one'],
      failedCount: 1,
    });
  });

  it('lists a quarantine-absorbed failure apart from the failures', async () => {
    const { reporter, client } = harness();
    const absorbed = fakeTest('proj', 'a.spec.ts', 'one', {
      outcome: 'expected',
      retries: 1,
      results: [fakeResult('failed')],
    });
    absorbed.annotations.push({ type: 'mergify:quarantined' });

    await run(reporter, [absorbed], [[absorbed, fakeResult('failed')]]);

    expect(client.sendSessionVerdict.mock.calls[0]?.[0]).toMatchObject({
      failingTests: [],
      quarantinedFailingTests: ['[proj] > a.spec.ts > one'],
      failedCount: 1,
      passedCount: 0,
    });
  });

  it('folds a shared identity to its worst status across projects', async () => {
    vi.stubEnv('PLAYWRIGHT_MERGIFY_INCLUDE_PROJECT_IN_TEST_NAME', 'false');
    const { reporter, client } = harness();
    const chromium = fakeTest('chromium', 'a.spec.ts', 'one', { outcome: 'unexpected' });
    const firefox = fakeTest('firefox', 'a.spec.ts', 'one');

    await run(
      reporter,
      [chromium, firefox],
      [],
      fakeConfig([{ name: 'chromium' }, { name: 'firefox' }])
    );

    expect(client.sendSessionVerdict.mock.calls[0]?.[0]).toMatchObject({
      collectionCount: 1,
      executedCount: 1,
      failedCount: 1,
      failingTests: ['a.spec.ts > one'],
    });
  });

  it('echoes the answer and what the run made of it', async () => {
    const { reporter, client } = harness({
      selection: 'subset',
      reason: 'queue_rerun',
      tests: ['[proj] > a.spec.ts > one', '[proj] > a.spec.ts > gone'],
    });
    const test = a1();

    await run(reporter, [test], [[test, fakeResult('passed')]]);

    expect(client.sendSessionVerdict.mock.calls[0]?.[0]).toMatchObject({
      selection: {
        answer: 'subset',
        reason: 'queue_rerun',
        keptCount: 1,
        notAppliedReason: 'subset_partly_absent_from_collection',
      },
    });
  });

  it('is sent when the selection request failed: the next rerun still needs it', async () => {
    const { reporter, client } = harness(new Error('Mergify API returned HTTP 500'));
    const test = a1();

    await run(reporter, [test], [[test, fakeResult('passed')]]);

    expect(client.sendSessionVerdict).toHaveBeenCalledOnce();
    // Nothing was served, so nothing is echoed.
    expect(client.sendSessionVerdict.mock.calls[0]?.[0].selection).toBeUndefined();
  });

  it('is not sent when the run never asked', async () => {
    vi.stubEnv('MERGIFY_TEST_SELECTION_ENABLE', '');
    const { reporter, client } = harness();
    const test = a1();

    await run(reporter, [test], [[test, fakeResult('passed')]]);

    expect(client.sendSessionVerdict).not.toHaveBeenCalled();
    expect(output()).not.toContain('✂️');
  });

  it('never fails the run, and says the reduction is lost, when it does not land', async () => {
    const { reporter, sink } = harness(undefined, new Error('Mergify API returned HTTP 503'));
    const test = a1();

    const override = await run(reporter, [test], [[test, fakeResult('passed')]]);

    expect(override).toBeUndefined();
    expect(sink.getFinishedSpans().length).toBeGreaterThan(0);
    expect(output()).toContain(
      "Mergify couldn't record this run's results. If this merge-queue batch is\n" +
        'retried, this job will run its full test suite.\n' +
        'Error: Mergify API returned HTTP 503\n'
    );
  });

  it('is printed rather than sent in debug mode', async () => {
    vi.stubEnv('MERGIFY_CI_DEBUG', 'true');
    const { reporter, client } = harness();
    const test = a1();

    await run(reporter, [test], [[test, fakeResult('passed')]]);

    expect(client.sendSessionVerdict).not.toHaveBeenCalled();
    expect(output()).toContain('[mergify] session verdict {"testRunId":"0123456789abcdef"');
  });

  it('puts the collection and the echo on the session resource', async () => {
    const { reporter, sink } = harness({ selection: 'empty', reason: 'queue_rerun' });
    const test = a1();

    await run(reporter, [test], [], fakeConfig(), { ...RUN, status: 'failed' });

    const resource = sink.getFinishedSpans()[0]?.resourceAttributes;
    expect(resource).toMatchObject({
      'test.collection.fingerprint': nativeTestCollectionFingerprint(['[proj] > a.spec.ts > one']),
      'test.collection.count': 1,
      'test.selection.answer': 'empty',
      'test.selection.reason': 'queue_rerun',
      'test.selection.kept_count': 0,
    });
    expect(resource).not.toHaveProperty('test.selection.not_applied_reason');
  });
});

describe('the end of the run', () => {
  async function endOf(reporter: MergifyReporter, tests: TestCase[], status: FullResult['status']) {
    const config = fakeConfig();
    const suite = suiteWith(tests);
    await reporter.preprocess({ config, suite, testRun: fakeTestRun().testRun });
    reporter.onBegin(config, suite);
    return reporter.onEnd({ ...RUN, status });
  }

  it('turns "No tests found" into a pass when Mergify emptied the run', async () => {
    const { reporter } = harness({ selection: 'empty', reason: 'queue_rerun' });

    expect(await endOf(reporter, [a1(), a2()], 'failed')).toEqual({ status: 'passed' });
    expect(reporter.getSession()?.status).toBe('passed');
    expect(output()).toContain(
      "The code under test hasn't changed since the previous attempt of this job, and\n" +
        'all 2 tests passed back then. Mergify skipped them: the job is green, and no\n' +
        'test was executed.\n'
    );
  });

  it('turns only Playwright\'s own "No tests found" into a pass', async () => {
    const { reporter } = harness({ selection: 'empty', reason: 'queue_rerun' });
    const config = fakeConfig();
    const suite = suiteWith([a1()]);
    await reporter.preprocess({ config, suite, testRun: fakeTestRun().testRun });
    reporter.onBegin(config, suite);
    reporter.onError({ message: 'Error: No tests found' });

    expect(await reporter.onEnd({ ...RUN, status: 'failed' })).toEqual({ status: 'passed' });
  });

  it('leaves an emptied run red when a run-level error was reported', async () => {
    // A global teardown still runs on an emptied suite; its failure reaches
    // the reporter through `onError` alone, with no test to carry it.
    const { reporter } = harness({ selection: 'empty', reason: 'queue_rerun' });
    const config = fakeConfig();
    const suite = suiteWith([a1()]);
    await reporter.preprocess({ config, suite, testRun: fakeTestRun().testRun });
    reporter.onBegin(config, suite);
    reporter.onError({ message: 'Error: No tests found' });
    reporter.onError({ message: 'Error: global teardown exploded' });

    expect(await reporter.onEnd({ ...RUN, status: 'failed' })).toBeUndefined();
    expect(reporter.getSession()?.status).toBe('failed');
  });

  it('leaves an emptied run red when something that still ran failed', async () => {
    // A setup project runs whatever the answer; its failure is the run's.
    const { reporter } = harness({ selection: 'empty', reason: 'queue_rerun' });
    const setup = fakeTest('setup', 'setup.ts', 'login', { outcome: 'unexpected' });
    const config = fakeConfig();
    const suite = suiteWith(
      [setup, a1()],
      [{ name: 'setup' }, { name: 'proj', dependencies: ['setup'] }]
    );
    await reporter.preprocess({
      config,
      suite,
      testRun: fakeTestRun({ readonlyTests: [setup] }).testRun,
    });
    reporter.onBegin(config, suite);
    reporter.onTestEnd(setup, fakeResult('failed'));

    expect(await reporter.onEnd({ ...RUN, status: 'failed' })).toBeUndefined();
  });

  it('fails the run on a refusal, whatever Playwright made of the empty suite', async () => {
    const { reporter, sink } = harness({
      selection: 'refused',
      reason: 'ambiguous_test_sessions',
      message: 'x',
    });

    expect(await endOf(reporter, [a1()], 'passed')).toEqual({ status: 'failed' });
    expect(reporter.getSession()?.status).toBe('failed');
    expect(sink.getFinishedSpans().at(-1)?.status).toBe('error');
    expect(output()).toContain('its explanation is in the error\nabove.');
  });

  it('reports the reduction', async () => {
    const { reporter } = harness({
      selection: 'subset',
      reason: 'queue_rerun',
      tests: ['[proj] > a.spec.ts > one'],
    });

    await endOf(reporter, [a1(), a2()], 'passed');

    expect(output()).toContain(
      '✂️ Test selection\n' +
        '\n' +
        "The code under test hasn't changed since the previous attempt of this job, where\n" +
        '1 of its 2 tests failed. Mergify re-executed only that one and skipped the 1\n' +
        'that had already passed:\n' +
        '\n' +
        '  [proj] > a.spec.ts > one\n'
    );
  });

  it('says why the full suite ran', async () => {
    const { reporter } = harness({ selection: 'full', reason: 'no_predecessor' });

    await endOf(reporter, [a1()], 'passed');

    expect(output()).toContain('First attempt of this batch, so the full suite ran.');
  });
});

describe('an older Playwright that never calls preprocess', () => {
  it('tells an opted-in job to upgrade', async () => {
    const { reporter } = harness();
    const config = fakeConfig();
    reporter.onBegin(config, suiteWith([a1()]));
    await reporter.onEnd(RUN);

    expect(output()).toContain('does not support Reporter.preprocess() (added in 1.62)');
  });

  it('stays quiet when the job never opted in', async () => {
    vi.stubEnv('MERGIFY_TEST_SELECTION_ENABLE', '');
    const { reporter } = harness();
    const config = fakeConfig();
    reporter.onBegin(config, suiteWith([a1()]));
    await reporter.onEnd(RUN);

    expect(output()).not.toContain('preprocess');
  });
});
