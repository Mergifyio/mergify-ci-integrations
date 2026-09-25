import type { FlakyDetectionContext, FlakyDetectionMode } from '@mergifyio/ci-core';
import type { File, Suite, Task } from '@vitest/runner';
import { inject, type TestRunner } from 'vitest';
import { buildTestKey } from './utils.js';

/**
 * The class every Vitest runner is built from — the Node one, the browser
 * tester's, the Cloudflare Workers pool's. Vitest 4.1 exports it from `vitest`
 * as `TestRunner`; earlier versions only from `vitest/runners`, as
 * `VitestTestRunner`. It is one class under two names.
 */
export type RunnerBase = typeof TestRunner;

/** The part of ci-core's `FlakyDetector` this module drives. */
export interface FlakyDetectorLike {
  isCandidate(testName: string): boolean;
  getMaxRepeats(testName: string, initialDurationMs: number): number;
  recordOutcome(testName: string, outcome: 'pass' | 'fail'): void;
  getRerunCount(testName: string): number;
  isFlaky(testName: string): boolean;
  isTooSlow(testName: string): boolean;
}

/**
 * Flaky detection's rerun budget comes from the native binding, which only a
 * Node process can load. Browser projects get no engine at all; a Node process
 * that could not load the binding (the Cloudflare Workers pool runs tests in
 * workerd) says so through `available`.
 */
export interface FlakyEngine {
  available(): boolean;
  create(
    context: FlakyDetectionContext,
    mode: FlakyDetectionMode,
    testNames: string[]
  ): FlakyDetectorLike;
}

/** One repeat's outcome is its last try's; a try failed if it added errors. */
interface TryState {
  started: boolean;
  errorsAtTryStart: number;
  lastTryFailed: boolean;
  /** Each repeat's outcome, in order: the first is the run's own attempt. */
  outcomes: Array<'pass' | 'fail'>;
}

const PATCHED = Symbol.for('@mergifyio/vitest:runner-extended');
const INSTANCE_PATCHED = Symbol.for('@mergifyio/vitest:runner-instance-extended');

/**
 * Give the runner Vitest builds, whatever it is, the behaviour the reporter
 * promises: absorb quarantined failures, rerun new or unhealthy tests, skip
 * what a served test selection leaves out.
 *
 * This used to be a custom runner installed through `config.runner`. Vitest
 * honours that option only for a Node-only root config: browser mode builds
 * its own runner, and `projects` never read the root's option, so the three
 * features did nothing there without a word. A setup file runs in every
 * project, so the reporter injects one that calls this, and it extends the
 * class the running runner already derives from.
 *
 * Vitest keeps driving the lifecycle — `fails` inversion, retries, hooks,
 * `aroundEach` — and the only verdict rewritten here is the one the custom
 * runner rewrote, at the same point: after the run of the task, in
 * `onAfterRunTask`. Reimplementing the features with test hooks instead was
 * tried and lost verdicts (an `aroundEach` error turned green, a quarantined
 * `it.fails` turned red).
 *
 * Idempotent: the prototype and each runner instance are extended once, even
 * when the setup file is evaluated for every test file.
 */
