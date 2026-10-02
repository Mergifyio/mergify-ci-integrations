import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  FlakyDetectionContext,
  FlakyDetectionMode,
  MergifyApiClient,
  SessionSpan,
  SessionVerdictResult,
  TestCaseResult,
  TestCollection,
  TestRunSession,
  TestSelection,
  TestSelectionApplication,
  TestSelectionClientIdentity,
  TracingContext,
} from '@mergifyio/ci-core';
import {
  applyToCollected,
  buildSessionVerdict,
  createApiClient,
  createTracing,
  emitTestCaseSpan,
  endSessionSpan,
  envToBool,
  fallbackRefusalMessage,
  fetchFlakyDetectionContext,
  fetchQuarantineList,
  fetchTestSelection,
  formatSessionVerdictResult,
  formatTestSelectionReport,
  generateTestRunId,
  getRepoName,
  isInCI,
  isTestSelectionEnabled,
  nativeTestCollectionFingerprint,
  resolveBranchFromAttributes,
  resolveSelectionCoordinates,
  SessionVerdictFold,
  SHARD_SLICE_UNAVAILABLE,
  selectionEcho,
  selectionResourceAttributes,
  sendSessionVerdict,
  startSessionSpan,
  TEST_SELECTION_ENABLE_ENV,
  toTestSelection,
} from '@mergifyio/ci-core';
import type { ProvidedContext } from 'vitest';
import type { Reporter, TestCase, TestModule, TestSpecification, Vitest } from 'vitest/node';
import * as vitestResource from './resources/vitest.js';
import {
  collectionIdentity,
  exportsTestRunner,
  finalStatus,
  shardSlice,
} from './test-selection.js';
import type { MergifyApiClientStandIn, MergifyReporterOptions } from './types.js';
import { extractNamespace } from './utils.js';
import { readPluginVersion } from './version.js';

const DEFAULT_API_URL = 'https://api.mergify.com';

/** How the terminal block names this client, in the two sentences that do. */
const CLIENT: TestSelectionClientIdentity = {
  name: '@mergifyio/vitest',
  docsUrl: 'https://docs.mergify.com/ci-insights/test-frameworks/vitest/',
};

export class MergifyReporter implements Reporter {
  private vitest: Vitest | undefined;
  private session: TestRunSession | undefined;
  private tracing: TracingContext | null = null;
  private sessionSpan: SessionSpan | undefined;
  private options: MergifyReporterOptions;
  private _testRunId: string | undefined;
  private quarantineList: Set<string> = new Set();
  private quarantinedCaught: string[] = [];
  private _quarantinePromise: Promise<void> | undefined;
  private flakyContext: FlakyDetectionContext | null = null;
  private flakyMode: FlakyDetectionMode | null = null;
  private flakyResults: Array<{
    name: string;
    rerunCount: number;
    flaky: boolean;
    tooSlow: boolean;
  }> = [];
  private _flakyPromise: Promise<void> | undefined;
  private selection: TestSelection | undefined;
  /** Set in `onInit` when this run may ask for a selection; asked in `onTestRunStart`. */
  private selectionClient: MergifyApiClientStandIn | undefined;
  /** The client the verdict goes through, once the run asked with a fingerprint. */
  private verdictClient: MergifyApiClientStandIn | undefined;
  /** What this leg is about to run, once it asked; the count is filled in at the end. */
  private collection: TestCollection | undefined;
  private application: TestSelectionApplication | undefined;
  private verdictFold = new SessionVerdictFold();
  /** Why the verdict cannot be trusted to name what failed, when it cannot. */
  private verdictWithheld: string | undefined;
  /** The stale-subset guard failed the run, and already said why. */
  private subsetGuardFailed = false;
  private verdictResult: SessionVerdictResult | undefined;
  private deselectedCount = 0;
  private setupInstalled = false;
  private browserProjects = new Set<string>();
  /** Per project: tests that ran, and how many of them the runner extension reached. */
  private projectReach = new Map<
    string,
    { ran: number; extended: number; noFlaky: number; flakyBypassed: number }
  >();
  private selectedExecutedCount = 0;

