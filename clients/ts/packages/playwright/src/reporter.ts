import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import {
  applyToCollected,
  buildSessionVerdict,
  createApiClient,
  createTracing,
  detectResources,
  emitTestCaseSpan,
  endSessionSpan,
  envToBool,
  type FinalStatus,
  type FlakyDetectionContext,
  FlakyDetector,
  fallbackRefusalMessage,
  fetchTestSelection,
  formatSessionVerdictResult,
  formatTestSelectionReport,
  generateTestRunId,
  getRepoName,
  isInCI,
  isTestSelectionEnabled,
  type MergifyApiClient,
  nativeTestCollectionFingerprint,
  resolveSelectionCoordinates,
  type SessionSpan,
  type SessionVerdictClient,
  SessionVerdictFold,
  type SessionVerdictResult,
  type SpanAttributes,
  selectionEcho,
  selectionResourceAttributes,
  sendSessionVerdict,
  startSessionSpan,
  type TestCaseResult,
  type TestCollection,
  type TestRunSession,
  type TestSelectionApplication,
  type TestSelectionClientIdentity,
  type TracingContext,
} from '@mergifyio/ci-core';
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestError,
  TestResult,
} from '@playwright/test/reporter';
import * as playwrightResource from './resources/playwright.js';
import { readStateFile, type SharedState } from './state-file.js';
import type { MergifyReporterOptions } from './types.js';
import {
  buildTestKey,
  extractNamespace,
  mapStatus,
  projectNameFromTest,
  projectNamePrefix,
  resolveIncludeProject,
  toPosix,
} from './utils.js';
import { readPluginVersion } from './version.js';

const DEFAULT_API_URL = 'https://api.mergify.com';

/** How the terminal block names this client, in the two sentences that do. */
const CLIENT: TestSelectionClientIdentity = {
  name: '@mergifyio/playwright',
  docsUrl: 'https://docs.mergify.com/ci-insights/test-frameworks/playwright/',
};

/** One collected test, with the identity Mergify knows it by. */
interface CollectedTest {
  test: TestCase;
  key: string;
}

/**
 * The slice of Playwright's `TestRun` this reporter uses, declared structurally
 * instead of imported. `TestRun` only exists in `@playwright/test` 1.62+, while
 * the package supports 1.56+; importing the type would break a consumer's own
 * typecheck on an older Playwright, over a hook that runner never calls anyway.
 */
interface PlaywrightTestRun {
  exclude(test: TestCase | Suite): void;
  /**
   * Hands sharding to the reporter: Playwright then runs whatever `exclude`
   * left, without partitioning it. Optional so a stub need not provide it.
   */
  skipSharding?(): void;
}

/**
 * How Playwright groups tests before it shards them, ported from its own
 * `createTestGroups`.
 *
 * A group is what the partition will not split apart, and Playwright's answer
 * is much finer than "one file": under `fullyParallel` a plain test is its own
 * group, so fifteen legs of an 840-test suite get 56 tests each. Keeping whole
 * files together instead costs a skew this suite showed at 30..79 tests a leg,
 * and the wall of a sharded job is its slowest leg.
 *
 * Only three things hold tests together, and each is reproduced here:
 *
 * - the worker hash and the required file, which never let two files -- or two
 *   projects' copies of one file -- share a group;
 * - an enclosing `serial` or `default` suite, whose tests run in order in one
 *   worker (`test.describe.serial`, `test.describe.configure({ mode })`);
 * - a hook that runs once for a whole file -- `beforeAll` and the teardown that
 *   pairs with it -- outside any such suite, which Playwright pays once per
 *   group and therefore chunks into `ceil(n / legs)`-sized pieces rather than
 *   paying it per test.
 *
 * Anything outside a parallel suite (a project without `fullyParallel`) stays
 * one group per file, which is what Playwright does too.
 *
 * The fields this reads are Playwright's internals. A runner that stops
 * exposing them leaves `parallelMode` undefined, no test reads as parallel, and
 * every file becomes a single group -- coarser than Playwright's own
 * partition, never finer, so a group is still never split across two legs.
 */
interface GroupingSuite {
  parent?: GroupingSuite;
  _parallelMode?: string;
  _hooks?: readonly { type?: string }[];
}

interface GroupingTest {
  parent?: GroupingSuite;
  _workerHash?: string;
  _requireFile?: string;
  location?: { file?: string };
  repeatEachIndex?: number;
}

/** One group of the partition, in the order Playwright emits them. */
export type TestGroup<T> = readonly T[];

export function testGroups<T>(
  projects: readonly (readonly T[])[],
  toTest: (entry: T) => GroupingTest,
  projectNameOf: (entry: T) => string,
  expectedParallelism: number
): TestGroup<T>[] {
  const result: T[][] = [];
  for (const project of projects) {
    // Keyed exactly as Playwright keys them, and in insertion order, because
    // that order is the one `filterForShard` walks to cut its ranges.
    const byWorkerHash = new Map<
      string,
      Map<string, { general: T[]; parallel: Map<unknown, T[]>; parallelWithHooks: T[] }>
    >();
    for (const entry of project) {
      const test = toTest(entry);
      const workerHash =
        test._workerHash ?? `${projectNameOf(entry)}\0${test.repeatEachIndex ?? 0}`;
      const requireFile = test._requireFile ?? test.location?.file ?? '';
      let byFile = byWorkerHash.get(workerHash);
      if (!byFile) byWorkerHash.set(workerHash, (byFile = new Map()));
      let bucket = byFile.get(requireFile);
      if (!bucket) {
        byFile.set(
          requireFile,
          (bucket = { general: [], parallel: new Map(), parallelWithHooks: [] })
        );
      }

      let insideParallel = false;
      let outerMostSequentialSuite: GroupingSuite | undefined;
      let hasAllHooks = false;
      for (let parent = test.parent; parent; parent = parent.parent) {
        if (parent._parallelMode === 'serial' || parent._parallelMode === 'default') {
          outerMostSequentialSuite = parent;
        }
        insideParallel = insideParallel || parent._parallelMode === 'parallel';
        hasAllHooks =
          hasAllHooks ||
          (parent._hooks ?? []).some(
            (hook) => hook.type === 'beforeAll' || hook.type === 'afterAll'
          );
      }

      if (!insideParallel) {
        bucket.general.push(entry);
      } else if (hasAllHooks && !outerMostSequentialSuite) {
        bucket.parallelWithHooks.push(entry);
      } else {
        const key = outerMostSequentialSuite ?? test;
        let group = bucket.parallel.get(key);
        if (!group) bucket.parallel.set(key, (group = []));
        group.push(entry);
      }
    }

    for (const byFile of byWorkerHash.values()) {
      for (const bucket of byFile.values()) {
        if (bucket.general.length) result.push(bucket.general);
        result.push(...bucket.parallel.values());
        // `expectedParallelism` is the number of legs, as Playwright passes it
        // on the sharding path -- so a hooked file is cut into at most one
        // piece per leg.
        const size = Math.ceil(bucket.parallelWithHooks.length / expectedParallelism);
        let last: T[] | undefined;
        for (const entry of bucket.parallelWithHooks) {
          if (!last || last.length >= size) result.push((last = []));
          last.push(entry);
        }
      }
    }
  }
  return result;
}

