import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import {
  createTracing,
  emitTestCaseSpan,
  endSessionSpan,
  envToBool,
  type FlakyDetectionContext,
  FlakyDetector,
  generateTestRunId,
  getRepoName,
  isInCI,
  startSessionSpan,
  type TestCaseResult,
  type TestRunSession,
  type TracingContext,
} from '@mergifyio/ci-core';
import type { Span } from '@opentelemetry/api';
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import * as playwrightResource from './resources/playwright.js';
import { readStateFile } from './state-file.js';
import type { MergifyReporterOptions } from './types.js';
import {
  buildTestKey,
  extractNamespace,
  mapStatus,
  projectNameFromTest,
  toPosix,
} from './utils.js';

const DEFAULT_API_URL = 'https://api.mergify.com';

export class MergifyReporter implements Reporter {
  private options: MergifyReporterOptions;
  private session: TestRunSession | undefined;
  private tracing: TracingContext | null = null;
  private sessionSpan: Span | undefined;
  private config: FullConfig | undefined;
  private quarantineFetchedCount = 0;
  private quarantineFetchedNames: string[] = [];
  private quarantinedCaught: string[] = [];
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

  constructor(options?: MergifyReporterOptions) {
    this.options = options ?? {};
  }

  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig, suite: Suite): void {
    this.config = config;

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

    const envId = process.env.MERGIFY_TEST_RUN_ID;
    const testRunId = envId ?? generateTestRunId();
    const token = this.options.token ?? process.env.MERGIFY_TOKEN;
    const apiUrl = this.options.apiUrl ?? process.env.MERGIFY_API_URL ?? DEFAULT_API_URL;
    const repoName = getRepoName();

    const enabled =
      isInCI() ||
      envToBool(process.env.PLAYWRIGHT_MERGIFY_ENABLE, false) ||
      !!this.options.exporter;

    if (enabled) {
      this.tracing = createTracing({
        token,
        repoName,
        apiUrl,
        testRunId,
        frameworkAttributes: playwrightResource.detect(),
        tracerName: '@mergifyio/playwright',
        exporter: this.options.exporter,
      });
    }

    if (!this.tracing && enabled) {
      if (!token) {
        process.stderr.write(
          '[@mergifyio/playwright] MERGIFY_TOKEN not set, skipping CI Insights reporting\n'
        );
      } else if (!repoName) {
        process.stderr.write(
          '[@mergifyio/playwright] Could not detect repository name, skipping CI Insights reporting\n'
        );
      }
    }

    let flakyContext: FlakyDetectionContext | null = null;
    const statePath = process.env.MERGIFY_STATE_FILE;
    if (statePath) {
      const state = readStateFile(statePath);
      if (state) {
        this.quarantineFetchedCount = state.quarantinedTests.length;
        this.quarantineFetchedNames = state.quarantinedTests;
        if (state.flakyMode) this.flakyMode = state.flakyMode;
        if (state.flakyContext) flakyContext = state.flakyContext;
      }
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
      const allTestNames = suite.allTests().map((tc) => {
        const absolute = tc.location?.file ?? '';
        const filepath = toPosix(config.rootDir ? relative(config.rootDir, absolute) : absolute);
        return buildTestKey(filepath, tc.titlePath(), tc.title);
      });
      this.flakyDetector = new FlakyDetector(flakyContext, this.flakyMode, allTestNames);
    }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const retries = test.retries ?? 0;
    const isFinal =
      result.status === 'passed' || result.status === 'skipped' || result.retry >= retries;
    if (!isFinal) return;

    const rootDir = this.config?.rootDir ?? '';
    const absoluteFilepath = test.location?.file ?? '';
    const filepath = toPosix(rootDir ? relative(rootDir, absoluteFilepath) : absoluteFilepath);

    // Rerun mode: just append a JSONL line and return.
    if (this.rerunFile) {
      const key = buildTestKey(filepath, test.titlePath(), test.title);
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
    const key = buildTestKey(filepath, titlePath, test.title);

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

    const isQuarantined = test.annotations.some((a) => a.type === 'mergify:quarantined');
    if (isQuarantined) {
      testCaseResult.quarantined = true;
      this.quarantinedCaught.push(key);
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
      emitTestCaseSpan(this.tracing.tracer, this.sessionSpan, testCaseResult);
    }
  }

  async onEnd(result: FullResult): Promise<void> {
    // Rerun mode: nothing to do — outcomes were appended in onTestEnd.
    if (this.rerunFile) return;

    if (!this.session) return;

    const reason: 'passed' | 'failed' | 'interrupted' =
      result.status === 'passed'
        ? 'passed'
        : result.status === 'interrupted'
          ? 'interrupted'
          : 'failed';

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
        emitTestCaseSpan(this.tracing.tracer, this.sessionSpan, tcr);
      }
    }

    if (this.quarantineFetchedCount > 0) {
      const unused = this.quarantineFetchedCount - this.quarantinedCaught.length;
      process.stderr.write('[@mergifyio/playwright] Quarantine report:\n');
      process.stderr.write(`  fetched: ${this.quarantineFetchedCount}\n`);
      process.stderr.write(`  caught:  ${this.quarantinedCaught.length}\n`);
      for (const name of this.quarantinedCaught) {
        process.stderr.write(`    - ${name}\n`);
      }
      process.stderr.write(`  unused:  ${unused}\n`);
      if (unused > 0) {
        const caughtSet = new Set(this.quarantinedCaught);
        const unusedNames = this.quarantineFetchedNames.filter((n) => !caughtSet.has(n));
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

  /** Test hook: exposes the flaky-detection candidates the reporter is tracking. */
  getFlakyCandidates(): string[] | undefined {
    return this.flakyDetector ? [...this.flakyDetector.getCandidates()] : undefined;
  }

  getExporter() {
    return this.tracing?.exporter;
  }
}

export default MergifyReporter;