  constructor(options?: MergifyReporterOptions) {
    this.options = options ?? {};
  }

  onInit(vitest: Vitest): void {
    this.vitest = vitest;
    vitest.config.includeTaskLocation = true;

    const testRunId = generateTestRunId();
    const token = this.options.token ?? process.env.MERGIFY_TOKEN;
    const apiUrl = this.options.apiUrl ?? process.env.MERGIFY_API_URL ?? DEFAULT_API_URL;
    const repoName = getRepoName();

    const enabled =
      isInCI() || envToBool(process.env.VITEST_MERGIFY_ENABLE, false) || !!this.options.sink;

    // One client for the whole run: quarantine, flaky detection, test selection
    // and the trace upload all go through it. Null without a token, a detected
    // repository, or a native binding for this platform — each of which means
    // the backend features stay off.
    const apiClient =
      this.options.apiClient ??
      (token && repoName
        ? createApiClient({
            apiUrl,
            token,
            repoName,
            clientName: '@mergifyio/vitest',
            clientVersion: readPluginVersion(),
          })
        : null);

    if (enabled) {
      this.tracing = createTracing({
        apiClient,
        testRunId,
        frameworkAttributes: vitestResource.detect(vitest.version),
        sink: this.options.sink,
      });
    }

    if (!this.tracing && enabled) {
      if (!token) {
        vitest.logger.log(
          '[@mergifyio/vitest] MERGIFY_TOKEN not set, skipping CI Insights reporting'
        );
      } else if (!repoName) {
        vitest.logger.log(
          '[@mergifyio/vitest] Could not detect repository name, skipping CI Insights reporting'
        );
      }
    }

    this._testRunId = testRunId;

    // If quarantine list was provided via options (for testing), use it directly
    if (this.options.quarantineList) {
      this.quarantineList = new Set(this.options.quarantineList);
      this._configureRunner(vitest);
    } else if (this.tracing && apiClient) {
      const branch = resolveBranchFromAttributes(this.tracing.resourceAttributes);
      if (branch) {
        this._initQuarantine(vitest, apiClient, branch);
      }
    }

    // If a subset was provided via options (for testing), use it directly —
    // through the same normalisation as a served answer, so the seam cannot
    // produce a selection the fetch path never could.
    if (this.options.testSelection) {
      this._applySelection(
        vitest,
        toTestSelection('subset', 'reduced_rerun', this.options.testSelection)
      );
    } else if (this.tracing && apiClient) {
      // Asked in `onTestRunStart`, the first hook that knows which files this
      // run executes: the request carries their fingerprint.
      this.selectionClient = apiClient;
    }

    // If flaky context was provided via options (for testing), use it directly
    if (this.options.flakyContext && this.options.flakyMode) {
      this.flakyContext = this.options.flakyContext;
      this.flakyMode = this.options.flakyMode;
      this._configureFlakyDetection(vitest);
    } else if (this.tracing && apiClient) {
      // Flaky detection is server-driven: always request the context and let
      // the server opt the repository in (200) or out (404). The mode mirrors
      // the pytest/rspec clients — a PR base ref means "new", otherwise
      // "unhealthy".
      const baseRef = this.tracing.resourceAttributes['vcs.ref.base.name'];
      const mode: FlakyDetectionMode =
        typeof baseRef === 'string' && baseRef.length > 0 ? 'new' : 'unhealthy';
      this.flakyMode = mode;
      this._initFlakyDetection(vitest, apiClient, mode);
    }
  }

  private _initQuarantine(vitest: Vitest, client: MergifyApiClient, branch: string): void {
    // Fetch is async but onInit is sync — we use a top-level await workaround
    // by storing the promise and resolving it in onTestRunStart
    const log = (msg: string) => vitest.logger.log(`[@mergifyio/vitest] ${msg}`);
    this._quarantinePromise = fetchQuarantineList(client, branch, log).then((list) => {
      this.quarantineList = list;
      if (list.size > 0) {
        this._configureRunner(vitest);
      }
    });
  }