/**
 * This leg's share of a sharded run, decided here rather than by Playwright.
 *
 * The selection is keyed on what a leg collected -- its fingerprint and count
 * are what the engine matches the previous attempt's session on, and what it
 * judges the session complete against. Playwright partitions AFTER
 * `preprocess`, so the only moment the reporter can ask is a moment where it
 * does not know Playwright's slice; and letting Playwright partition a served
 * subset spreads one leg's failures over every leg, so that most of them are
 * replayed by nobody. So once a leg asks, the partition is the reporter's on
 * every attempt: the same collection, the same shard index, the same slice --
 * which is what makes the fingerprint match.
 *
 * This is Playwright's `filterForShard`, over the groups `testGroups` built:
 * contiguous ranges of the collection sized by the legs' weights
 * (`PWTEST_SHARD_WEIGHTS`, colon-separated as Playwright reads it, equal by
 * default) with the remainder on the first legs, and a group kept whole by the
 * leg its first test falls in. Same collection, same shard index, same slice.
 */
export function shardSlice<T>(
  groups: readonly TestGroup<T>[],
  shard: { current: number; total: number },
  weights: readonly number[] = Array.from({ length: shard.total }, () => 1)
): Set<T> {
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let shardableTotal = 0;
  for (const group of groups) shardableTotal += group.length;
  const sizes = weights.map((w) => Math.floor((w * shardableTotal) / totalWeight));
  const remainder = shardableTotal - sizes.reduce((a, b) => a + b, 0);
  for (let i = 0; i < remainder; i++) sizes[i % sizes.length] += 1;
  let from = 0;
  for (let i = 0; i < shard.current - 1; i++) from += sizes[i];
  const to = from + sizes[shard.current - 1];

  const kept = new Set<T>();
  let current = 0;
  for (const group of groups) {
    if (current >= from && current < to) {
      for (const entry of group) kept.add(entry);
    }
    current += group.length;
  }
  return kept;
}

/**
 * The legs' weights, as Playwright's own `resolveShardWeightsOption` reads
 * them: colon-separated integers, one per leg, zero allowed. Anything else is
 * reported and the legs are weighted equally -- Playwright refuses the run
 * instead, but a selection that fails open must not be what stops a CI job.
 */
export function shardWeights(total: number, log: (msg: string) => void): number[] | undefined {
  const raw = process.env.PWTEST_SHARD_WEIGHTS;
  if (!raw) return undefined;
  const weights = raw.split(':').map((w) => Number.parseInt(w, 10));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (
    weights.length === total &&
    weights.every((w) => !Number.isNaN(w) && w >= 0) &&
    totalWeight > 0
  ) {
    return weights;
  }
  log(
    `PWTEST_SHARD_WEIGHTS="${raw}" does not name ${total} non-negative weights; the legs are weighted equally`
  );
  return undefined;
}

/**
 * Playwright's own complaint about an empty suite (`loadTask`: "No tests
 * found"), which an `empty` answer produces by design on an unsharded job.
 * Matched on the message: the error carries no code, and it is the one
 * run-level error the `empty` override may look past.
 */
function isNoTestsFound(error: TestError): boolean {
  return /\bNo tests found\b/.test(error.message ?? '');
}

/**
 * A test's final status, as Playwright itself concluded it once the run is
 * over, for the session verdict -- or undefined for a test that never
 * started, which the verdict then does not count as executed.
 *
 * `outcome()` is the verdict Playwright's exit code is built from: `expected`
 * covers a pass and a `test.fail()` that failed as announced; `unexpected`
 * covers a failure after every retry and a `test.fail()` that passed -- both
 * turned the job red, so both must be replayed. A `flaky` test passed on a
 * retry and did not gate the job, unless `failOnFlakyTests` says it did. A
 * quarantine-absorbed failure is reconciled as expected by the fixture, so it
 * is read off the annotation first.
 *
 * `skipped` covers two things Playwright tells apart the same way
 * (`computeTestCaseOutcome`): a test that asked to be skipped, and a test that
 * DID NOT RUN because something before it failed -- the rest of a file after a
 * `beforeAll` threw, the followers of a serial group, the remainder of a
 * crashed worker, an interruption. The second kind never ran on this commit,
 * so it is failed here: a rerun that skipped it as "already passed" would go
 * green over tests nobody executed.
 */
function finalStatus(test: TestCase, failOnFlakyTests: boolean): FinalStatus | undefined {
  if (test.annotations.some((a) => a.type === 'mergify:quarantined')) return 'quarantined_failed';
  if (test.results.length === 0) return undefined;
  const outcome = test.outcome();
  if (outcome === 'unexpected') return 'failed';
  if (outcome === 'flaky') return failOnFlakyTests ? 'failed' : 'passed';
  if (outcome === 'expected') return 'passed';
  return test.expectedStatus === 'skipped' ? 'skipped' : 'failed';
}

