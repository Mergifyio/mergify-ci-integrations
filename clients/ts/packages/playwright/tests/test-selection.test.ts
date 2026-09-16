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
import { MergifyReporter, shardSlice } from '../src/reporter.js';

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

/** The backend as the reporter sees it: one answer for the selection. */
function fakeClient(
  answer: Answer | null | Error = { selection: 'full', reason: 'no_predecessor' }
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

function harness(answer?: Answer | null | Error) {
  const { client, calls } = fakeClient(answer);
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
  const sharded = (current: number, total = 2) =>
    fakeConfig([{ name: 'proj' }], { shard: { current, total } });
  const collection = () => [a1(), a2(), b1(), fakeTest('proj', 'c.spec.ts', 'one')];

  it('takes sharding over and fingerprints its own slice', async () => {
    const { reporter, client } = harness();
    const tests = collection();
    const { excluded, testRun, skipSharding } = fakeTestRun();

    await reporter.preprocess({ config: sharded(1), suite: suiteWith(tests), testRun });

    expect(skipSharding).toHaveBeenCalledOnce();
    // Four tests over two legs: `a.spec.ts` (2) lands on leg 1, the rest on leg 2.
    expect(excluded).toEqual([tests[2], tests[3]]);
    expect(client.fetchTestSelection.mock.calls[0]?.[4]).toBe(
      nativeTestCollectionFingerprint(['[proj] > a.spec.ts > one', '[proj] > a.spec.ts > two'])
    );
    expect(reporter.getTestSelection().collection?.count).toBe(2);
  });

  it('gives the other leg the complement, so the two cover the whole suite', async () => {
    const { reporter, client } = harness();
    const tests = collection();
    const { excluded, testRun } = fakeTestRun();

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

    await reporter.preprocess({ config: sharded(1), suite: suiteWith(tests), testRun });

    expect(skipSharding).toHaveBeenCalledOnce();
    expect(excluded).toEqual([tests[2], tests[3], tests[0]]);
  });

  it('runs its own slice in full when the request failed: no leg covers for another', async () => {
    const { reporter } = harness(new Error('Mergify API returned HTTP 500'));
    const tests = collection();
    const { excluded, testRun } = fakeTestRun();

    await reporter.preprocess({ config: sharded(1), suite: suiteWith(tests), testRun });

    expect(excluded).toEqual([tests[2], tests[3]]);
  });

  it("reads the legs' weights from PWTEST_SHARD_WEIGHTS", async () => {
    vi.stubEnv('PWTEST_SHARD_WEIGHTS', '3:1');
    const { reporter } = harness();
    const tests = collection();
    const { excluded, testRun } = fakeTestRun();

    await reporter.preprocess({ config: sharded(1), suite: suiteWith(tests), testRun });

    // Four tests, weights 3:1: leg 1 takes three, so `b.spec.ts` joins it.
    expect(excluded).toEqual([tests[3]]);
  });

  it('weights the legs equally when PWTEST_SHARD_WEIGHTS does not fit the run', async () => {
    vi.stubEnv('PWTEST_SHARD_WEIGHTS', '1:2:3');
    const { reporter } = harness();
    const tests = collection();
    const { excluded, testRun } = fakeTestRun();

    await reporter.preprocess({ config: sharded(1), suite: suiteWith(tests), testRun });

    expect(excluded).toEqual([tests[2], tests[3]]);
    expect(output()).toContain('PWTEST_SHARD_WEIGHTS="1:2:3" does not name 2 non-negative weights');
  });

  it('accepts a zero weight, as Playwright does', async () => {
    vi.stubEnv('PWTEST_SHARD_WEIGHTS', '0:1');
    const { reporter } = harness();
    const tests = collection();
    const { excluded, testRun } = fakeTestRun();

    await reporter.preprocess({ config: sharded(1), suite: suiteWith(tests), testRun });

    // Leg 1 weighs nothing: everything is leg 2's.
    expect(excluded).toEqual(tests);
  });

  it('does not touch sharding when the run is not sharded', async () => {
    const { reporter } = harness();
    const { testRun, skipSharding } = fakeTestRun();

    await reporter.preprocess({ config: fakeConfig(), suite: suiteWith(collection()), testRun });

    expect(skipSharding).not.toHaveBeenCalled();
  });

  it('does not ask when this Playwright cannot hand sharding over', async () => {
    const { reporter, client } = harness();
    const { excluded, testRun } = fakeTestRun({ skipSharding: false });

    await reporter.preprocess({ config: sharded(1), suite: suiteWith(collection()), testRun });

    expect(client.fetchTestSelection).not.toHaveBeenCalled();
    expect(excluded).toEqual([]);
    expect(output()).toContain('cannot hand sharding to a reporter');
  });
});

describe('shardSlice', () => {
  const entries = (units: string[]) => units.map((unit, i) => ({ unit, i }));

  it('keeps a unit whole, on the leg its first entry falls in', () => {
    // Seven entries over two legs: sizes 4 and 3. `b` starts at index 3,
    // inside leg 1's range, so leg 1 takes all of `b` and runs five.
    const all = entries(['a', 'a', 'a', 'b', 'b', 'c', 'c']);

    expect([...shardSlice(all, { current: 1, total: 2 })].map((e) => e.i)).toEqual([0, 1, 2, 3, 4]);
    expect([...shardSlice(all, { current: 2, total: 2 })].map((e) => e.i)).toEqual([5, 6]);
  });

  it('partitions: every entry lands on exactly one leg', () => {
    const all = entries(['a', 'b', 'b', 'c', 'd', 'd', 'd', 'e', 'f', 'g', 'g']);
    const seen = new Map<number, number>();
    for (const current of [1, 2, 3]) {
      for (const entry of shardSlice(all, { current, total: 3 })) {
        seen.set(entry.i, (seen.get(entry.i) ?? 0) + 1);
      }
    }

    expect([...seen.values()].every((n) => n === 1)).toBe(true);
    expect(seen.size).toBe(all.length);
  });

  it('puts the remainder on the first legs, like Playwright', () => {
    const all = entries(['a', 'b', 'c', 'd', 'e']);

    expect(shardSlice(all, { current: 1, total: 3 }).size).toBe(2);
    expect(shardSlice(all, { current: 2, total: 3 }).size).toBe(2);
    expect(shardSlice(all, { current: 3, total: 3 }).size).toBe(1);
  });

  it('sizes the legs by their weights, as Playwright does', () => {
    // Playwright's arithmetic with weights 3:1 over eight entries: 6 and 2.
    const all = entries(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);

    expect(shardSlice(all, { current: 1, total: 2 }, [3, 1]).size).toBe(6);
    expect(shardSlice(all, { current: 2, total: 2 }, [3, 1]).size).toBe(2);
  });

  it('leaves a leg empty rather than split a unit', () => {
    expect(shardSlice(entries(['a', 'a', 'a']), { current: 2, total: 2 }).size).toBe(0);
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