  /**
   * Ask Mergify what this leg should execute, and hand the answer to the
   * runner before any worker starts.
   *
   * The request carries the fingerprint of the files this leg runs, which is
   * how the engine finds the leg's own predecessor rather than every shard of
   * the job at once. Nothing thrown here reaches Vitest: a failure part-way
   * leaves tests selected, which runs MORE than intended, never fewer.
   */
  private async _selectTests(
    vitest: Vitest,
    client: MergifyApiClientStandIn,
    specifications: ReadonlyArray<TestSpecification>
  ): Promise<void> {
    const fetch = client.fetchTestSelection?.bind(client);
    // An injected stand-in predating this feature has no such method; that
    // reads as "no selection", i.e. run everything.
    if (!fetch || !isTestSelectionEnabled()) return;

    // The selection is keyed on the run's OWN identity — the head branch and
    // revision (a merge-queue draft branch on reruns) plus the job coordinates,
    // the exact values reported with each uploaded test. Without all four there
    // is nothing the server can match, so the full suite runs.
    const coordinates = resolveSelectionCoordinates(this.tracing!.resourceAttributes);
    if (!coordinates) return;

    const log = (msg: string) => vitest.logger.log(`[@mergifyio/vitest] ${msg}`);

    let slice: ReadonlyArray<TestSpecification>;
    try {
      slice = await shardSlice(vitest, specifications);
    } catch (err) {
      log(`could not tell which files this shard runs (${String(err)}); the shard runs unreduced`);
      // Nothing asked, nothing skipped: the leg runs its own share, exactly as
      // it would have without Mergify, and the terminal block says why.
      this.selection = {
        selection: 'full',
        reason: SHARD_SLICE_UNAVAILABLE,
        tests: new Set(),
        served: false,
      };
      return;
    }

    const fingerprint = nativeTestCollectionFingerprint(collectionIdentity(vitest, slice));
    if (fingerprint === null) {
      log('the bundled binding cannot fingerprint the collection; the full suite runs');
      return;
    }
    this.collection = { fingerprint, count: 0 };
    this.verdictClient = client;

    const selection = await fetchTestSelection(
      { fetchTestSelection: fetch },
      coordinates,
      log,
      fingerprint
    );
    this._applySelection(vitest, selection);
  }

  private _applySelection(vitest: Vitest, selection: TestSelection): void {
    this.selection = selection;
    // An answer this client cannot act on runs the whole suite, and says so
    // at the end: a job that opts in must never run less than everything on
    // an answer it does not carry.
    if (selection.notAppliedReason !== undefined) return;

    switch (selection.selection) {
      case 'subset':
        this._provideToRunner(vitest, 'mergify:selection', [...selection.tests], { browser: true });
        this._configureRunner(vitest);
        return;
      case 'empty':
        // Deselecting every test rather than removing the files: Vitest ends a
        // run whose tests are all skipped green, whereas a run left with no
        // file exits 1 ("No test files found").
        this._provideToRunner(vitest, 'mergify:selection', [], { browser: true });
        this._configureRunner(vitest);
        return;
      case 'refused':
        // Deliberately not the degradation path: Mergify holds several
        // candidate predecessors for this job, so one job name stands for
        // several runs and every future attempt would be reported wrong. It
        // has to be seen and fixed, not absorbed into a full run nobody
        // notices. The message is the server's, printed now so it is the first
        // thing in the log; nothing runs, and the run fails in `onTestRunEnd`.
        vitest.logger.error(selection.message ?? fallbackRefusalMessage(CLIENT));
        this._provideToRunner(vitest, 'mergify:selection', [], { browser: true });
        this._configureRunner(vitest);
        return;
    }
  }

  private _initFlakyDetection(
    vitest: Vitest,
    client: MergifyApiClient,
    mode: FlakyDetectionMode
  ): void {
    const log = (msg: string) => vitest.logger.log(`[@mergifyio/vitest] ${msg}`);
    this._flakyPromise = fetchFlakyDetectionContext(client, mode, log).then((ctx) => {
      if (ctx) {
        this.flakyContext = ctx;
        this._configureFlakyDetection(vitest);
      }
    });
  }