export function extendRunner(Base: RunnerBase, flakyEngine: FlakyEngine | null): void {
  const proto = Base.prototype as unknown as Record<PropertyKey, unknown> & RunnerHooks;
  if (proto[PATCHED]) return;
  proto[PATCHED] = true;

  const detectors = new WeakMap<File, FlakyDetectorLike | null>();
  const tries = new WeakMap<Task, TryState>();

  const baseBeforeRunSuite = proto.onBeforeRunSuite;
  const baseBeforeRunTask = proto.onBeforeRunTask;
  const baseBeforeTryTask = proto.onBeforeTryTask;

  /**
   * Drop every collected test outside the served subset, before any hook of
   * the file runs — the point the custom runner reached through
   * `onCollected`, which Vitest's worker and the browser tester both wrap on
   * the instance. Collection has applied the user's own filters by then, and
   * this only assigns `skip`, so it can shrink their selection but never widen
   * it.
   */
  proto.onBeforeRunSuite = async function (this: RunnerHooks, suite: Suite) {
    await baseBeforeRunSuite?.call(this, suite);
    const selection = readSelection();
    if (selection && isFile(suite)) deselectOutsideSubset(suite, selection);
  };

  proto.onBeforeRunTask = async function (this: RunnerHooks, test: Task) {
    extendInstance(this);
    await baseBeforeRunTask?.call(this, test);
    if (test.type !== 'test') return;

    const meta = test.meta as Record<string, unknown>;
    meta.mergifyApplied = true;

    // A test in a suite whose own hooks failed never reaches the file walk's
    // result, so the subset is checked again here.
    const selection = readSelection();
    if (selection && !selection.has(buildTestKey(test))) {
      deselect(test);
      return;
    }

    const flaky = readFlaky();
    if (!flaky || !test.file) return;
    if (!flakyEngine?.available()) {
      meta.mergifyFlakyUnavailable = true;
      return;
    }
    let detector = detectors.get(test.file);
    if (detector === undefined) {
      detector = flakyEngine.create(flaky.context, flaky.mode, collectTestNames(test.file));
      detectors.set(test.file, detector);
    }
    const name = buildTestKey(test);
    if (!detector?.isCandidate(name)) return;
    // Vitest reads `repeats` once, right after this hook, so the final count
    // has to be set here, from the estimated duration.
    const repeats = detector.getMaxRepeats(name, flaky.context.existing_tests_mean_duration_ms);
    (test as { repeats?: number }).repeats = repeats;
    tries.set(test, { started: false, errorsAtTryStart: 0, lastTryFailed: false, outcomes: [] });
  };

  /**
   * Close the previous try when the next one starts. Errors an `aroundEach`
   * adds after a try are still counted, because they land before the next try
   * begins. Vitest does not reset a test's state between repeats, so the state
   * itself cannot tell one repeat's outcome from another's.
   */
  proto.onBeforeTryTask = async function (
    this: RunnerHooks,
    test: Task,
    options?: { retry: number; repeats: number }
  ) {
    await baseBeforeTryTask?.call(this, test, options);
    const state = tries.get(test);
    if (!state) return;
    if (state.started) {
      closeTry(test, state);
      // A retry replaces the try before it; only the last try of a repeat is
      // that repeat's outcome.
      if ((options?.retry ?? 0) === 0) recordRepeat(test, state);
    } else {
      state.errorsAtTryStart = test.result?.errors?.length ?? 0;
    }
    state.started = true;
  };

  /**
   * Vitest's worker replaces `onAfterRunTask` on each runner instance when it
   * builds it, so a prototype method is never called for it. The instance's
   * own is wrapped instead, once, the first time the instance shows up.
   */
  function extendInstance(runner: RunnerHooks): void {
    if (Object.prototype.hasOwnProperty.call(runner, INSTANCE_PATCHED)) return;
    Object.defineProperty(runner, INSTANCE_PATCHED, { value: true });
    const current = runner.onAfterRunTask;
    runner.onAfterRunTask = async function (this: RunnerHooks, test: Task) {
      await current?.call(this, test);
      afterRunTask(test);
    };
  }

  function recordRepeat(test: Task, state: TryState): void {
    const outcome = state.lastTryFailed ? 'fail' : 'pass';
    state.outcomes.push(outcome);
    const detector = test.file ? detectors.get(test.file) : null;
    detector?.recordOutcome(buildTestKey(test), outcome);
  }

  function afterRunTask(test: Task): void {
    if (test.type !== 'test') return;
    const name = buildTestKey(test);
    const meta = test.meta as Record<string, unknown>;
    const originalState = test.result?.state;

    const state = tries.get(test);
    const detector = test.file ? detectors.get(test.file) : null;
    if (state && !state.started) {
      // No try was ever seen: a custom runner overrides `onBeforeTryTask`
      // without calling `super`. With no outcome recorded there is nothing to
      // judge flakiness by, so the test is reported as not checked rather
      // than as checked and stable.
      meta.mergifyFlakyBypassed = true;
    } else if (state && detector) {
      closeTry(test, state);
      recordRepeat(test, state);
      const flaky = readFlaky();
      meta.flakyDetection = true;
      meta.isNew = flaky?.mode === 'new';
      meta.rerunCount = detector.getRerunCount(name);
      meta.flaky = detector.isFlaky(name);
      meta.tooSlow = detector.isTooSlow(name);

      // In "unhealthy" mode the reruns only learn: the test's own first
      // attempt decides, as in pytest-mergify and rspec-mergify. A failure on a
      // later repeat is absorbed; a failing first attempt still fails. (In
      // "new" mode any failure fails the test, so a new flaky test cannot be
      // merged — Vitest's own verdict already says that.)
      if (flaky?.mode === 'unhealthy' && originalState === 'fail' && state.outcomes[0] === 'pass') {
        test.result!.state = 'pass';
        test.result!.errors = undefined;
        meta.absorbedFailure = true;
      }
    }

    if (originalState === 'fail' && readQuarantine().has(name)) {
      test.result!.state = 'pass';
      meta.quarantined = true;
      meta.quarantineErrors = test.result!.errors;
      test.result!.errors = undefined;
    }
  }
}