/**
 * Every project pulled in by another project *of this run* — as a
 * `dependencies` entry or as its `teardown`.
 *
 * Their tests are readonly during `preprocess`: `testRun.exclude()` throws on
 * them ("these always run in full"). Read from the suite, NOT from
 * `config.projects`: the latter holds every declared project regardless of
 * `--project`, so under `playwright test --project=setup` it would mark `setup`
 * readonly on the strength of a declaration by an `e2e` project that is not
 * running — filtering out the entire collection, killing the reduction, and
 * reporting `subset_matched_no_collected_test` for a cause that never happened.
 *
 * No graph walk is needed for chains: every project of the run contributes its
 * own declarations, so a setup project's own setup or teardown is picked up
 * from that project's entry. Still deliberately over-inclusive — a project both
 * top-level and someone else's dependency lands here and keeps running in full,
 * which is the direction this feature is allowed to err in.
 */
function readonlyProjectNames(suite: Suite): Set<string> {
  const names = new Set<string>();
  for (const projectSuite of suite.suites) {
    const project = projectSuite.project();
    if (!project) continue;
    for (const dependency of project.dependencies) names.add(dependency);
    if (project.teardown) names.add(project.teardown);
  }
  return names;
}

export class MergifyReporter implements Reporter {
  private options: MergifyReporterOptions;
  /**
   * Resolved once at construction so every mode (normal, rerun subprocess)
   * agrees. Env-only: the fixture and global-setup are separate processes that
   * cannot read reporter options, and `withMergify` does not forward them.
   */
  private includeProject: boolean;
  private session: TestRunSession | undefined;
  private tracing: TracingContext | null = null;
  private sessionSpan: SessionSpan | undefined;
  private config: FullConfig | undefined;
  private quarantineFetchedCount = 0;
  private quarantineFetchedNames: string[] = [];
  // A Set so a fetched quarantine entry caught in multiple projects (same
  // unprefixed key when project prefixing is off) counts once, not once per
  // project — otherwise `caught` inflates and `unused` can go negative.
  private quarantinedCaught: Set<string> = new Set();
  private flakyResults: Array<{
    name: string;
    new: boolean;
    flaky: boolean;
    rerunCount: number;
  }> = [];

  // Multi-process flaky-detection state.
  private rerunFile: string | undefined;
  private flakyDetector: FlakyDetector | null = null;
  private flakyMode: 'new' | 'unhealthy' | null = null;
  /** Buffer of (testCaseResult, key) pairs awaiting span emission. */
  private buffered: Array<{ result: TestCaseResult; key: string }> = [];
  /**
   * Phase-1 outcomes for candidates that ran, deduplicated per key (so a
   * multi-project suite contributes one entry per logical test, with failures
   * preserved). Replayed into `flakyDetector.recordOutcome` at the start of
   * onEnd, before phase-2 outcomes are merged in.
   */
  private phase1Outcomes: Map<string, { status: 'pass' | 'fail'; duration: number }> = new Map();

  // Reduced merge-queue reruns.
  /** Whether the running Playwright called `preprocess` — 1.62 and up do. */
  private preprocessCalled = false;
  /**
   * What this run collected -- the identity Mergify was asked with and the
   * verdict is filed under. Set exactly when the run asked (including when
   * the answer was dormant or the request failed): the verdict is what the
   * NEXT rerun of this job needs, whatever this one was told.
   */
  private collection: TestCollection | undefined;
  /** What `preprocess` decided, once it met the collection. Reported in onEnd. */
  private testSelection: TestSelectionApplication | undefined;
  /** The projects whose tests always run in full, read once in `preprocess`. */
  private readonlyProjects = new Set<string>();
  /** The suite as Playwright ran it, for the verdict's final fold. */
  private rootSuite: Suite | undefined;
  /**
   * Run-level errors Playwright reported outside any test -- a global
   * teardown that threw, a worker that died -- and the one it prints for an
   * empty suite. Read by the `empty` override: a run that failed for one of
   * these did not fail because Mergify emptied it.
   */
  private runErrors: TestError[] = [];
  /** Each test's final status, folded once the run is over, for the verdict. */
  private verdictFold = new SessionVerdictFold();
  private verdictResult: SessionVerdictResult | undefined;
  /** Memoised state file, read by `onBegin`. */
  private sharedState: SharedState | null | undefined;
  /** Memoised so `preprocess` and `onBegin` build one client, not two. */
  private apiClient: (MergifyApiClient & Partial<SessionVerdictClient>) | null | undefined;
  private runAttributes: SpanAttributes | undefined;
  private runId: string | undefined;

  constructor(options?: MergifyReporterOptions) {
    this.options = options ?? {};
    this.includeProject = resolveIncludeProject();
  }

  /** `MERGIFY_TEST_RUN_ID` from globalSetup, or one minted here, once. */
  private testRunId(): string {
    this.runId ??= process.env.MERGIFY_TEST_RUN_ID ?? generateTestRunId();
    return this.runId;
  }

  /** Whether this run reports to Mergify at all -- CI, an explicit opt-in, or an injected sink. */
  private reportingEnabled(): boolean {
    return (
      isInCI() || envToBool(process.env.PLAYWRIGHT_MERGIFY_ENABLE, false) || !!this.options.sink
    );
  }

  /**
   * The backend client, built once from the injected one or from the
   * environment. Null when there is no token, no detected repository, or no
   * binding for this platform -- the fail-open path, on which every backend
   * feature stays off.
   */
  private client(): (MergifyApiClient & Partial<SessionVerdictClient>) | null {
    if (this.apiClient === undefined) {
      const token = this.options.token ?? process.env.MERGIFY_TOKEN;
      const apiUrl = this.options.apiUrl ?? process.env.MERGIFY_API_URL ?? DEFAULT_API_URL;
      const repoName = getRepoName();
      this.apiClient =
        this.options.apiClient ??
        (token && repoName
          ? createApiClient({
              apiUrl,
              token,
              repoName,
              clientName: '@mergifyio/playwright',
              clientVersion: readPluginVersion(),
            })
          : null);
    }
    return this.apiClient;
  }

  /** The run's resource attributes, detected once: the selection is keyed on them and the verdict filed under them. */
  private attributes(): SpanAttributes {
    this.runAttributes ??= detectResources(playwrightResource.detect(), this.testRunId());
    return this.runAttributes;
  }