  private _configureFlakyDetection(vitest: Vitest): void {
    this._provideToRunner(vitest, 'mergify:flakyContext', this.flakyContext, { browser: false });
    this._provideToRunner(vitest, 'mergify:flakyMode', this.flakyMode, { browser: false });
    this._configureRunner(vitest);
  }

  /**
   * Hand a value to the runner, per project.
   *
   * Vitest serialises a provided value into every test file it runs, and in
   * browser mode it also parses it again in each file's iframe. The
   * flaky-detection context carries every test name of the repository's
   * default branch — tens of thousands of names — and browser projects cannot
   * use it (see `setup-browser.ts`), so it stays out of them (MRGFY-9610). The
   * quarantine list and a served selection are small and do apply there.
   *
   * A root-level `vitest.provide` would reach browser projects anyway, since
   * each project inherits the root's values; providing per project is what
   * keeps them out. In a single-project config the root project is the only
   * entry in `vitest.projects`, so the runner there sees exactly what it did.
   *
   * Vitest 3 still honours the deprecated `poolMatchGlobs` ahead of browser
   * mode, so a browser project can send some of its files to a Node pool. Such
   * a project keeps receiving everything: it pays what it paid before. Vitest 4
   * removed the option.
   */
  private _provideToRunner<K extends keyof ProvidedContext & string>(
    vitest: Vitest,
    key: K,
    value: ProvidedContext[K],
    { browser }: { browser: boolean }
  ): void {
    for (const project of vitest.projects) {
      const config = project.config as typeof project.config & { poolMatchGlobs?: unknown[] };
      if (!browser && config.browser?.enabled && !config.poolMatchGlobs?.length) continue;
      project.provide(key, value);
    }
  }

  private _configureRunner(vitest: Vitest): void {
    this._provideToRunner(vitest, 'mergify:quarantine', [...this.quarantineList], {
      browser: true,
    });
    this._installSetup(vitest);
  }

  /**
   * Add the setup file that extends Vitest's runner to every project.
   *
   * This replaces a custom runner set through `config.runner`, which Vitest
   * honours only for a Node-only root config: browser mode builds its own
   * runner and `projects` never read the root's option, so quarantine, flaky
   * detection and test selection did nothing there, silently. Setup files run
   * in every project, in Node, in the browser and in custom pools alike, and
   * a runner the user configured keeps working underneath.
   *
   * The files are siblings of this module and carry its extension: tsdown
   * emits `index.mjs` next to `setup.mjs` and `index.cjs` next to `setup.cjs`,
   * and under vitest the sources run as `.ts` — deriving the extension is what
   * keeps the pair in step (#87). Which file depends on where it runs and on
   * the Vitest version: the page cannot load ci-core's native binding, and the
   * runner base class moved from `vitest/runners` to `vitest` in 4.1 (5.0
   * removed the old subpath).
   */
  private _installSetup(vitest: Vitest): void {
    const self = typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
    const suffix = exportsTestRunner(vitest.version) ? '' : '-legacy';
    for (const project of vitest.projects) {
      const kind = project.config.browser?.enabled ? 'setup-browser' : 'setup';
      const setup = resolve(dirname(self), `${kind}${suffix}${extname(self)}`);
      const setupFiles = project.config.setupFiles;
      if (!setupFiles.includes(setup)) setupFiles.push(setup);
      if (project.config.browser?.enabled) this.browserProjects.add(project.name);
    }
    this.setupInstalled = true;
  }