/**
 * The runner members this module touches. Declared here rather than taken from
 * `TestRunner`, whose typing differs across the Vitest majors this package
 * supports.
 */
interface RunnerHooks {
  onBeforeRunSuite?(suite: Suite): unknown;
  onBeforeRunTask?(test: Task): unknown;
  onBeforeTryTask?(test: Task, options?: { retry: number; repeats: number }): unknown;
  onAfterRunTask?(test: Task): unknown;
}

function closeTry(test: Task, state: TryState): void {
  const errors = test.result?.errors?.length ?? 0;
  state.lastTryFailed = errors > state.errorsAtTryStart;
  state.errorsAtTryStart = errors;
}

// Read at call time rather than once: the browser tester keeps one runner for
// every file of a project, and each project is provided its own values.
function readQuarantine(): Set<string> {
  return new Set(inject('mergify:quarantine') ?? []);
}

/** Absent means "run everything": only a genuine `subset` answer is provided. */
function readSelection(): Set<string> | null {
  const selection = inject('mergify:selection') as string[] | undefined;
  return selection ? new Set(selection) : null;
}

function readFlaky(): { context: FlakyDetectionContext; mode: FlakyDetectionMode } | null {
  const context = inject('mergify:flakyContext');
  const mode = inject('mergify:flakyMode');
  return context && mode ? { context, mode } : null;
}

function isFile(suite: Suite): suite is File {
  return 'filepath' in suite;
}

function deselectOutsideSubset(suite: Suite, selection: Set<string>): void {
  for (const task of suite.tasks) {
    if (task.type === 'suite') {
      deselectOutsideSubset(task, selection);
    } else if (!selection.has(buildTestKey(task))) {
      // A test the user already skipped (`it.skip`, `it.todo`, a name filter)
      // is deselected too: it stays skipped, and is left out of the report
      // like every other test outside the subset. Reported as skipped, it
      // would count as executed, and an `empty` run would tell Mergify it ran
      // tests when it ran none.
      deselect(task);
    }
  }
}

function deselect(task: Task): void {
  if (task.mode === 'run') {
    task.mode = 'skip';
    // Vitest's main process received this test at collection, as `run`, and
    // only its result travels back from here: without a `skip` result, Vitest's
    // own summary counts the test in its total and nowhere else.
    task.result ??= { state: 'skip' };
  }
  (task.meta as Record<string, unknown>).mergifyDeselected = true;
}

function collectTestNames(suite: Suite): string[] {
  const names: string[] = [];
  for (const task of suite.tasks) {
    if (task.type === 'test') names.push(buildTestKey(task));
    else if (task.type === 'suite') names.push(...collectTestNames(task));
  }
  return names;
}