  /** Project-qualifier prefix for a test's identity, honoring the env flag. */
  private prefixFor(test: TestCase): string {
    return this.includeProject ? projectNamePrefix(projectNameFromTest(test)) : '';
  }

  /**
   * A test's identity: the same string the backend stores, and the same one
   * quarantine and flaky detection match on.
   *
   * Used by `preprocess` and by the flaky-candidate walk in `onBegin`. The
   * `onTestEnd` builders and the worker-side fixture still assemble the key
   * inline — the fixture holds a `TestInfo`, not a `TestCase`, so it structurally
   * cannot call this. They agree byte-for-byte today; nothing enforces it.
   */
  private testKey(test: TestCase, rootDir: string): string {
    const absolute = test.location?.file ?? '';
    const filepath = toPosix(rootDir ? relative(rootDir, absolute) : absolute);
    return buildTestKey(filepath, test.titlePath(), test.title, this.prefixFor(test));
  }

  /** The globalSetup-written state, read at most once per process. */
  private loadSharedState(): SharedState | null {
    if (this.sharedState === undefined) {
      const statePath = process.env.MERGIFY_STATE_FILE;
      this.sharedState = statePath ? readStateFile(statePath) : null;
    }
    return this.sharedState;
  }

  /**
   * Ask Mergify what this run should execute, and make the run do it.
   *
   * `preprocess` is the only Playwright hook that sees the whole collection
   * while it can still be changed. It runs after `--project`, `--grep` and
   * `.only` have been applied — so the subset can only ever narrow what the
   * user asked for, never widen it — and before Playwright shards. It is also
   * where the request is made: it carries the fingerprint of what this run
   * collected, so it cannot happen before there is one. Playwright calls it
   * from 1.62 onwards; older runners ignore the method entirely and run the
   * full suite, and `onEnd` says so.
   *
   * Nothing thrown here reaches Playwright: it would abort the whole run,
   * the one outcome reduced reruns must never cause. A failure part-way
   * through leaves tests un-excluded, which runs MORE than intended, never
   * fewer.
   */
  async preprocess(params: {
    config: FullConfig;
    suite: Suite;
    testRun: PlaywrightTestRun;
  }): Promise<void> {
    this.preprocessCalled = true;

    // Flaky-detection rerun subprocess: its `--test-list` is already phase 1's
    // reduced set, so filtering again could only drop reruns. `this.rerunFile`
    // is not set yet — onBegin runs after this hook.
    if (process.env.MERGIFY_RERUN_FILE) return;

    // Opt-in, per job, and read before anything else: a job that has not
    // asked makes no request at all (see `isTestSelectionEnabled`).
    if (!isTestSelectionEnabled() || !this.reportingEnabled()) return;

    try {
      await this.selectTests(params);
    } catch (err) {
      this.testSelection = undefined;
      process.stderr.write(
        `[@mergifyio/playwright] test selection could not be applied, tests it did not deselect will run: ${String(err)}\n`
      );
    }
  }