  async onTestRunStart(specifications: ReadonlyArray<TestSpecification> = []): Promise<void> {
    // Wait for async initialization to complete
    if (this._quarantinePromise) {
      await this._quarantinePromise;
      this._quarantinePromise = undefined;
    }
    if (this._flakyPromise) {
      await this._flakyPromise;
      this._flakyPromise = undefined;
    }
    const selectionClient = this.selectionClient;
    if (selectionClient && this.vitest) {
      this.selectionClient = undefined;
      try {
        await this._selectTests(this.vitest, selectionClient, specifications);
      } catch (err) {
        this.vitest.logger.log(
          `[@mergifyio/vitest] test selection could not be applied, the full suite runs: ${String(err)}`
        );
      }
    }

    const testRunId = this._testRunId ?? generateTestRunId();

    this.session = {
      testRunId,
      scope: 'session',
      startTime: Date.now(),
      status: 'passed',
      testCases: [],
    };

    if (this.tracing) {
      this.sessionSpan = startSessionSpan(this.tracing, 'vitest session start');
    }
  }

  onTestCaseResult(testCase: TestCase): void {
    if (!this.session) return;

    const meta = testCase.meta() as Record<string, unknown>;

    // A test the selection removed was never executed, so it has no result to
    // report. It arrives here `pending`, which the guard below would drop
    // anyway — but counting it first is what lets the end-of-run report say how
    // much was skipped instead of guessing. Uploading it as "skipped" would
    // feed the server's per-test health statistics a result no run produced.
    if (meta.mergifyDeselected === true) {
      this.deselectedCount++;
      return;
    }

    const result = testCase.result();
    if (result.state === 'pending') return;

    // A type-checked test never goes through a runner, so it says nothing
    // about whether the runner extension reached its project.
    if ((result.state === 'passed' || result.state === 'failed') && meta.typecheck !== true) {
      const project = testCase.project.name;
      const reach = this.projectReach.get(project) ?? {
        ran: 0,
        extended: 0,
        noFlaky: 0,
        flakyBypassed: 0,
      };
      reach.ran++;
      if (meta.mergifyApplied === true) reach.extended++;
      if (meta.mergifyFlakyUnavailable === true) reach.noFlaky++;
      if (meta.mergifyFlakyBypassed === true) reach.flakyBypassed++;
      this.projectReach.set(project, reach);
    }

    // Only a test that actually ran counts: a served test the user's own filter
    // skipped arrives here `skipped`, not `pending`, and reporting it as
    // executed would overstate what the reduced rerun proved.
    if (
      (result.state === 'passed' || result.state === 'failed') &&
      this.selection?.tests.has(testCase.fullName)
    ) {
      this.selectedExecutedCount++;
    }

    const diagnostic = testCase.diagnostic();
    const module = testCase.module;
    const isQuarantined = meta.quarantined === true;

    if (isQuarantined) {
      this.quarantinedCaught.push(testCase.fullName);
    }

    if (meta.flakyDetection === true) {
      this.flakyResults.push({
        name: testCase.fullName,
        rerunCount: (meta.rerunCount as number) ?? 0,
        flaky: meta.flaky === true,
        tooSlow: meta.tooSlow === true,
      });
    }

    const testCaseResult: TestCaseResult = {
      filepath: module.relativeModuleId,
      absoluteFilepath: module.moduleId,
      function: testCase.name,
      lineno: testCase.location?.line ?? 0,
      namespace: extractNamespace(testCase.fullName, testCase.name),
      scope: 'case',
      status: result.state,
      duration: diagnostic?.duration ?? 0,
      startTime: diagnostic?.startTime ?? Date.now(),
      retryCount: diagnostic?.retryCount ?? 0,
      flaky: diagnostic?.flaky ?? false,
    };

    if (isQuarantined) {
      testCaseResult.quarantined = true;
    }

    if (meta.flakyDetection === true) {
      testCaseResult.flakyDetection = {
        new: meta.isNew === true,
        flaky: meta.flaky === true,
        rerunCount: (meta.rerunCount as number) ?? 0,
      };
    }

    if (result.state === 'failed' && result.errors?.length) {
      const firstError = result.errors[0];
      testCaseResult.error = {
        type: firstError.name ?? 'Error',
        message: firstError.message ?? '',
        stacktrace: firstError.stack ?? '',
      };
    }

    this.session.testCases.push(testCaseResult);

    // Create OTel span for this test case
    if (this.tracing && this.sessionSpan) {
      emitTestCaseSpan(this.tracing, this.sessionSpan, testCaseResult);
    }
  }

  async onTestRunEnd(
    testModules: ReadonlyArray<TestModule>,
    unhandledErrors: ReadonlyArray<unknown>,
    reason: 'passed' | 'failed' | 'interrupted'
  ): Promise<void> {
    if (!this.session) return;

    this.session.endTime = Date.now();
    this.session.status = reason;

    this._settleSelection(testModules);
    this._foldVerdict(testModules, unhandledErrors);
    // The verdict first, on purpose: it is what the next merge-queue rerun of
    // this job is answered from, and it must never wait behind the trace
    // upload's timeout and retries.
    await this._sendVerdict();
    this._reportTestSelection();
    this._reportReach();

    // Print quarantine summary
    if (this.quarantineList.size > 0) {
      const logger = this.vitest?.logger;
      logger?.log('');
      logger?.log('[@mergifyio/vitest] Quarantine report:');
      logger?.log(`  Quarantined tests fetched: ${this.quarantineList.size}`);

      if (this.quarantinedCaught.length > 0) {
        logger?.log(
          `  Quarantined tests caught (failures absorbed): ${this.quarantinedCaught.length}`
        );
        for (const name of this.quarantinedCaught) {
          logger?.log(`    - ${name}`);
        }
      }

      const unusedCount = this.quarantineList.size - this.quarantinedCaught.length;
      if (unusedCount > 0) {
        logger?.log(`  Unused quarantine entries: ${unusedCount}`);
      }
    }

    // Print flaky detection summary
    if (this.flakyResults.length > 0 && this.flakyMode) {
      const logger = this.vitest?.logger;
      logger?.log('');
      logger?.log(`[@mergifyio/vitest] Flaky detection report (mode: ${this.flakyMode}):`);
      logger?.log(`  Tests rerun: ${this.flakyResults.length}`);

      const flakyTests = this.flakyResults.filter((r) => r.flaky);
      if (flakyTests.length > 0) {
        logger?.log(`  Flaky tests detected: ${flakyTests.length}`);
        for (const t of flakyTests) {
          logger?.log(`    - ${t.name} (reruns: ${t.rerunCount})`);
        }
      } else {
        logger?.log('  Flaky tests detected: 0');
      }

      const tooSlowTests = this.flakyResults.filter((r) => r.tooSlow);
      if (tooSlowTests.length > 0) {
        logger?.log(`  Tests too slow to rerun: ${tooSlowTests.length}`);
        for (const t of tooSlowTests) {
          logger?.log(`    - ${t.name}`);
        }
      }
    }

    if (this.tracing && this.sessionSpan) {
      try {
        await endSessionSpan(this.tracing, this.sessionSpan, reason);
      } catch (err) {
        this.vitest?.logger.log(`[@mergifyio/vitest] Failed to flush spans: ${err}`);
      }
    }
  }