  private async selectTests(params: {
    config: FullConfig;
    suite: Suite;
    testRun: PlaywrightTestRun;
  }): Promise<void> {
    const client = this.client();
    if (!client) return;
    // The selection is keyed on the run's OWN identity: the head branch and
    // revision (a merge-queue draft branch on reruns) plus the job coordinates
    // — the exact values reported with each uploaded test. Without all four
    // there is nothing the server can match.
    const coordinates = resolveSelectionCoordinates(this.attributes());
    if (!coordinates) return;

    const log = (msg: string) => process.stderr.write(`[@mergifyio/playwright] ${msg}\n`);

    // Setup/teardown project tests are readonly here and always run in full,
    // so they take no part in the collection on either side: not in the
    // fingerprint, never excluded, and not in the verdict either -- a failed
    // setup leaves the collection's tests unstarted, which the verdict
    // reports as not executed, and the next attempt runs everything.
    this.readonlyProjects = readonlyProjectNames(params.suite);
    const rootDir = params.config.rootDir ?? '';
    let collected: CollectedTest[] = params.suite
      .allTests()
      .filter((test) => !this.readonlyProjects.has(projectNameFromTest(test) ?? ''))
      .map((test) => ({ test, key: this.testKey(test, rootDir) }));

    if (params.config.shard) {
      if (typeof params.testRun.skipSharding !== 'function') {
        log(
          'this Playwright cannot hand sharding to a reporter; the shard runs without a test selection'
        );
        return;
      }
      // Throws when another reporter already took sharding over: caught by
      // `preprocess`, and the run then executes whatever that reporter left.
      params.testRun.skipSharding();
      // Playwright groups per project suite and shards the concatenation in
      // `rootSuite.suites` order. `allTests()` walks the project suites in that
      // same order, so splitting `collected` by project name rebuilds it -- and
      // the setup/teardown projects Playwright detaches before sharding are the
      // ones already dropped above.
      const byProject = new Map<string, CollectedTest[]>();
      for (const entry of collected) {
        const name = projectNameFromTest(entry.test) ?? '';
        const inProject = byProject.get(name);
        if (inProject) inProject.push(entry);
        else byProject.set(name, [entry]);
      }
      const slice = shardSlice(
        testGroups(
          [...byProject.values()],
          (entry) => entry.test,
          (entry) => projectNameFromTest(entry.test) ?? '',
          params.config.shard.total
        ),
        params.config.shard,
        shardWeights(params.config.shard.total, log)
      );
      const inSlice = new Set([...slice].map((entry) => entry.test));
      for (const entry of collected) {
        if (!inSlice.has(entry.test)) params.testRun.exclude(entry.test);
      }
      collected = collected.filter((entry) => inSlice.has(entry.test));
    }

    // Distinct identities, in collection order: with project prefixing off, a
    // test collected in two browser projects is one identity the engine
    // stores once, so it is one entry of the collection -- kept in every
    // project on a subset, counted once everywhere.
    const ids = [...new Set(collected.map((entry) => entry.key))];
    const fingerprint = nativeTestCollectionFingerprint(ids);
    if (fingerprint === null) {
      log('the bundled binding cannot fingerprint the collection; the full suite runs');
      return;
    }
    this.collection = { fingerprint, count: ids.length };

    const selection = await fetchTestSelection(client, coordinates, log, fingerprint);
    const application = applyToCollected(selection, ids);
    this.testSelection = application;

    switch (application.outcome) {
      case 'refused':
        // Deliberately not the degradation path. Everywhere else, a shape
        // Mergify cannot resolve costs time and nothing else; here it is
        // Mergify saying it holds several candidate predecessors for this
        // job, which means one job name is standing for several runs. That
        // keeps the reporting wrong for every future attempt, so it has to be
        // seen and fixed rather than absorbed into a full run nobody notices.
        // The message is the server's, printed now so it is the first thing
        // in the log; the run is failed from `onEnd`.
        process.stderr.write(
          `${application.selection.message ?? fallbackRefusalMessage(CLIENT)}\n`
        );
        for (const entry of collected) params.testRun.exclude(entry.test);
        return;
      case 'empty':
        // Excluding rather than skipping is what keeps the session the same
        // shape as pytest-mergify's: no test ran, none is reported, and the
        // session still uploads.
        for (const entry of collected) params.testRun.exclude(entry.test);
        return;
      case 'subset':
        for (const entry of collected) {
          if (!application.keep.has(entry.key)) params.testRun.exclude(entry.test);
        }
        return;
      case 'full':
        return;
    }
  }

  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig, suite: Suite): void {
    this.config = config;
    this.rootSuite = suite;

    // Subprocess "rerun mode" — short-circuits the entire pipeline. The
    // parent reporter set `MERGIFY_RERUN_FILE` to the path of a JSONL file
    // we append per-attempt outcomes to. No tracing, no quarantine summary,
    // no span emission.
    this.rerunFile = process.env.MERGIFY_RERUN_FILE;
    if (this.rerunFile) {
      mkdirSync(dirname(this.rerunFile), { recursive: true });
      // Initialise the file (truncate). Each subsequent onTestEnd appends.
      writeFileSync(this.rerunFile, '');
      return;
    }

    const testRunId = this.testRunId();
    const enabled = this.reportingEnabled();

    // The reporter only uploads: quarantine and the flaky context were already
    // fetched in globalSetup and reach it through the state file.
    const apiClient = this.client();

    if (enabled) {
      this.tracing = createTracing({
        apiClient,
        testRunId,
        frameworkAttributes: playwrightResource.detect(),
        sink: this.options.sink,
      });
    }

    if (!this.tracing && enabled) {
      if (!(this.options.token ?? process.env.MERGIFY_TOKEN)) {
        process.stderr.write(
          '[@mergifyio/playwright] MERGIFY_TOKEN not set, skipping CI Insights reporting\n'
        );
      } else if (!getRepoName()) {
        process.stderr.write(
          '[@mergifyio/playwright] Could not detect repository name, skipping CI Insights reporting\n'
        );
      }
    }

    // What the run collected, and what Mergify made of it, travel on the
    // session's resource -- the fingerprint and count on every run that asked,
    // the answer only when Mergify actually answered.
    if (this.tracing && this.collection) {
      Object.assign(
        this.tracing.resourceAttributes,
        selectionResourceAttributes(this.collection, this.echo())
      );
    }

    let flakyContext: FlakyDetectionContext | null = null;
    const state = this.loadSharedState();
    if (state) {
      this.quarantineFetchedCount = state.quarantinedTests.length;
      this.quarantineFetchedNames = state.quarantinedTests;
      if (state.flakyMode) this.flakyMode = state.flakyMode;
      if (state.flakyContext) flakyContext = state.flakyContext;
    }

    this.session = {
      testRunId,
      scope: 'session',
      startTime: Date.now(),
      status: 'passed',
      testCases: [],
    };

    if (this.tracing) {
      this.sessionSpan = startSessionSpan(this.tracing, 'playwright session start');
    }

    if (flakyContext && this.flakyMode && typeof suite.allTests === 'function') {
      const allTestNames = suite.allTests().map((tc) => this.testKey(tc, config.rootDir ?? ''));
      this.flakyDetector = new FlakyDetector(flakyContext, this.flakyMode, allTestNames);
    }
  }

  onError(error: TestError): void {
    this.runErrors.push(error);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    // A quarantine-absorbed failing test is reconciled as "expected" (the
    // fixture flips testInfo.expectedStatus to mirror the raw status), so
    // Playwright never retries it — it stays at result.retry === 0 with a raw
    // 'failed' status. With retries > 0 the retry-count check below would never
    // fire, so onTestEnd would return before counting it as caught or emitting
    // its span. Treat the absorbed attempt as final. Absorption blocks the
    // retry, so this annotation is present on exactly one attempt: no
    // double-counting against a genuine final retry of a normally-failing test.
    const isQuarantined = test.annotations.some((a) => a.type === 'mergify:quarantined');
    const retries = test.retries ?? 0;
    const isFinal =
      isQuarantined ||
      result.status === 'passed' ||
      result.status === 'skipped' ||
      result.retry >= retries;
    if (!isFinal) return;

    const rootDir = this.config?.rootDir ?? '';
    const absoluteFilepath = test.location?.file ?? '';
    const filepath = toPosix(rootDir ? relative(rootDir, absoluteFilepath) : absoluteFilepath);

    // Rerun mode: just append a JSONL line and return.
    if (this.rerunFile) {
      const prefix = this.prefixFor(test);
      const key = buildTestKey(filepath, test.titlePath(), test.title, prefix);
      const line = `${JSON.stringify({
        key,
        status: result.status,
        duration: result.duration,
      })}\n`;
      try {
        appendFileSync(this.rerunFile, line);
      } catch (err) {
        process.stderr.write(
          `[@mergifyio/playwright] failed to write rerun outcome: ${String(err)}\n`
        );
      }
      return;
    }

    if (!this.session) return;

    const titlePath = test.titlePath();
    const namespace = extractNamespace(filepath, titlePath);
    const project = projectNameFromTest(test);
    const prefix = this.prefixFor(test);
    const key = buildTestKey(filepath, titlePath, test.title, prefix);

    const testCaseResult: TestCaseResult = {
      filepath,
      absoluteFilepath,
      function: test.title,
      lineno: test.location?.line ?? 0,
      namespace,
      scope: 'case',
      status: mapStatus(result.status),
      duration: result.duration,
      startTime: result.startTime.getTime(),
      retryCount: result.retry,
      flaky: test.outcome() === 'flaky',
    };

    if (prefix) {
      testCaseResult.namePrefix = prefix;
    }

    if (project !== undefined) {
      testCaseResult.project = project;
    }

    if (result.status !== 'passed' && result.status !== 'skipped' && result.errors.length > 0) {
      const firstError = result.errors[0];
      const type =
        typeof firstError.value === 'string'
          ? (firstError.value.split(':')[0] ?? 'Error')
          : 'Error';
      testCaseResult.error = {
        type,
        message: firstError.message ?? '',
        stacktrace: firstError.stack ?? '',
      };
    }

    if (isQuarantined) {
      testCaseResult.quarantined = true;
      this.quarantinedCaught.add(key);
    }

    // Record phase-1 outcome for candidates, used to compute repeat-each
    // count and to seed the aggregation in onEnd. Skipped tests are excluded
    // — recording them as either pass or fail can produce misleading flaky
    // verdicts when phase 2 actually runs the test (rare but possible if
    // skip conditions differ across phases).
    if (this.flakyDetector?.isCandidate(key) && result.status !== 'skipped') {
      const phase1Status: 'pass' | 'fail' = result.status === 'passed' ? 'pass' : 'fail';
      const existing = this.phase1Outcomes.get(key);
      // In multi-project suites the same key appears once per project;
      // preserve a failure if already recorded so cross-project flakiness
      // is not masked by a later passing project.
      if (!existing || existing.status !== 'fail') {
        this.phase1Outcomes.set(key, {
          status: phase1Status,
          duration: result.duration,
        });
      }
    }

    this.session.testCases.push(testCaseResult);

    // When flaky detection is active, buffer spans for deferred emission so
    // we can augment with phase-2 results in onEnd. Otherwise emit immediately.
    if (this.flakyDetector) {
      this.buffered.push({ result: testCaseResult, key });
    } else if (this.tracing && this.sessionSpan) {
      emitTestCaseSpan(this.tracing, this.sessionSpan, testCaseResult);
    }
  }

  async onEnd(result: FullResult): Promise<{ status?: FullResult['status'] } | undefined> {
    // Rerun mode: nothing to do — outcomes were appended in onTestEnd.
    if (this.rerunFile) return;

    if (!this.session) return;

    const runStatus = this.finalRunStatus(result.status);
    const reason: 'passed' | 'failed' | 'interrupted' =
      runStatus === 'passed' ? 'passed' : runStatus === 'interrupted' ? 'interrupted' : 'failed';

    this.session.endTime = Date.now();
    this.session.status = reason;

    // Replay deduplicated phase-1 outcomes into the FlakyDetector so it sees
    // exactly one initial attempt per candidate before any phase-2 outcomes
    // are merged in. This mirrors the in-process Vitest pattern (one
    // recordOutcome per attempt) — the only difference is that we batch the
    // phase-1 recordings here instead of recording in onTestEnd, so that the
    // multi-project dedup logic still applies.
    if (this.flakyDetector) {
      for (const [key, { status }] of this.phase1Outcomes) {
        this.flakyDetector.recordOutcome(key, status);
      }
    }

    // Phase 2: spawn rerun subprocess for any candidates that ran.
    // Skip when interrupted — spawning a blocking subprocess after a
    // timeout or SIGTERM would delay process exit further.
    if (this.flakyDetector && reason !== 'interrupted') {
      await this.runFlakyDetectionPhase2(this.flakyDetector);
    }

    // Augment buffered TestCaseResults with flakyDetection metadata before
    // emitting spans. In multi-project suites the same key appears once per
    // project — compute the verdict once and apply it to every matching entry,
    // but only push to flakyResults once per unique key.
    const processedFlakyKeys = new Set<string>();
    for (const { result: tcr, key } of this.buffered) {
      if (!this.flakyDetector?.isCandidate(key) || !this.flakyMode) continue;
      // Skip candidates we never measured (skipped in phase 1 and not rerun)
      // — otherwise we'd emit a misleading `flaky: false` verdict on a test
      // the pipeline never actually evaluated.
      if (!this.phase1Outcomes.has(key)) continue;

      const isFlaky = this.flakyDetector.isFlaky(key);
      const rerunCount = this.flakyDetector.getRerunCount(key);

      tcr.flakyDetection = {
        new: this.flakyMode === 'new',
        flaky: isFlaky,
        rerunCount,
      };
      if (!processedFlakyKeys.has(key)) {
        processedFlakyKeys.add(key);
        this.flakyResults.push({
          name: key,
          new: this.flakyMode === 'new',
          flaky: isFlaky,
          rerunCount,
        });
      }
    }

    // Emit all buffered spans now.
    if (this.tracing && this.sessionSpan) {
      for (const { result: tcr } of this.buffered) {
        emitTestCaseSpan(this.tracing, this.sessionSpan, tcr);
      }
    }

    // The verdict first, on purpose: it is what the next merge-queue rerun of
    // this job is answered from, and it must never wait behind the upload's
    // timeout and retries. Its own failure does not stop the upload either --
    // the two are independent documents.
    this.foldVerdict();
    await this.sendVerdict();
    this.reportTestSelection();

    if (this.quarantineFetchedCount > 0) {
      const unused = this.quarantineFetchedCount - this.quarantinedCaught.size;
      process.stderr.write('[@mergifyio/playwright] Quarantine report:\n');
      process.stderr.write(`  fetched: ${this.quarantineFetchedCount}\n`);
      process.stderr.write(`  caught:  ${this.quarantinedCaught.size}\n`);
      for (const name of this.quarantinedCaught) {
        process.stderr.write(`    - ${name}\n`);
      }
      process.stderr.write(`  unused:  ${unused}\n`);
      if (unused > 0) {
        const unusedNames = this.quarantineFetchedNames.filter(
          (n) => !this.quarantinedCaught.has(n)
        );
        for (const name of unusedNames) {
          process.stderr.write(`    - ${name}\n`);
        }
      }
    }

    // Flaky detection summary
    if (this.flakyMode) {
      process.stderr.write('[@mergifyio/playwright] Flaky detection report:\n');
      process.stderr.write(`  mode: ${this.flakyMode}\n`);
      process.stderr.write(`  Tests rerun: ${this.flakyResults.length}\n`);

      const flakyTests = this.flakyResults.filter((r) => r.flaky);
      process.stderr.write(`  Flaky tests detected: ${flakyTests.length}\n`);
      for (const t of flakyTests) {
        process.stderr.write(`    - ${t.name} (reruns: ${t.rerunCount})\n`);
      }
    }

    if (this.tracing && this.sessionSpan) {
      try {
        await endSessionSpan(this.tracing, this.sessionSpan, reason);
      } catch (err) {
        const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
        process.stderr.write(`[@mergifyio/playwright] Failed to flush spans: ${detail}\n`);
      }
    }

    return runStatus === result.status ? undefined : { status: runStatus };
  }

  /**
   * The status the run ends with, once the selection has had its say.
   *
   * A refusal fails the run whatever Playwright made of the empty suite it
   * was left -- green on a shard, "No tests found" otherwise. An `empty`
   * answer is the opposite: the run executed nothing because Mergify asked
   * for exactly that, so Playwright's "No tests found" is turned into a pass
   * -- but only that. A setup project test that ran and failed by
   * Playwright's own reading (`ok()`, and `failOnFlakyTests`) keeps the run
   * red; so does an interruption, and so does any run-level error other than
   * "No tests found" itself -- a global teardown still runs on an emptied
   * suite, and its failure reaches the reporter through `onError` alone.
   */
  private finalRunStatus(reported: FullResult['status']): FullResult['status'] {
    const outcome = this.testSelection?.outcome;
    if (outcome === 'refused') return 'failed';
    if (
      outcome === 'empty' &&
      reported === 'failed' &&
      this.testSelection!.deselectedCount > 0 &&
      this.runErrors.every(isNoTestsFound) &&
      !this.rootSuite?.allTests().some((test) => !test.ok()) &&
      !(
        this.config?.failOnFlakyTests &&
        this.rootSuite?.allTests().some((t) => t.outcome() === 'flaky')
      )
    ) {
      return 'passed';
    }
    return reported;
  }

  /**
   * Fold every test of the collection to its final status, once the run is
   * over: what Playwright concluded of it across its attempts, read off the
   * suite rather than accumulated per attempt -- Playwright retries a test it
   * skipped for a predecessor's failure and a `test.fail()` that passed, and
   * only the last word counts. Readonly projects are outside the collection
   * and stay outside the verdict.
   */
  private foldVerdict(): void {
    if (!this.rootSuite || !this.collection) return;
    const rootDir = this.config?.rootDir ?? '';
    const failOnFlakyTests = this.config?.failOnFlakyTests ?? false;
    const fold = new SessionVerdictFold();
    for (const test of this.rootSuite.allTests()) {
      if (this.readonlyProjects.has(projectNameFromTest(test) ?? '')) continue;
      // Every attempt's time: what the job spent on its tests.
      for (const result of test.results) fold.recordDuration(result.duration);
      const status = finalStatus(test, failOnFlakyTests);
      if (status !== undefined) fold.record(this.testKey(test, rootDir), status);
    }
    this.verdictFold = fold;
  }

  private echo() {
    return this.testSelection ? selectionEcho(this.testSelection) : undefined;
  }

  /**
   * Write what this session concluded to Mergify. Sent exactly when the run
   * asked for a selection -- including when that request failed: the API may
   * be back by now, and the verdict is what the NEXT rerun of this job needs.
   * A run that never asked has no rerun to reduce and sends nothing. Never
   * fails the run.
   */
  private async sendVerdict(): Promise<void> {
    if (!this.collection) return;
    const client = this.client();
    if (!client) return;
    const verdict = buildSessionVerdict({
      testRunId: this.testRunId(),
      attributes: this.attributes(),
      collection: this.collection,
      fold: this.verdictFold,
      selection: this.echo(),
    });
    if (!verdict) return;
    if (envToBool(process.env.MERGIFY_CI_DEBUG, false)) {
      // The same switch that dumps the trace to stderr instead of uploading it.
      process.stderr.write(`[mergify] session verdict ${JSON.stringify(verdict)}\n`);
      this.verdictResult = { sent: true, truncated: false };
      return;
    }
    this.verdictResult = await sendSessionVerdict(client, verdict);
  }

  /**
   * Say what the reduction did, or why it did not happen.
   *
   * Silence is reserved for "we never asked" (feature off, no client,
   * incomplete run identity). Once the run asked, it reports what it made of
   * the answer — including a subset dropped because its names are not all in
   * this collection, which is the case a user most needs to see — and whether
   * its verdict reached Mergify.
   */
  private reportTestSelection(): void {
    if (this.testSelection) {
      process.stderr.write(formatTestSelectionReport(this.testSelection, CLIENT));
      const verdictLine = this.verdictResult && formatSessionVerdictResult(this.verdictResult);
      if (verdictLine) process.stderr.write(verdictLine);
      return;
    }
    // The job opted in and no `preprocess` ran: this Playwright is older than
    // 1.62 and never offered the hook. The suite ran in full, correctly, but
    // the user should know why nothing was reduced.
    if (!this.preprocessCalled && isTestSelectionEnabled() && this.reportingEnabled()) {
      process.stderr.write(
        '[@mergifyio/playwright] this job asked for Mergify Test Selection, but this Playwright does not support ' +
          'Reporter.preprocess() (added in 1.62) — the full test suite ran. Upgrade @playwright/test to reduce reruns.\n'
      );
    }
  }

  /**
   * If any flaky-detection candidates ran, spawn a single subprocess that
   * re-runs them via `--test-list <file> --repeat-each=N`. Records each
   * phase-2 outcome on the detector. Soft-fails on subprocess errors — they
   * are logged but never propagated.
   */
  private async runFlakyDetectionPhase2(flakyDetector: FlakyDetector): Promise<void> {
    if (this.phase1Outcomes.size === 0) return;

    // Compute repeat-each from the average phase-1 duration. Playwright
    // reports 0ms for very fast tests; we fall back to a 1ms floor so the
    // budget math doesn't divide by zero.
    const durations = [...this.phase1Outcomes.values()].map((v) => v.duration);
    const avgDuration =
      durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
    const effectiveDuration = Math.max(1, avgDuration);
    const repeatEach = flakyDetector.computeRepeatBudget(effectiveDuration);
    if (repeatEach < 1) return;

    const cliEntry = this.findPlaywrightBin();
    if (!cliEntry) return;

    const configPath = this.config?.configFile;
    if (!configPath) return;

    // Filenames include pid + random suffix to disambiguate concurrent reporter
    // instances on the same host that share `MERGIFY_TEST_RUN_ID` (e.g. parallel
    // shards). Without it they would clobber the same rerun file.
    const runId = process.env.MERGIFY_TEST_RUN_ID ?? generateTestRunId();
    const suffix = `${runId}-${process.pid}-${randomBytes(4).toString('hex')}`;
    const rerunFile = join(tmpdir(), `mergify-rerun-${suffix}.jsonl`);
    // `--test-list` takes a file with one test ID per line in `--list` format.
    // Our `buildTestKey` output (`<filepath> > <suite> > <title>`) is exactly
    // that format — Playwright accepts `>` and `›` interchangeably. This is
    // exact-match (vs `--grep` which over-matches on leaf title across files).
    const testListFile = join(tmpdir(), `mergify-tests-${suffix}.txt`);
    writeFileSync(testListFile, `${[...this.phase1Outcomes.keys()].join('\n')}\n`);

    const spawnEnv = {
      ...process.env,
      MERGIFY_RERUN_FILE: rerunFile,
    };

    // --retries=0: phase-2 measures raw pass/fail per attempt; built-in
    // retries would mask underlying failures and inflate JSONL entries.
    const timeoutMs = Math.max(
      effectiveDuration * (repeatEach + 1) * this.phase1Outcomes.size + 60_000,
      120_000
    );
    const child = spawnSync(
      process.execPath,
      [
        cliEntry,
        'test',
        '--config',
        configPath,
        '--test-list',
        testListFile,
        `--repeat-each=${repeatEach}`,
        '--retries=0',
      ],
      {
        encoding: 'utf8',
        env: spawnEnv,
        cwd: this.config?.rootDir ?? process.cwd(),
        timeout: timeoutMs,
        // Default is 1 MiB — easy to exceed when the user's own reporter
        // prints a stack trace for every failing rerun. Hitting the cap
        // makes Node SIGTERM the child and set `child.error = ENOBUFS`,
        // which used to make us silently drop the entire verdict. Bump it
        // high enough that real suites don't trip it, and read the JSONL
        // anyway below so partial data still survives if it does.
        maxBuffer: 100 * 1024 * 1024,
      }
    );

    // Parse JSONL outcomes. We read the file regardless of how the
    // subprocess terminated — even a spawn failure (ENOBUFS, ENOENT) or a
    // crash mid-run may have left a partial set of valid lines that
    // beats throwing the whole verdict away. A failure with NO output
    // produced is the only case that warrants a stderr diagnostic.
    let raw: string;
    try {
      raw = readFileSync(rerunFile, 'utf8');
    } catch {
      raw = '';
    }
    const exitedAbnormally = child.error || (child.status !== null && child.status !== 0);
    if (exitedAbnormally && raw.trim().length === 0) {
      const detail = [child.stdout, child.stderr]
        .filter((s) => s && s.trim().length > 0)
        .join('\n')
        .slice(0, 2_000);
      const reason = child.error
        ? `failed: ${String(child.error)}`
        : `exited with status ${child.status} (signal=${child.signal ?? 'none'})`;
      process.stderr.write(
        `[@mergifyio/playwright] flaky-detection rerun subprocess ${reason}` +
          ` and produced no outcomes${detail ? `:\n${detail}` : ''}\n`
      );
    }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as {
          key?: unknown;
          status?: unknown;
        };
        if (typeof parsed.key !== 'string' || typeof parsed.status !== 'string') continue;
        // Skipped attempts don't contribute to the flaky verdict — drop them.
        if (parsed.status === 'passed') flakyDetector.recordOutcome(parsed.key, 'pass');
        else if (parsed.status === 'failed') flakyDetector.recordOutcome(parsed.key, 'fail');
      } catch {
        // skip malformed line
      }
    }
    // Best-effort cleanup of the temp files — leave them on disk if removal
    // fails. The OS will eventually purge tmpdir contents.
    for (const f of [rerunFile, testListFile]) {
      try {
        unlinkSync(f);
      } catch {
        // ignore
      }
    }
  }

  private findPlaywrightBin(): string | undefined {
    // Resolve Playwright's CLI script via the user's installed
    // @playwright/test package. `require.resolve` follows the same module
    // resolution Playwright did when loading our reporter, so we get the
    // exact CLI matching the parent process's Playwright version.
    try {
      const requireFn = createRequire(import.meta.url);
      // The package's `bin` entry points to `cli.js` at the package root.
      const pkgPath = requireFn.resolve('@playwright/test/package.json');
      return join(dirname(pkgPath), 'cli.js');
    } catch {
      return undefined;
    }
  }

  getSession(): TestRunSession | undefined {
    return this.session;
  }

  /** Test hook: what the run collected and what it was told. */
  getTestSelection(): {
    collection: TestCollection | undefined;
    application: TestSelectionApplication | undefined;
    verdict: SessionVerdictResult | undefined;
  } {
    return {
      collection: this.collection,
      application: this.testSelection,
      verdict: this.verdictResult,
    };
  }

  /** Test hook: exposes the flaky-detection candidates the reporter is tracking. */
  getFlakyCandidates(): string[] | undefined {
    return this.flakyDetector ? [...this.flakyDetector.getCandidates()] : undefined;
  }

  getSink() {
    return this.tracing?.sink;
  }
}

export default MergifyReporter;