  /**
   * Say where the features could not apply, instead of letting the quarantine
   * report read as if they had.
   *
   * The runner extension marks every test it reaches, so a project whose tests
   * ran without the mark is one where quarantine and flaky detection did not
   * apply — a custom `runner` that overrides `onBeforeRunTask` without calling
   * `super` does that, and so would a Vitest that stopped building its runners
   * from the base class. Test selection is left out of that message: it is
   * applied per file, by another hook, and still holds in that runner.
   * Flaky detection has three more gaps: browser projects never receive it (its
   * budget needs a native binding a page cannot load), a Node project whose
   * workers cannot load that binding either — the Cloudflare Workers pool runs
   * tests in workerd — marks the tests it could not check, and so does a
   * runner that overrides `onBeforeTryTask` without calling `super`.
   */
  private _reportReach(): void {
    if (!this.setupInstalled) return;
    const logger = this.vitest?.logger;
    const label = (project: string) => (project ? `project "${project}"` : 'this run');

    for (const [project, reach] of this.projectReach) {
      if (reach.ran > 0 && reach.extended === 0) {
        logger?.log(
          `[@mergifyio/vitest] Quarantine and flaky detection did not apply in ${label(project)}: ` +
            `none of its ${reach.ran} test(s) went through Mergify's runner extension. ` +
            'A custom `runner` that overrides `onBeforeRunTask` without calling `super` causes this.'
        );
      }
      if (reach.noFlaky > 0) {
        logger?.log(
          `[@mergifyio/vitest] Flaky detection did not run in ${label(project)}: its tests run where the native ` +
            `binding cannot load (the Cloudflare Workers pool does this), so ${reach.noFlaky} test(s) were not checked.`
        );
      }
      if (reach.flakyBypassed > 0) {
        logger?.log(
          `[@mergifyio/vitest] Flaky detection did not run in ${label(project)}: a custom \`runner\` overrides ` +
            `\`onBeforeTryTask\` without calling \`super\`, so ${reach.flakyBypassed} test(s) were not checked.`
        );
      }
    }

    if (this.flakyContext && this.flakyMode) {
      const skipped = [...this.browserProjects].filter(
        (p) => (this.projectReach.get(p)?.ran ?? 0) > 0
      );
      if (skipped.length > 0) {
        logger?.log(
          `[@mergifyio/vitest] Flaky detection does not run in browser projects yet, so tests in ${skipped
            .map(label)
            .join(', ')} were not checked for flakiness.`
        );
      }
    }
  }

  /**
   * Decide what the run did with Mergify's answer, now that the collection is
   * known, and enforce the rule no reduced rerun may break: a green run must
   * have executed what it believed it would.
   *
   * A served subset matching *nothing* collected here means the identifiers
   * are stale, and the run just skipped everything. That run proves nothing,
   * so it is failed rather than allowed to report green. pytest-mergify and
   * Playwright degrade the same situation to a full run, because they see the
   * whole collection before anything runs; here the tests are only known once
   * the workers are done, so prevention is not available and the guard is a
   * loud failure instead. Under the collection fingerprint the engine only
   * serves a leg the failures of a leg that ran the same files, so the guard
   * is for a defect, not for sharding.
   */
  private _settleSelection(testModules: ReadonlyArray<TestModule>): void {
    const selection = this.selection;
    if (!selection) return;

    // Distinct identities, in collection order: two tests with the same
    // suite and name in different files are one identity to the engine.
    const collected = new Set<string>();
    for (const module of testModules) {
      for (const test of module.children.allTests()) collected.add(test.fullName);
    }
    const ids = [...collected];
    if (this.collection) this.collection.count = ids.length;

    if (selection.selection === 'refused' && selection.notAppliedReason === undefined) {
      this.application = applyToCollected(selection, ids);
      this.session!.status = 'failed';
      process.exitCode = 1;
      return;
    }

    if (selection.selection === 'empty' && selection.notAppliedReason === undefined) {
      this.application = {
        ...applyToCollected(selection, ids),
        deselectedCount: this.deselectedCount,
      };
      return;
    }

    if (selection.selection !== 'subset' || selection.notAppliedReason !== undefined) {
      this.application = applyToCollected(selection, ids);
      return;
    }

    const matched = ids.filter((name) => selection.tests.has(name));
    if (matched.length !== selection.tests.size) {
      // All or nothing, as core's `applyToCollected` rules: a served test
      // missing here was not re-run anywhere, and a green run over the rest
      // would merge the batch without it.
      this.application = applyToCollected(selection, ids);
      this.subsetGuardFailed = true;
      const missing = selection.tests.size - matched.length;
      this.vitest?.logger.error(
        `[@mergifyio/vitest] Failing this run deliberately: Mergify served ${selection.tests.size} test(s) to replay, ` +
          `and ${missing === selection.tests.size ? 'not one' : missing} of them match${missing === 1 ? 'es' : ''} no test collected here, ` +
          'so this run cannot prove what failed before now passes.\n' +
          '  Two things cause this:\n' +
          '    - the tests were renamed since the previous attempt, or their names change from one run to the next;\n' +
          '    - this is one branch of a matrix job whose branches share a job name, and the failures belong to a sibling branch.\n' +
          `  To get a full run instead, unset ${TEST_SELECTION_ENABLE_ENV}.`
      );
      this.session!.status = 'failed';
      process.exitCode = 1;
      return;
    }

    this.application = {
      selection,
      outcome: 'subset',
      keep: new Set(matched),
      keptTests: matched,
      keptCount: matched.length,
      deselectedCount: this.deselectedCount,
    };
  }

  /**
   * Fold every test this run reported to its final status, once the run is
   * over: tests the selection removed are left out, and so are tests that
   * never finished (a cancelled or bailed run), which is what makes such a
   * session read as incomplete and its retry run in full.
   *
   * The verdict is withheld whenever the run failed somewhere no test
   * carries: an unhandled error, a failing hook, a file that did not import.
   * Its tests then read as passed or skipped, and a verdict naming no failure
   * would have the retry run nothing and turn green on the same bug. Without a
   * verdict the retry runs the whole suite, which is always safe.
   */
  private _foldVerdict(
    testModules: ReadonlyArray<TestModule>,
    unhandledErrors: ReadonlyArray<unknown>
  ): void {
    const fold = new SessionVerdictFold();
    let brokenOutsideTests = unhandledErrors.length > 0;
    for (const module of testModules) {
      if (module.errors().length > 0) brokenOutsideTests = true;
      for (const suite of module.children.allSuites()) {
        if (suite.errors().length > 0) brokenOutsideTests = true;
      }
      for (const test of module.children.allTests()) {
        const meta = test.meta() as Record<string, unknown>;
        if (meta.mergifyDeselected === true) continue;
        const state = test.result().state;
        if (state === 'pending') continue;
        fold.recordDuration(test.diagnostic()?.duration ?? 0);
        fold.record(test.fullName, finalStatus(state, meta));
      }
    }
    this.verdictFold = fold;
    if (brokenOutsideTests) this.verdictWithheld = 'it failed outside any test';
  }

  private _echo() {
    return this.application ? selectionEcho(this.application) : undefined;
  }

  /**
   * Write what this session concluded to Mergify, and put the collection and
   * the answer on the trace resource. Sent exactly when the run asked with a
   * fingerprint -- including when that request failed: the API may be back by
   * now, and the verdict is what the NEXT rerun of this job needs. Never fails
   * the run.
   */
  private async _sendVerdict(): Promise<void> {
    const collection = this.collection;
    if (!collection || !this.tracing) return;

    Object.assign(
      this.tracing.resourceAttributes,
      selectionResourceAttributes(collection, this._echo())
    );

    const client = this.verdictClient;
    if (!client || this.verdictWithheld) return;
    const verdict = buildSessionVerdict({
      testRunId: this._testRunId!,
      attributes: this.tracing.resourceAttributes,
      collection,
      fold: this.verdictFold,
      selection: this._echo(),
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
   * Say what the reduction did, or why it did not happen. Silence is reserved
   * for "we never asked"; a failed stale subset has already said everything
   * in its own error.
   */
  private _reportTestSelection(): void {
    const application = this.application;
    if (!application) return;
    const logger = this.vitest?.logger;
    if (!this.subsetGuardFailed) {
      logger?.log('');
      logger?.log(formatTestSelectionReport(application, CLIENT).trimEnd());
    }
    if (this.verdictWithheld && this.collection) {
      logger?.log(
        `Mergify wasn't sent this run's results: ${this.verdictWithheld}. If this merge-queue batch is retried, this job will run its full test suite.`
      );
    }
    const verdictLine = this.verdictResult && formatSessionVerdictResult(this.verdictResult);
    if (verdictLine) logger?.log(verdictLine.trimEnd());
  }

  getSession(): TestRunSession | undefined {
    return this.session;
  }

  /** The resolved selection, how many tests it removed, and how many ran. */
  getSelection(): {
    selection: TestSelection | undefined;
    deselectedCount: number;
    executedCount: number;
  } {
    return {
      selection: this.selection,
      deselectedCount: this.deselectedCount,
      executedCount: this.selectedExecutedCount,
    };
  }

  getSink() {
    return this.tracing?.sink;
  }
}
